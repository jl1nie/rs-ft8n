use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

const TARGET_RATE: u32 = 12000;
const PERIOD_SECS: usize = 15;
const BUFFER_SIZE: usize = TARGET_RATE as usize * PERIOD_SECS; // 180 000

/// Audio device info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub index: usize,
    pub channels: u16,
    pub native_sample_rate: u32,
}

/// Shared audio state.
/// cpal::Stream is !Send+!Sync on Windows/WASAPI — both streams are owned
/// by dedicated threads; communication is via stop-channels.
pub struct AudioState {
    // ── Input ─────────────────────────────────────────────────────────
    pub snapshot_buf: Arc<Mutex<Vec<f32>>>,
    pub write_pos: Arc<Mutex<usize>>,
    pub buffer_full: Arc<AtomicBool>,
    pub recording: Arc<AtomicBool>,
    pub peak_level: Arc<Mutex<f32>>,
    /// Software gain multiplier applied before decimation (default 1.0).
    /// Range 0.0–100.0; set via audio_set_gain.
    pub gain: Arc<Mutex<f32>>,
    stop_tx: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,

    // ── Output ────────────────────────────────────────────────────────
    pub play_done: Arc<AtomicBool>,
    play_stop_tx: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,
}

impl AudioState {
    pub fn new() -> Self {
        Self {
            snapshot_buf: Arc::new(Mutex::new(vec![0.0f32; BUFFER_SIZE])),
            write_pos: Arc::new(Mutex::new(0)),
            buffer_full: Arc::new(AtomicBool::new(false)),
            recording: Arc::new(AtomicBool::new(false)),
            peak_level: Arc::new(Mutex::new(0.0)),
            gain: Arc::new(Mutex::new(1.0)),
            stop_tx: Mutex::new(None),
            play_done: Arc::new(AtomicBool::new(true)),
            play_stop_tx: Mutex::new(None),
        }
    }

    pub fn take_snapshot(&self) -> (Vec<f32>, u32) {
        let mut pos = self.write_pos.lock().unwrap();
        let buf = self.snapshot_buf.lock().unwrap();
        let samples = buf[..*pos].to_vec();
        *pos = 0;
        self.buffer_full.store(false, Ordering::Relaxed);
        (samples, TARGET_RATE)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Device enumeration
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub fn audio_list_devices() -> Vec<AudioDeviceInfo> {
    let host = cpal::default_host();
    let mut out = Vec::new();
    if let Ok(devs) = host.input_devices() {
        for (i, dev) in devs.enumerate() {
            let name = dev.name().unwrap_or_else(|_| format!("Device {}", i));
            let (channels, native_sample_rate) = dev
                .default_input_config()
                .map(|c| (c.channels(), c.sample_rate().0))
                .unwrap_or((2, 48000));
            out.push(AudioDeviceInfo { name, index: i, channels, native_sample_rate });
        }
    }
    out
}

#[tauri::command]
pub fn audio_list_output_devices() -> Vec<AudioDeviceInfo> {
    let host = cpal::default_host();
    let mut out = Vec::new();
    if let Ok(devs) = host.output_devices() {
        for (i, dev) in devs.enumerate() {
            let name = dev.name().unwrap_or_else(|_| format!("Device {}", i));
            let (channels, native_sample_rate) = dev
                .default_output_config()
                .map(|c| (c.channels(), c.sample_rate().0))
                .unwrap_or((2, 48000));
            out.push(AudioDeviceInfo { name, index: i, channels, native_sample_rate });
        }
    }
    out
}

// ═══════════════════════════════════════════════════════════════════════════
// Input capture
// ═══════════════════════════════════════════════════════════════════════════

/// Start audio capture from the specified input device.
///
/// Uses the device's **native** channels and sample rate to avoid any
/// WASAPI format-negotiation failures.  Stereo → mono is done by taking
/// channel-0 (left) only — no averaging, no level loss.
/// Decimation ratio is derived from the native rate dynamically.
///
/// Returns a human-readable status string on success, Err on failure.
#[tauri::command]
pub fn audio_start(
    state: tauri::State<'_, AudioState>,
    device_index: usize,
) -> Result<String, String> {
    let host = cpal::default_host();
    let device = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .nth(device_index)
        .ok_or_else(|| "Input device not found".to_string())?;

    // Use the device's own default config — guaranteed to succeed in WASAPI.
    let def = device.default_input_config().map_err(|e| e.to_string())?;
    let native_channels = def.channels() as usize;
    let native_rate = def.sample_rate().0;

    // Warn if the rate doesn't divide evenly; decimation will be approximate.
    if native_rate % TARGET_RATE != 0 {
        log::warn!(
            "Native rate {} Hz is not an exact multiple of {} Hz; \
             decimation will be approximate",
            native_rate, TARGET_RATE
        );
    }
    let decim_ratio = (native_rate / TARGET_RATE).max(1) as usize;

    let config = cpal::StreamConfig {
        channels: native_channels as u16,
        sample_rate: cpal::SampleRate(native_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    let device_name = device.name().unwrap_or_default();

    let snapshot_buf = state.snapshot_buf.clone();
    let write_pos   = state.write_pos.clone();
    let buffer_full = state.buffer_full.clone();
    let recording   = state.recording.clone();
    let peak_level  = state.peak_level.clone();
    let gain        = state.gain.clone();

    state.recording.store(true, Ordering::Relaxed);
    *state.write_pos.lock().unwrap() = 0;
    state.buffer_full.store(false, Ordering::Relaxed);
    *state.stop_tx.lock().unwrap() = None; // stop previous stream

    let (result_tx, result_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    let (stop_tx, stop_rx)     = std::sync::mpsc::sync_channel::<()>(0);
    *state.stop_tx.lock().unwrap() = Some(stop_tx);

    std::thread::spawn(move || {
        let mut decim_accum: f32 = 0.0;
        let mut decim_count: usize = 0;

        let stream_result = device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !recording.load(Ordering::Relaxed) {
                    return;
                }

                let gain_val = *gain.lock().unwrap();

                // Number of complete frames in this callback
                let frame_count = if native_channels > 0 {
                    data.len() / native_channels
                } else {
                    data.len()
                };

                let mut peak = 0.0f32;
                let mut buf = snapshot_buf.lock().unwrap();
                let mut pos = write_pos.lock().unwrap();

                for frame_idx in 0..frame_count {
                    // Take left (channel-0) sample only — avoids -6 dB penalty
                    // of averaging when the signal is on one channel only.
                    let raw = data[frame_idx * native_channels];
                    let s = raw * gain_val;

                    let abs = s.abs();
                    if abs > peak {
                        peak = abs;
                    }

                    // Boxcar decimation native_rate → TARGET_RATE
                    decim_accum += s;
                    decim_count += 1;
                    if decim_count >= decim_ratio {
                        let avg = decim_accum / decim_ratio as f32;
                        decim_accum = 0.0;
                        decim_count = 0;

                        if *pos < BUFFER_SIZE {
                            buf[*pos] = avg;
                            *pos += 1;
                        }
                        if *pos >= BUFFER_SIZE {
                            buffer_full.store(true, Ordering::Relaxed);
                        }
                    }
                }

                if let Ok(mut p) = peak_level.lock() {
                    if peak > *p {
                        *p = peak;
                    }
                }
            },
            |err| log::error!("Audio input error: {}", err),
            None,
        );

        match stream_result {
            Ok(s) => match s.play() {
                Ok(()) => {
                    result_tx.send(Ok(())).ok();
                    let _ = stop_rx.recv();
                }
                Err(e) => {
                    result_tx.send(Err(format!("play() failed: {}", e))).ok();
                }
            },
            Err(e) => {
                result_tx.send(Err(format!(
                    "build_input_stream failed (ch={} rate={}): {}",
                    native_channels, native_rate, e
                ))).ok();
            }
        }
    });

    match result_rx.recv() {
        Ok(Ok(())) => {
            let info = format!(
                "Input: \"{}\" ch={} @ {} Hz  decim×{}→{} Hz",
                device_name, native_channels, native_rate, decim_ratio, TARGET_RATE
            );
            log::info!("{}", info);
            Ok(info)
        }
        Ok(Err(e)) => {
            state.recording.store(false, Ordering::Relaxed);
            Err(e)
        }
        Err(_) => {
            state.recording.store(false, Ordering::Relaxed);
            Err("Audio input thread crashed before stream opened".to_string())
        }
    }
}

#[tauri::command]
pub fn audio_stop(state: tauri::State<'_, AudioState>) -> Result<(), String> {
    state.recording.store(false, Ordering::Relaxed);
    *state.stop_tx.lock().unwrap() = None;
    log::info!("Audio input stopped");
    Ok(())
}

#[tauri::command]
pub fn audio_get_peak(state: tauri::State<'_, AudioState>) -> f32 {
    let mut p = state.peak_level.lock().unwrap();
    let val = *p;
    *p = 0.0;
    val
}

#[tauri::command]
pub fn audio_buffer_ready(state: tauri::State<'_, AudioState>) -> bool {
    state.buffer_full.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn audio_get_snapshot(state: tauri::State<'_, AudioState>) -> (Vec<f32>, u32) {
    state.take_snapshot()
}

/// Set software input gain (0.0–100.0; 1.0 = unity).
/// Values above 1.0 amplify a quiet hardware input before decimation.
#[tauri::command]
pub fn audio_set_gain(state: tauri::State<'_, AudioState>, gain: f32) {
    let clamped = gain.clamp(0.0, 100.0);
    *state.gain.lock().unwrap() = clamped;
    log::info!("Input gain → {:.2}×", clamped);
}

// ═══════════════════════════════════════════════════════════════════════════
// Output playback
// ═══════════════════════════════════════════════════════════════════════════

/// Play a 12 kHz f32 mono PCM waveform (from encode_ft8) through an output device.
/// Upsamples to the device's native rate with linear interpolation and
/// duplicates mono to all native channels.  Returns immediately; poll
/// audio_play_done() to detect completion.
#[tauri::command]
pub fn audio_play_start(
    state: tauri::State<'_, AudioState>,
    samples: Vec<f32>,
    device_index: usize,
    gain: f32,
) -> Result<String, String> {
    let host = cpal::default_host();
    let device = host
        .output_devices()
        .map_err(|e| e.to_string())?
        .nth(device_index)
        .ok_or_else(|| "Output device not found".to_string())?;

    let def = device.default_output_config().map_err(|e| e.to_string())?;
    let native_channels = def.channels() as usize;
    let native_rate     = def.sample_rate().0;

    let config = cpal::StreamConfig {
        channels: native_channels as u16,
        sample_rate: cpal::SampleRate(native_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    let device_name = device.name().unwrap_or_default();
    let gain = gain.clamp(0.0, 100.0);
    let upsample_ratio = (native_rate / TARGET_RATE).max(1) as usize;

    // Linear interpolation upsample: TARGET_RATE → native_rate
    // then interleave to native_channels (duplicate mono to all channels)
    let n_in = samples.len();
    let mut interleaved: Vec<f32> =
        Vec::with_capacity(n_in * upsample_ratio * native_channels);
    for i in 0..n_in {
        let s0 = samples[i] * gain;
        let s1 = if i + 1 < n_in { samples[i + 1] * gain } else { 0.0 };
        for j in 0..upsample_ratio {
            let t = j as f32 / upsample_ratio as f32;
            let s = s0 + (s1 - s0) * t;
            for _ in 0..native_channels {
                interleaved.push(s);
            }
        }
    }

    let total_samples = interleaved.len();
    let buf     = Arc::new(Mutex::new(interleaved));
    let play_pos = Arc::new(Mutex::new(0usize));
    let buf_cb  = buf.clone();
    let pos_cb  = play_pos.clone();

    state.play_done.store(false, Ordering::Relaxed);
    *state.play_stop_tx.lock().unwrap() = None; // abort previous if any

    let (result_tx, result_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    let (stop_tx, stop_rx)     = std::sync::mpsc::sync_channel::<()>(0);
    *state.play_stop_tx.lock().unwrap() = Some(stop_tx);

    let play_done_cb = state.play_done.clone();

    std::thread::spawn(move || {
        let stream_result = device.build_output_stream(
            &config,
            move |output: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let buf = buf_cb.lock().unwrap();
                let mut pos = pos_cb.lock().unwrap();
                for s in output.iter_mut() {
                    *s = if *pos < total_samples {
                        let v = buf[*pos];
                        *pos += 1;
                        v
                    } else {
                        0.0
                    };
                }
                if *pos >= total_samples {
                    play_done_cb.store(true, Ordering::Relaxed);
                }
            },
            |err| log::error!("Audio output error: {}", err),
            None,
        );

        match stream_result {
            Ok(s) => match s.play() {
                Ok(()) => {
                    result_tx.send(Ok(())).ok();
                    let _ = stop_rx.recv();
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                Err(e) => {
                    result_tx.send(Err(format!("play() failed: {}", e))).ok();
                }
            },
            Err(e) => {
                result_tx.send(Err(format!(
                    "build_output_stream failed (ch={} rate={}): {}",
                    native_channels, native_rate, e
                ))).ok();
            }
        }
    });

    // Auto-stop watcher: once play_done fires, release the stop sender.
    let play_done_watch = state.play_done.clone();
    // Take the sender out so the watcher is the sole owner.
    let owned_stop_tx = state.play_stop_tx.lock().unwrap().take();
    std::thread::spawn(move || {
        loop {
            if play_done_watch.load(Ordering::Relaxed) {
                drop(owned_stop_tx); // releases the audio thread
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    });

    match result_rx.recv() {
        Ok(Ok(())) => {
            let info = format!(
                "Output: \"{}\" ch={} @ {} Hz  up×{}  gain={:.2}",
                device_name, native_channels, native_rate, upsample_ratio, gain
            );
            log::info!("{}", info);
            Ok(info)
        }
        Ok(Err(e)) => {
            state.play_done.store(true, Ordering::Relaxed);
            Err(e)
        }
        Err(_) => {
            state.play_done.store(true, Ordering::Relaxed);
            Err("Output audio thread crashed".to_string())
        }
    }
}

#[tauri::command]
pub fn audio_play_stop(state: tauri::State<'_, AudioState>) -> Result<(), String> {
    state.play_done.store(true, Ordering::Relaxed);
    *state.play_stop_tx.lock().unwrap() = None;
    log::info!("Audio output stopped");
    Ok(())
}

#[tauri::command]
pub fn audio_play_done(state: tauri::State<'_, AudioState>) -> bool {
    state.play_done.load(Ordering::Relaxed)
}

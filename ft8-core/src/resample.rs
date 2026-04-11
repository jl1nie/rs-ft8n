/// Linear-interpolation resampler: arbitrary input rate → 12 000 Hz.
///
/// Used at the decode entry point so the rest of the pipeline can
/// assume a fixed 12 000 Hz sample rate.

const TARGET_RATE: f64 = 12_000.0;

/// Resample `samples` from `src_rate` Hz to 12 000 Hz using linear interpolation.
///
/// Returns the resampled buffer.  If `src_rate` is already 12 000, the
/// input is returned as-is (zero-copy via `Cow` semantics at the call site).
pub fn resample_to_12k(samples: &[i16], src_rate: u32) -> Vec<i16> {
    let ratio = TARGET_RATE / src_rate as f64;
    let out_len = (samples.len() as f64 * ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);

    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;

        if idx + 1 < samples.len() {
            let a = samples[idx] as f64;
            let b = samples[idx + 1] as f64;
            let v = a + (b - a) * frac;
            out.push(v.round() as i16);
        } else if idx < samples.len() {
            out.push(samples[idx]);
        }
    }

    out
}

/// f32 → 12 000 Hz i16 in a single pass (linear interpolation + scaling).
///
/// Used by the WASM live-capture path so the JS side can hand a Float32Array
/// straight from the AudioWorklet without an intermediate i16 conversion loop.
///
/// **Normalization:** before resampling the input is peak-normalised to
/// `TARGET_PEAK` (0.8 full-scale).  This ensures the full i16 dynamic range
/// is used regardless of the hardware input level — a common problem with USB
/// radio audio adapters whose Windows volume setting may be very low.
/// Signal-to-noise ratio is preserved because signal and noise are scaled
/// equally.  Buffers whose peak is below `SILENCE_FLOOR` are treated as
/// silence and left at 0.
///
/// If `src_rate == 12000`, this still allocates and converts (no zero-copy)
/// because the output is i16 and the input is f32.
pub fn resample_f32_to_12k(samples: &[f32], src_rate: u32) -> Vec<i16> {
    const TARGET_PEAK: f64 = 0.8;
    const SILENCE_FLOOR: f64 = 1e-6;

    // Find peak amplitude
    let peak = samples.iter().fold(0.0f64, |m, &s| m.max((s as f64).abs()));
    let scale = if peak > SILENCE_FLOOR { TARGET_PEAK / peak } else { 1.0 };

    let ratio = TARGET_RATE / src_rate as f64;
    let out_len = (samples.len() as f64 * ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);

    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;

        let v = if idx + 1 < samples.len() {
            let a = samples[idx] as f64;
            let b = samples[idx + 1] as f64;
            a + (b - a) * frac
        } else if idx < samples.len() {
            samples[idx] as f64
        } else {
            continue;
        };

        let scaled = (v * scale * 32767.0).clamp(-32768.0, 32767.0);
        out.push(scaled.round() as i16);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_at_12k() {
        let input: Vec<i16> = (0..100).collect();
        let out = resample_to_12k(&input, 12000);
        assert_eq!(out.len(), 100);
        assert_eq!(out, input);
    }

    #[test]
    fn downsample_from_48k() {
        // 48000 → 12000 = factor 4
        let input: Vec<i16> = (0..4800).map(|i| (i % 100) as i16).collect();
        let out = resample_to_12k(&input, 48000);
        assert_eq!(out.len(), 1200);
    }

    #[test]
    fn downsample_from_44100() {
        // 44100 → 12000: non-integer ratio
        let input: Vec<i16> = vec![0i16; 44100];
        let out = resample_to_12k(&input, 44100);
        // Should be close to 12000 samples for 1 second
        assert!((out.len() as i32 - 12000).abs() <= 1);
    }

    /// Helper: generate a 12 kHz FT8 frame with signal + AWGN noise.
    fn make_noisy_frame(msg: &[u8; 77], freq: f32, snr_db: f32) -> Vec<i16> {
        use crate::params::{MSG_BITS, NMAX};
        use crate::wave_gen::{message_to_tones, tones_to_f32};

        let _ = MSG_BITS; // suppress unused warning
        let itone = message_to_tones(msg);
        let pcm = tones_to_f32(&itone, freq, 1.0);

        // Place at 0.5 s offset
        let pad = 6000usize;
        let mut audio = vec![0.0f32; NMAX];
        for (i, &s) in pcm.iter().enumerate() {
            if pad + i < NMAX { audio[pad + i] = s; }
        }

        // Add AWGN — SNR relative to signal amplitude (simple model for testing)
        // signal_rms ≈ 0.707, noise_std = signal_rms * 10^(-snr_db/20)
        let noise_std = (0.707 * 10.0_f64.powf(-snr_db as f64 / 20.0)) as f32;
        // Simple LCG PRNG (deterministic, no external deps)
        let mut rng_state = 0x12345678u64;
        for s in audio.iter_mut() {
            // Box-Muller (approximate with 2 uniform samples)
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
            let u1 = (rng_state >> 33) as f32 / (1u64 << 31) as f32;
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
            let u2 = (rng_state >> 33) as f32 / (1u64 << 31) as f32;
            let u1c = u1.max(1e-10);
            let gauss = (-2.0 * u1c.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
            *s += noise_std * gauss;
        }

        audio.iter().map(|&s| (s * 20000.0).clamp(-32768.0, 32767.0) as i16).collect()
    }

    /// Helper: upsample from 12 kHz to target rate using linear interpolation.
    fn upsample(audio_12k: &[i16], target_rate: u32) -> Vec<i16> {
        let ratio = target_rate as f64 / 12000.0;
        let out_len = (audio_12k.len() as f64 * ratio).ceil() as usize;
        let mut out = Vec::with_capacity(out_len);
        for i in 0..out_len {
            let src_pos = i as f64 / ratio;
            let idx = src_pos as usize;
            let frac = src_pos - idx as f64;
            if idx + 1 < audio_12k.len() {
                let v = audio_12k[idx] as f64 + (audio_12k[idx + 1] as f64 - audio_12k[idx] as f64) * frac;
                out.push(v.round() as i16);
            } else if idx < audio_12k.len() {
                out.push(audio_12k[idx]);
            }
        }
        out
    }

    /// 48 kHz resample round-trip with weak signal (-18 dB SNR) and noise.
    #[test]
    fn resample_decode_48k_weak_signal() {
        use crate::decode::{decode_frame, DecodeDepth};
        use crate::params::{MSG_BITS, NMAX};

        let msg = [1u8; MSG_BITS];
        let audio_12k = make_noisy_frame(&msg, 1000.0, -18.0);

        // Upsample to 48 kHz, then resample back
        let audio_48k = upsample(&audio_12k, 48000);
        let resampled = resample_to_12k(&audio_48k, 48000);
        assert!((resampled.len() as i32 - NMAX as i32).abs() <= 1);

        let results = decode_frame(&resampled, 800.0, 1200.0, 1.0, None, DecodeDepth::BpAllOsd, 50);
        assert!(!results.is_empty(), "resample 48k decode failed at -18 dB SNR");
        assert_eq!(results[0].message77, msg);
    }

    /// f32 input → resample → decode at 48 kHz, weak signal.
    /// Mirrors the live-capture path (AudioWorklet → WASM directly in f32).
    #[test]
    fn resample_f32_decode_48k_weak_signal() {
        use crate::decode::{decode_frame, DecodeDepth};
        use crate::params::{MSG_BITS, NMAX};

        let msg = [1u8; MSG_BITS];
        let audio_12k_i16 = make_noisy_frame(&msg, 1000.0, -18.0);
        // Upsample i16 → 48 kHz, convert to f32 (live capture format).
        let audio_48k_i16 = upsample(&audio_12k_i16, 48000);
        let audio_48k_f32: Vec<f32> = audio_48k_i16.iter()
            .map(|&s| s as f32 / 32768.0)
            .collect();

        let resampled = resample_f32_to_12k(&audio_48k_f32, 48000);
        assert!((resampled.len() as i32 - NMAX as i32).abs() <= 1);

        let results = decode_frame(&resampled, 800.0, 1200.0, 1.0, None, DecodeDepth::BpAllOsd, 50);
        assert!(!results.is_empty(), "f32 resample 48k decode failed at -18 dB SNR");
        assert_eq!(results[0].message77, msg);
    }

    /// 44100 Hz (non-integer ratio) resample with weak signal (-18 dB SNR).
    #[test]
    fn resample_decode_44100_weak_signal() {
        use crate::decode::{decode_frame, DecodeDepth};
        use crate::params::{MSG_BITS, NMAX};

        let msg = [1u8; MSG_BITS];
        let audio_12k = make_noisy_frame(&msg, 1000.0, -18.0);

        // Upsample to 44100 Hz, then resample back
        let audio_44k = upsample(&audio_12k, 44100);
        let resampled = resample_to_12k(&audio_44k, 44100);
        assert!((resampled.len() as i32 - NMAX as i32).abs() <= 2);

        let results = decode_frame(&resampled, 800.0, 1200.0, 1.0, None, DecodeDepth::BpAllOsd, 50);
        assert!(!results.is_empty(), "resample 44100 decode failed at -18 dB SNR");
        assert_eq!(results[0].message77, msg);
    }
}

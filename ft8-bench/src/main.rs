mod real_data;
mod diag;
mod simulator;

use std::path::PathBuf;
use real_data::evaluate_real_data;
use simulator::make_busy_band_scenario;

fn main() {
    let testdata = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata");

    let wavs = [
        "191111_110130.wav",
        "191111_110200.wav",
    ];

    let mut total_decoded = 0usize;
    let mut any_found = false;

    for name in &wavs {
        let path = testdata.join(name);
        if !path.exists() {
            println!("SKIP {name} (not found — download from https://github.com/jl1nie/RustFT8/tree/main/data)");
            continue;
        }
        any_found = true;
        match evaluate_real_data(&path) {
            Ok(report) => {
                total_decoded += report.messages.len();
                report.print();
            }
            Err(e) => eprintln!("ERROR {name}: {e}"),
        }
    }

    if any_found {
        println!("Total decoded across all files: {total_decoded}");
    }

    // ── Synthetic interference scenario ─────────────────────────────────────
    run_interference_scenario();

    // ── Busy-band (ADC dynamic-range) scenario ───────────────────────────────
    run_busy_band_scenario();

    // ── Busy-band hard case (+20 dB crowd, −20 dB target) ────────────────────
    run_busy_band_hard_scenario();

    // ── Speed benchmark (release build only meaningful) ───────────────────────
    run_speed_bench();

    // Diagnose missing signals in 110200
    let wav200 = testdata.join("191111_110200.wav");
    if wav200.exists() {
        println!();
        let _ = diag::trace_missing(&wav200);
    }

    // Diagnose OSD-only signals in 110130 (are they real or spurious?)
    let wav130 = testdata.join("191111_110130.wav");
    if wav130.exists() {
        println!();
        let _ = diag::trace_spurious(&wav130);
    }
}

// ────────────────────────────────────────────────────────────────────────────

/// Busy-band ADC dynamic-range scenario.
///
/// 12 strong crowd stations (0 to +5 dB SNR) fill 200–2800 Hz.
/// A single weak target sits at 1000 Hz at −12 dB SNR.
///
/// Expected result:
///   - Full-band decode: target is NOT decoded (ADC range dominated by crowd)
///   - Sniper decode (target ±250 Hz): target IS decoded (crowd outside BPF)
fn run_busy_band_scenario() {
    use ft8_core::decode::{decode_frame, decode_sniper, DecodeDepth};

    const TARGET_FREQ: f32 = 1000.0;
    const TARGET_SNR: f32 = -12.0;
    const NUM_INTERFERERS: usize = 12;
    const INTERFERER_SNR: f32 = 5.0;

    let target_msg = [0u8; 77];

    println!("=== Busy-band: {} crowd stations @ {INTERFERER_SNR:+.0} dB, target @ {TARGET_SNR:+.0} dB ===",
        NUM_INTERFERERS);

    let config = make_busy_band_scenario(
        target_msg,
        TARGET_FREQ,
        TARGET_SNR,
        NUM_INTERFERERS,
        INTERFERER_SNR,
        Some(777),
    );

    println!("  Crowd station frequencies (Hz):");
    for sig in config.signals.iter().skip(1) {
        print!("    {:6.1}", sig.freq_hz);
    }
    println!();

    let audio = simulator::generate_frame(&config);

    // Full-band decode (simulates WSJT-X)
    let results_full = decode_frame(
        &audio, 200.0, 2800.0, 1.0, None, DecodeDepth::BpAllOsd, 200,
    );
    let target_full = results_full.iter().any(|r| r.message77 == target_msg);
    println!(
        "  [full-band  ] total decoded: {:2}  target @ {TARGET_FREQ:.0} Hz: {}",
        results_full.len(),
        if target_full { "DECODED" } else { "missed" }
    );

    // Sniper-mode decode (simulates hardware 500 Hz BPF removing the crowd)
    let results_sniper = decode_sniper(&audio, TARGET_FREQ, DecodeDepth::BpAllOsd, 20);
    let target_sniper = results_sniper.iter().any(|r| r.message77 == target_msg);
    println!(
        "  [sniper-mode] total decoded: {:2}  target @ {TARGET_FREQ:.0} Hz: {}",
        results_sniper.len(),
        if target_sniper { "DECODED" } else { "missed" }
    );

    // Write busy-band WAV for external WSJT-X verification
    let out_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("sim_busy_band.wav");
    if let Ok(()) = simulator::write_wav(&out_path, &audio) {
        println!("  WAV written: {}", out_path.display());
    }
    println!();
}

// ────────────────────────────────────────────────────────────────────────────

/// Hard busy-band scenario: +20 dB crowd, −20 dB target.
///
/// This is the extreme ADC saturation case.  The 40 dB gap means the target
/// sits 40 dB below the crowd — identical dynamic-range challenge to the
/// +40 dB two-station case, but spread across 12 stations so the ADC stitches
/// up all its headroom for the crowd.
///
/// Expected:
///   - Full-band (WSJT-X equivalent): target missed
///   - Sniper-mode (500 Hz BPF removes crowd): target decoded
fn run_busy_band_hard_scenario() {
    use ft8_core::decode::{decode_frame, decode_sniper, DecodeDepth};

    const TARGET_FREQ: f32 = 1000.0;
    const TARGET_SNR: f32 = -14.0;  // 100% decode in BPF mode
    const NUM_INTERFERERS: usize = 15;
    const INTERFERER_SNR: f32 = 40.0;  // 54 dB above target; hard-clips 16-bit ADC

    let target_msg = [0u8; 77];

    println!("=== Busy-band HARD: {} crowd @ {INTERFERER_SNR:+.0} dB, target @ {TARGET_SNR:+.0} dB  (gap={:.0} dB) ===",
        NUM_INTERFERERS, INTERFERER_SNR - TARGET_SNR);

    let config = make_busy_band_scenario(
        target_msg,
        TARGET_FREQ,
        TARGET_SNR,
        NUM_INTERFERERS,
        INTERFERER_SNR,
        Some(888),
    );

    println!("  Crowd station frequencies (Hz):");
    for sig in config.signals.iter().skip(1) {
        print!("    {:6.1}", sig.freq_hz);
    }
    println!();

    // ── Mixed audio with crowd-AGC quantisation ───────────────────────────────
    // The ADC gain is set for the +20 dB crowd.  The −16 dB target occupies
    // only the bottom few quantisation levels → buried in clipping/quantisation
    // noise from the crowd.  This is the real-world ADC dynamic-range problem.
    let mix_f32 = simulator::generate_frame_f32(&config);
    let audio_mixed = simulator::quantise_crowd_agc(&mix_f32, INTERFERER_SNR, NUM_INTERFERERS);

    let results_full = decode_frame(
        &audio_mixed, 200.0, 2800.0, 1.0, None, DecodeDepth::BpAllOsd, 200,
    );
    let target_full = results_full.iter().any(|r| r.message77 == target_msg);
    println!(
        "  [no-BPF: full-band ] total decoded: {:2}  target @ {TARGET_FREQ:.0} Hz: {}",
        results_full.len(),
        if target_full { "DECODED" } else { "missed" }
    );

    // Narrow-band search on mixed ADC audio (crowd distortion still present)
    let results_sniper_mixed = decode_sniper(&audio_mixed, TARGET_FREQ, DecodeDepth::BpAllOsd, 20);
    let target_mixed = results_sniper_mixed.iter().any(|r| r.message77 == target_msg);
    println!(
        "  [no-BPF: sniper sw ] total decoded: {:2}  target @ {TARGET_FREQ:.0} Hz: {}",
        results_sniper_mixed.len(),
        if target_mixed { "DECODED" } else { "missed" }
    );

    // ── BPF-filtered audio: sweep 20 seeds to show success rate ──────────────
    // The hardware BPF removes the crowd before the ADC, so the decoder only
    // sees target + AWGN.  At −20 dB SNR we are near the FT8 threshold; the
    // success rate across independent noise realisations shows the gain.
    const N_SEEDS: u64 = 20;
    let mut bpf_ok = 0usize;
    let mut best_result: Option<ft8_core::decode::DecodeResult> = None;
    for seed in 0..N_SEEDS {
        let config_bpf = simulator::SimConfig {
            signals: vec![simulator::SimSignal {
                message77: target_msg,
                freq_hz: TARGET_FREQ,
                snr_db: TARGET_SNR,
                dt_sec: 0.0,
            }],
            noise_seed: Some(seed),
        };
        let audio_bpf = simulator::generate_frame(&config_bpf);
        let results = decode_sniper(&audio_bpf, TARGET_FREQ, DecodeDepth::BpAllOsd, 20);
        if let Some(r) = results.iter().find(|r| r.message77 == target_msg) {
            bpf_ok += 1;
            if best_result.is_none() { best_result = Some(r.clone()); }
        }
    }
    println!(
        "  [500Hz BPF: sniper ] {bpf_ok}/{N_SEEDS} seeds decoded  \
         (success rate: {:.0}%)",
        100.0 * bpf_ok as f32 / N_SEEDS as f32
    );
    if let Some(r) = &best_result {
        println!("    example: snr={:+.1} dB  dt={:+.2} s  errors={}  pass={}",
            r.snr_db, r.dt_sec, r.hard_errors, r.pass);
    }

    // Write crowd-AGC mixed WAV for WSJT-X external verification
    let out_mixed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata").join("sim_busy_band_hard_mixed.wav");
    if simulator::write_wav(&out_mixed, &audio_mixed).is_ok() {
        println!("  WAV (crowd-AGC mixed) written: {}", out_mixed.display());
    }
    // Write BPF WAV (seed=0) as the cleanest target-only reference
    {
        let config_bpf0 = simulator::SimConfig {
            signals: vec![simulator::SimSignal {
                message77: target_msg, freq_hz: TARGET_FREQ,
                snr_db: TARGET_SNR, dt_sec: 0.0,
            }],
            noise_seed: Some(0),
        };
        let audio_bpf0 = simulator::generate_frame(&config_bpf0);
        let out_bpf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("testdata").join("sim_busy_band_hard_bpf.wav");
        if simulator::write_wav(&out_bpf, &audio_bpf0).is_ok() {
            println!("  WAV (BPF, seed=0) written: {}", out_bpf.display());
        }
    }
    println!();
}

// ────────────────────────────────────────────────────────────────────────────

/// Speed benchmark: measure decode_frame throughput on a synthetic frame.
///
/// Runs N_WARM warmup iterations (discarded) then N_MEASURE timed iterations.
/// Reports mean, min, and max elapsed time per frame.
///
/// Run with `cargo run --release` for meaningful numbers.
fn run_speed_bench() {
    use std::time::Instant;
    use ft8_core::decode::{decode_frame, decode_frame_subtract, DecodeDepth};

    const N_WARM: usize = 3;
    const N_MEASURE: usize = 10;

    // Generate a realistic frame: 8 stations spread across the band at +5 dB.
    let msgs: [[u8; 77]; 8] = core::array::from_fn(|i| {
        let mut m = [0u8; 77];
        m[0] = (i & 1) as u8;
        m[1] = ((i >> 1) & 1) as u8;
        m[2] = ((i >> 2) & 1) as u8;
        m
    });
    let freqs: [f32; 8] = [400.0, 600.0, 900.0, 1200.0, 1500.0, 1800.0, 2100.0, 2500.0];

    let config = simulator::SimConfig {
        signals: msgs.iter().zip(freqs.iter()).map(|(&message77, &freq_hz)| {
            simulator::SimSignal { message77, freq_hz, snr_db: 5.0, dt_sec: 0.0 }
        }).collect(),
        noise_seed: Some(42),
    };
    let audio = simulator::generate_frame(&config);

    // ── decode_frame (single-pass) ────────────────────────────────────────────
    println!("=== Speed benchmark ({N_MEASURE} runs, release build recommended) ===");

    for _ in 0..N_WARM {
        let _ = decode_frame(&audio, 200.0, 2800.0, 1.0, None, DecodeDepth::BpAllOsd, 200);
    }
    let mut times_single = Vec::with_capacity(N_MEASURE);
    for _ in 0..N_MEASURE {
        let t0 = Instant::now();
        let r = decode_frame(&audio, 200.0, 2800.0, 1.0, None, DecodeDepth::BpAllOsd, 200);
        let elapsed = t0.elapsed();
        times_single.push((elapsed, r.len()));
    }
    let decoded_count = times_single[0].1;
    let ms: Vec<f64> = times_single.iter().map(|(d, _)| d.as_secs_f64() * 1000.0).collect();
    let mean = ms.iter().sum::<f64>() / ms.len() as f64;
    let min  = ms.iter().cloned().fold(f64::INFINITY, f64::min);
    let max  = ms.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    println!("  decode_frame       (decoded={decoded_count:2})  mean={mean:6.1} ms  min={min:6.1} ms  max={max:6.1} ms");

    // ── decode_frame_subtract (3-pass) ────────────────────────────────────────
    for _ in 0..N_WARM {
        let _ = decode_frame_subtract(&audio, 200.0, 2800.0, 1.0, None, DecodeDepth::BpAllOsd, 200);
    }
    let mut times_sub = Vec::with_capacity(N_MEASURE);
    for _ in 0..N_MEASURE {
        let t0 = Instant::now();
        let r = decode_frame_subtract(&audio, 200.0, 2800.0, 1.0, None, DecodeDepth::BpAllOsd, 200);
        let elapsed = t0.elapsed();
        times_sub.push((elapsed, r.len()));
    }
    let decoded_sub = times_sub[0].1;
    let ms_sub: Vec<f64> = times_sub.iter().map(|(d, _)| d.as_secs_f64() * 1000.0).collect();
    let mean_s = ms_sub.iter().sum::<f64>() / ms_sub.len() as f64;
    let min_s  = ms_sub.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_s  = ms_sub.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    println!("  decode_frame_sub   (decoded={decoded_sub:2})  mean={mean_s:6.1} ms  min={min_s:6.1} ms  max={max_s:6.1} ms");

    println!();
}

// ────────────────────────────────────────────────────────────────────────────

/// Synthetic +40 dB interference scenario.
///
/// Places a weak target at 1000 Hz (SNR = −5 dB) and a +40 dB interferer at
/// 1200 Hz in the same frame.  Tests that the decoder recovers the target.
fn run_interference_scenario() {
    use ft8_core::decode::{decode_frame, DecodeDepth};
    use simulator::{SimConfig, SimSignal, make_interference_scenario};

    println!("=== Synthetic: +40 dB interferer @ 200 Hz offset ===");

    let target_msg = [0u8; 77];
    let interferer_msg = [1u8; 77];

    let config = make_interference_scenario(
        target_msg,
        1000.0,     // target at 1000 Hz
        -5.0,       // target SNR = -5 dB
        interferer_msg,
        1200.0,     // interferer 200 Hz away
        40.0,       // +40 dB above target
        Some(99),
    );

    let audio = simulator::generate_frame(&config);
    let results = decode_frame(&audio, 800.0, 1400.0, 1.0, None, DecodeDepth::BpAllOsd, 50);

    let target_found = results.iter().any(|r| r.message77 == target_msg);
    let interferer_found = results.iter().any(|r| r.message77 == interferer_msg);

    println!(
        "  target   ({:5.1} Hz, SNR {:+.0} dB): {}",
        1000.0_f32,
        -5.0_f32,
        if target_found { "DECODED" } else { "missed" }
    );
    println!(
        "  interferer ({:5.1} Hz, SNR {:+.0} dB): {}",
        1200.0_f32,
        35.0_f32,
        if interferer_found { "DECODED" } else { "missed" }
    );
    println!("  total decoded: {}", results.len());

    // Optionally write the mixed WAV for external WSJT-X verification.
    let out_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("sim_interference.wav");
    if let Ok(()) = simulator::write_wav(&out_path, &audio) {
        println!("  WAV written: {}", out_path.display());
    }

    println!();

    // ── Simulate what sniper mode sees after hardware 500 Hz BPF ────────────
    // After BPF centred on 1000 Hz ±250 Hz, the +40 dB interferer at 1200 Hz
    // is physically removed.  Simulate this by synthesising target only.
    println!("=== Synthetic: sniper mode (interferer outside 500 Hz BPF) ===");

    let config_sniper = SimConfig {
        signals: vec![SimSignal {
            message77: target_msg,
            freq_hz: 1000.0,
            snr_db: -5.0,
            dt_sec: 0.0,
        }],
        noise_seed: Some(99),
    };
    let audio_sniper = simulator::generate_frame(&config_sniper);
    let results_sniper = decode_frame(
        &audio_sniper, 800.0, 1200.0, 0.8, None, DecodeDepth::BpAllOsd, 20,
    );
    let target_sniper = results_sniper.iter().any(|r| r.message77 == target_msg);
    println!(
        "  target   ({:5.1} Hz, SNR {:+.0} dB): {}",
        1000.0_f32,
        -5.0_f32,
        if target_sniper { "DECODED" } else { "missed" }
    );
    println!("  total decoded: {}", results_sniper.len());
}

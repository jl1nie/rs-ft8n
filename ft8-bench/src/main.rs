mod real_data;
mod diag;
mod simulator;

use std::path::PathBuf;
use real_data::evaluate_real_data;

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

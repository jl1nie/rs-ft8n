/// Diagnostic tracing for the decode pipeline.
use std::path::Path;

use mfsk_core::ft8::{
    downsample::downsample,
    ldpc::{bp::bp_decode, osd::osd_decode},
    llr::{compute_llr, symbol_spectra, sync_quality},
    params::BP_MAX_ITER,
    sync::{coarse_sync, refine_candidate},
};

fn llr_stats(llr: &[f32]) -> (f32, f32, usize) {
    let min = llr.iter().cloned().fold(f32::INFINITY, f32::min);
    let max = llr.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let pos = llr.iter().filter(|&&v| v > 0.0).count();
    (min, max, pos)
}

/// Run BP on all 4 LLR variants, then OSD fallback.
/// Returns ("BP"/"OSD"/"FAIL").
fn try_all(llr_a: &[f32; 174], llr_b: &[f32; 174], llr_c: &[f32; 174], llr_d: &[f32; 174])
    -> &'static str
{
    for llr in [llr_a, llr_b, llr_c, llr_d] {
        if bp_decode(llr, None, BP_MAX_ITER, None).is_some() {
            return "BP";
        }
    }
    if osd_decode(llr_a).is_some() {
        return "OSD";
    }
    "FAIL"
}

/// Trace the pipeline for candidates near a target frequency.
pub fn trace_near(wav_path: &Path, target_hz: f32, label: &str) -> Result<(), String> {
    let mut reader = hound::WavReader::open(wav_path)
        .map_err(|e| format!("open WAV: {e}"))?;
    let samples: Vec<i16> = reader
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read: {e}"))?;

    // Pull all candidates; look at the best one within ±30 Hz of target.
    let cands = coarse_sync(&samples, 200.0, 2800.0, 0.0, None, 1000);

    let near: Vec<_> = cands.iter()
        .filter(|c| (c.freq_hz - target_hz).abs() < 30.0)
        .collect();

    println!("--- {label} @ ~{target_hz:.0} Hz  ({} candidate(s) within ±30 Hz) ---",
             near.len());

    let mut fft_cache: Option<Vec<_>> = None;
    for (ci, cand) in near.iter().take(5).enumerate() {
        let (cd0, new_cache) = downsample(&samples, cand.freq_hz, fft_cache.as_deref());
        fft_cache = Some(new_cache);

        let refined = refine_candidate(&cd0, cand, 10);
        let i_start = ((refined.dt_sec + 0.5) * 200.0).round() as usize;
        let cs = symbol_spectra(&cd0, i_start);
        let nsync = sync_quality(&cs);
        let llr_set = compute_llr(&cs);
        let (lmin, lmax, lpos) = llr_stats(&llr_set.llra);
        let verdict = try_all(
            &llr_set.llra, &llr_set.llrb, &llr_set.llrc, &llr_set.llrd);

        println!(
            "  [{ci}] coarse={:.1}Hz score={:.2}  fine_dt={:+.3}s  sync_q={nsync:2}  \
             llra[{lmin:.2}..{lmax:.2} +{lpos}/174]  decode={verdict}",
            cand.freq_hz, cand.score, refined.dt_sec,
        );
    }
    Ok(())
}

pub fn trace_missing(wav_path: &Path) -> Result<(), String> {
    println!("=== missing-signal trace: {} ===", wav_path.display());
    trace_near(wav_path, 990.0,  "OH3NIV ZS6S")?;
    trace_near(wav_path, 1030.0, "CQ LZ1JZ KN22")?;
    Ok(())
}

pub fn trace_spurious(wav_path: &Path) -> Result<(), String> {
    println!("=== spurious-signal trace: {} ===", wav_path.display());
    trace_near(wav_path, 2478.0,  "2478 Hz OSD?")?;
    trace_near(wav_path, 890.0,   "890 Hz OSD?")?;
    trace_near(wav_path, 2259.0,  "2259 Hz OSD?")?;
    Ok(())
}

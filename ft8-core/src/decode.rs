/// High-level FT8 decode pipeline.
///
/// Chains: downsample → coarse_sync → fine_sync → LLR → BP decode
use crate::{
    downsample::downsample,
    ldpc::{bp::bp_decode, osd::{osd_decode, osd_decode_deep}},
    llr::{compute_llr, symbol_spectra, sync_quality},
    params::BP_MAX_ITER,
    sync::{coarse_sync, refine_candidate, refine_candidate_double},
};

// ────────────────────────────────────────────────────────────────────────────
// Public types

/// Decoding depth: which LLR sets and passes to attempt.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DecodeDepth {
    /// Belief-propagation only, using nsym=1 metrics (fast).
    Bp,
    /// BP with all four metric variants (a, b, c, d).
    BpAll,
    /// BP (all four variants) then OSD order-1 fallback when BP fails.
    BpAllOsd,
}

/// One successfully decoded FT8 message.
#[derive(Debug, Clone)]
pub struct DecodeResult {
    /// Decoded message: 77 bits packed as bytes (LSB first within each byte).
    pub message77: [u8; 77],
    /// Carrier frequency (Hz)
    pub freq_hz: f32,
    /// Time offset from the nominal 0.5 s start (seconds)
    pub dt_sec: f32,
    /// Number of hard-decision errors in the final codeword
    pub hard_errors: u32,
    /// Sync quality score from fine sync
    pub sync_score: f32,
    /// Which LLR variant decoded successfully (0=llra, 1=llrb, 2=llrc, 3=llrd)
    pub pass: u8,
}

// ────────────────────────────────────────────────────────────────────────────
// Main decode entry point

/// Decode one 15-second FT8 audio frame.
///
/// # Arguments
/// * `audio`      — 16-bit PCM samples at 12 000 Hz, length ≤ 180 000
/// * `freq_min`   — lower edge of search band (Hz)
/// * `freq_max`   — upper edge of search band (Hz)
/// * `sync_min`   — minimum coarse-sync score (typical: 1.0–2.0)
/// * `freq_hint`  — optional preferred frequency; matching candidates are tried first
/// * `depth`      — decoding depth
/// * `max_cand`   — maximum number of sync candidates to evaluate
///
/// Returns all successfully decoded messages (deduplicated by `message77`).
pub fn decode_frame(
    audio: &[i16],
    freq_min: f32,
    freq_max: f32,
    sync_min: f32,
    freq_hint: Option<f32>,
    depth: DecodeDepth,
    max_cand: usize,
) -> Vec<DecodeResult> {
    // ── Coarse sync ─────────────────────────────────────────────────────────
    let candidates = coarse_sync(audio, freq_min, freq_max, sync_min, freq_hint, max_cand);

    // Cache the large forward FFT (computed once per frame, reused per candidate)
    let mut fft_cache: Option<Vec<_>> = None;

    let mut results: Vec<DecodeResult> = Vec::new();

    for cand in &candidates {
        // ── Downsample to 200 Hz centred on candidate frequency ─────────────
        let (cd0, new_cache) = downsample(audio, cand.freq_hz, fft_cache.as_deref());
        fft_cache = Some(new_cache);

        // ── Fine sync (refine time offset at downsampled rate) ───────────────
        let refined = refine_candidate(&cd0, cand, 10);

        let i_start = ((refined.dt_sec + 0.5) * 200.0).round() as usize;

        // ── Symbol spectra (79 × 8 complex bins) ────────────────────────────
        let cs = symbol_spectra(&cd0, i_start);

        // Bail out on poor sync quality
        let nsync = sync_quality(&cs);
        if nsync <= 6 {
            continue;
        }

        // ── LLR computation ──────────────────────────────────────────────────
        let llr_set = compute_llr(&cs);

        // ── BP decode — try multiple LLR variants ───────────────────────────
        let llr_variants: &[(&[f32; 174], u8)] = match depth {
            DecodeDepth::Bp => &[(&llr_set.llra, 0)],
            DecodeDepth::BpAll | DecodeDepth::BpAllOsd => &[
                (&llr_set.llra, 0),
                (&llr_set.llrb, 1),
                (&llr_set.llrc, 2),
                (&llr_set.llrd, 3),
            ],
        };

        let mut decoded_this_cand = false;
        for &(llr, pass_id) in llr_variants {
            if let Some(bp) = bp_decode(llr, None, BP_MAX_ITER) {
                let result = DecodeResult {
                    message77: bp.message77,
                    freq_hz: cand.freq_hz,
                    dt_sec: refined.dt_sec,
                    hard_errors: bp.hard_errors,
                    sync_score: refined.score,
                    pass: pass_id,
                };
                // Deduplicate by message77
                if !results.iter().any(|r| r.message77 == result.message77) {
                    results.push(result);
                }
                decoded_this_cand = true;
                break; // first successful pass wins for this candidate
            }
        }

        // ── OSD fallback when all BP variants failed ─────────────────────
        // Use higher ndeep for very reliable sync; require minimum sync quality
        // to suppress false positives from OSD's large candidate set.
        //   nsync >= 12 → order-2 (~4,187 candidates)
        //   nsync >= 18 → order-3 (~121,667 candidates, slow but catches -14 dB)
        // Coarse sync score threshold: real signals have score ≥ 2.5; low-score
        // candidates produce too many CRC collisions at OSD order ≥ 2.
        if !decoded_this_cand && depth == DecodeDepth::BpAllOsd
            && nsync >= 12 && cand.score >= 2.5
        {
            // Skip if an existing decode already covers this frequency (±20 Hz).
            let freq_dup = results
                .iter()
                .any(|r| (r.freq_hz - cand.freq_hz).abs() < 20.0);
            if !freq_dup {
                let osd_depth: u8 = if nsync >= 18 { 3 } else { 2 };
                // Try all four LLR variants with OSD.
                for llr_osd in [&llr_set.llra, &llr_set.llrb, &llr_set.llrc, &llr_set.llrd] {
                    let osd_result = if osd_depth == 3 {
                        osd_decode_deep(llr_osd, 3)
                    } else {
                        osd_decode(llr_osd)
                    };
                    if let Some(osd) = osd_result {
                        // Reject extremely high-error results (likely false positives).
                        // At −15 dB SNR, ~48 hard errors is expected for a genuine signal.
                        if osd.hard_errors >= 56 {
                            continue;
                        }
                        let result = DecodeResult {
                            message77: osd.message77,
                            freq_hz: cand.freq_hz,
                            dt_sec: refined.dt_sec,
                            hard_errors: osd.hard_errors,
                            sync_score: refined.score,
                            pass: 4, // OSD
                        };
                        if !results.iter().any(|r| r.message77 == result.message77) {
                            results.push(result);
                        }
                        break; // first successful OSD variant wins
                    }
                }
            }
        }
    }

    results
}

// ────────────────────────────────────────────────────────────────────────────
// Convenience: sniper-mode decode (single target frequency, narrow band)

/// Sniper-mode decode: search only within ±250 Hz of `target_freq`.
///
/// Uses Double Sync (independent Array-1 / Array-3 peak search) for ghost
/// suppression.  Candidates whose timing drifts more than 40 ms between the
/// two outer Costas arrays are rejected as spurious correlations.
///
/// Lower `sync_min` is used because the 500 Hz filter removes strong
/// adjacent signals and reduces the noise floor.
pub fn decode_sniper(
    audio: &[i16],
    target_freq: f32,
    depth: DecodeDepth,
    max_cand: usize,
) -> Vec<DecodeResult> {
    let freq_min = (target_freq - 250.0).max(100.0);
    let freq_max = (target_freq + 250.0).min(5900.0);
    let sync_min = 0.8;

    let candidates = coarse_sync(audio, freq_min, freq_max, sync_min, Some(target_freq), max_cand);

    let mut fft_cache: Option<Vec<_>> = None;
    let mut results: Vec<DecodeResult> = Vec::new();

    for cand in &candidates {
        let (cd0, new_cache) = downsample(audio, cand.freq_hz, fft_cache.as_deref());
        fft_cache = Some(new_cache);

        // Double Sync: independently maximise Array 1 and Array 3.
        let detail = refine_candidate_double(&cd0, cand, 10);

        // Ghost filter: real signals have |drift| < 40 ms across 11.52 s.
        if detail.drift_dt_sec.abs() > 0.040 {
            continue;
        }

        let refined = detail.candidate;
        let i_start = ((refined.dt_sec + 0.5) * 200.0).round() as usize;
        let cs = symbol_spectra(&cd0, i_start);
        let nsync = sync_quality(&cs);
        if nsync <= 6 {
            continue;
        }

        let llr_set = compute_llr(&cs);
        let llr_variants: &[(&[f32; 174], u8)] = match depth {
            DecodeDepth::Bp => &[(&llr_set.llra, 0)],
            DecodeDepth::BpAll | DecodeDepth::BpAllOsd => &[
                (&llr_set.llra, 0),
                (&llr_set.llrb, 1),
                (&llr_set.llrc, 2),
                (&llr_set.llrd, 3),
            ],
        };

        let mut decoded_this_cand = false;
        for &(llr, pass_id) in llr_variants {
            if let Some(bp) = bp_decode(llr, None, BP_MAX_ITER) {
                let result = DecodeResult {
                    message77: bp.message77,
                    freq_hz: cand.freq_hz,
                    dt_sec: refined.dt_sec,
                    hard_errors: bp.hard_errors,
                    sync_score: refined.score,
                    pass: pass_id,
                };
                if !results.iter().any(|r| r.message77 == result.message77) {
                    results.push(result);
                }
                decoded_this_cand = true;
                break;
            }
        }

        if !decoded_this_cand && depth == DecodeDepth::BpAllOsd
            && nsync >= 12 && cand.score >= 2.5
        {
            let freq_dup = results
                .iter()
                .any(|r| (r.freq_hz - cand.freq_hz).abs() < 20.0);
            if !freq_dup {
                let osd_depth: u8 = if nsync >= 18 { 3 } else { 2 };
                for llr_osd in [&llr_set.llra, &llr_set.llrb, &llr_set.llrc, &llr_set.llrd] {
                    let osd_result = if osd_depth == 3 {
                        osd_decode_deep(llr_osd, 3)
                    } else {
                        osd_decode(llr_osd)
                    };
                    if let Some(osd) = osd_result {
                        if osd.hard_errors >= 56 {
                            continue;
                        }
                        let result = DecodeResult {
                            message77: osd.message77,
                            freq_hz: cand.freq_hz,
                            dt_sec: refined.dt_sec,
                            hard_errors: osd.hard_errors,
                            sync_score: refined.score,
                            pass: 4,
                        };
                        if !results.iter().any(|r| r.message77 == result.message77) {
                            results.push(result);
                        }
                        break;
                    }
                }
            }
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Silence produces no decoded messages and does not panic.
    #[test]
    fn silence_no_decode() {
        let audio = vec![0i16; 15 * 12_000];
        let results = decode_frame(&audio, 200.0, 2800.0, 1.0, None, DecodeDepth::Bp, 10);
        assert!(results.is_empty(), "silence should decode nothing");
    }

    /// Sniper mode on silence also produces no decoded messages.
    #[test]
    fn sniper_silence_no_decode() {
        let audio = vec![0i16; 15 * 12_000];
        let results = decode_sniper(&audio, 1000.0, DecodeDepth::Bp, 10);
        assert!(results.is_empty());
    }
}

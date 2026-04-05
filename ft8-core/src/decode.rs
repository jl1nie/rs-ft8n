/// High-level FT8 decode pipeline.
///
/// Chains: downsample → coarse_sync → fine_sync → LLR → BP decode
#[cfg(feature = "parallel")]
use rayon::prelude::*;

pub use crate::equalizer::EqMode;
use crate::{
    downsample::{build_fft_cache, downsample},
    equalizer,
    ldpc::{bp::bp_decode, osd::{osd_decode, osd_decode_deep}},
    llr::{compute_llr, compute_snr_db, symbol_spectra, sync_quality},
    message::pack28,
    params::{BP_MAX_ITER, LDPC_N},
    subtract::subtract_signal_weighted,
    sync::{coarse_sync, fine_sync_power_split, refine_candidate, SyncCandidate},
    wave_gen::message_to_tones,
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
    /// Coefficient of variation of the three Costas-array powers (score_a/b/c).
    ///
    /// Near zero for a stable channel; elevated (> 0.3) when QSB or strong
    /// time-varying fading is present.  Used by `decode_frame_subtract` to
    /// apply partial subtraction gain when the amplitude estimate is unreliable.
    pub sync_cv: f32,
    /// WSJT-X compatible SNR estimate (dB).
    ///
    /// Computed from decoded tone power vs. opposite-tone noise power:
    /// `10 log10(xsig/xnoi − 1) − 27 dB`.  Floor is −24 dB (same as WSJT-X).
    pub snr_db: f32,
}

// ────────────────────────────────────────────────────────────────────────────
// A Priori (AP) hint for sniper-mode decode

/// A Priori information for assisted decoding.
///
/// Known callsigns are converted to 28-bit packed tokens and injected as
/// high-confidence LLR values into the BP decoder, effectively reducing the
/// number of unknown bits.  This lowers the decode threshold by several dB.
///
/// # Example
/// ```
/// use ft8_core::decode::ApHint;
/// // "I'm calling 3Y0Z, expecting a reply to my CQ"
/// let ap = ApHint::new().with_call1("CQ").with_call2("3Y0Z");
/// ```
#[derive(Debug, Clone, Default)]
pub struct ApHint {
    /// Known first callsign (e.g. "CQ", "JA1ABC").
    /// Locks message bits 0–28 (28-bit call + 1-bit flag).
    pub call1: Option<String>,
    /// Known second callsign (e.g. "3Y0Z").
    /// Locks message bits 29–57 (28-bit call + 1-bit flag).
    pub call2: Option<String>,
}

impl ApHint {
    pub fn new() -> Self { Self::default() }
    pub fn with_call1(mut self, call: &str) -> Self { self.call1 = Some(call.to_string()); self }
    pub fn with_call2(mut self, call: &str) -> Self { self.call2 = Some(call.to_string()); self }

    /// Returns true if any a-priori information is available.
    pub fn has_info(&self) -> bool { self.call1.is_some() || self.call2.is_some() }

    /// Build AP mask and LLR overrides for the 174-bit LDPC codeword.
    ///
    /// `apmag` — magnitude to assign to known bits (typically `max(|llr|) * 1.01`).
    ///
    /// Returns `(ap_mask, ap_llr)` where:
    /// - `ap_mask[i] = true` means bit `i` is a-priori known (frozen in BP)
    /// - `ap_llr[i]` is the LLR override for known bits (±apmag)
    pub fn build_ap(&self, apmag: f32) -> ([bool; LDPC_N], [f32; LDPC_N]) {
        let mut mask = [false; LDPC_N];
        let mut ap_llr = [0.0f32; LDPC_N];

        // Helper: write 28-bit packed call + 1-bit flag (=0) into AP arrays
        let mut set_call_bits = |call: &str, start: usize| {
            if let Some(n28) = pack28(call) {
                // Write 28 bits of the packed callsign
                for i in 0..28 {
                    let bit = ((n28 >> (27 - i)) & 1) as u8;
                    mask[start + i] = true;
                    ap_llr[start + i] = if bit == 1 { apmag } else { -apmag };
                }
                // Flag bit (ipa/ipb) = 0 for standard calls
                mask[start + 28] = true;
                ap_llr[start + 28] = -apmag; // bit=0 → negative LLR
            }
        };

        if let Some(ref c1) = self.call1 {
            set_call_bits(c1, 0);   // bits 0–28
        }
        if let Some(ref c2) = self.call2 {
            set_call_bits(c2, 29);  // bits 29–57
        }

        // Lock message type i3=1 (Type 1 standard) if any call is known
        if self.has_info() {
            // bits 74-76 = i3 = 001 (Type 1)
            mask[74] = true; ap_llr[74] = -apmag; // bit=0
            mask[75] = true; ap_llr[75] = -apmag; // bit=0
            mask[76] = true; ap_llr[76] = apmag;  // bit=1
        }

        (mask, ap_llr)
    }
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
    decode_frame_inner(audio, freq_min, freq_max, sync_min, freq_hint, depth, max_cand, 2.5, &[], EqMode::Off)
}

// ────────────────────────────────────────────────────────────────────────────
// Per-candidate decode helper (used by both inner and sniper paths)

/// Decode a single sync candidate: downsample → refine → LLR → BP/OSD.
///
/// `fft_cache` — pre-computed 192 000-point forward FFT of the full audio
///   (from [`build_fft_cache`]), shared read-only across parallel calls.
/// `known`     — messages decoded in earlier subtract passes; prevents OSD
///   from running on frequencies that already have a result.
///
/// Returns `Some(DecodeResult)` on the first successful decode, `None` if the
/// candidate yields no valid message.
fn process_candidate(
    cand: &SyncCandidate,
    audio: &[i16],
    fft_cache: &[num_complex::Complex<f32>],
    depth: DecodeDepth,
    osd_score_min: f32,
    known: &[DecodeResult],
    eq_mode: EqMode,
    ap_hint: Option<&ApHint>,
) -> Option<DecodeResult> {
    let (cd0, _) = downsample(audio, cand.freq_hz, Some(fft_cache));

    let refined = refine_candidate(&cd0, cand, 10);
    let i_start = ((refined.dt_sec + 0.5) * 200.0).round() as usize;
    let cs_raw = symbol_spectra(&cd0, i_start);
    let nsync = sync_quality(&cs_raw);
    if nsync <= 6 {
        return None;
    }

    let sync_cv = {
        let (sa, sb, sc) = fine_sync_power_split(&cd0, i_start);
        let mean = (sa + sb + sc) / 3.0;
        if mean > f32::EPSILON {
            let sq = (sa - mean).powi(2) + (sb - mean).powi(2) + (sc - mean).powi(2);
            sq.sqrt() / mean
        } else {
            0.0
        }
    };

    let try_decode = |cs: &[[num_complex::Complex<f32>; 8]; 79],
                       use_ap: bool|
                       -> Option<DecodeResult> {
        let llr_set = compute_llr(cs);

        let llr_variants: &[(&[f32; LDPC_N], u8)] = match depth {
            DecodeDepth::Bp => &[(&llr_set.llra, 0)],
            DecodeDepth::BpAll | DecodeDepth::BpAllOsd => &[
                (&llr_set.llra, 0),
                (&llr_set.llrb, 1),
                (&llr_set.llrc, 2),
                (&llr_set.llrd, 3),
            ],
        };

        // BP decode (no AP)
        for &(llr, pass_id) in llr_variants {
            if let Some(bp) = bp_decode(llr, None, BP_MAX_ITER) {
                let itone = message_to_tones(&bp.message77);
                let snr_db = compute_snr_db(cs, &itone);
                return Some(DecodeResult {
                    message77: bp.message77,
                    freq_hz: cand.freq_hz,
                    dt_sec: refined.dt_sec,
                    hard_errors: bp.hard_errors,
                    sync_score: refined.score,
                    pass: pass_id,
                    sync_cv,
                    snr_db,
                });
            }
        }

        // OSD fallback
        if depth == DecodeDepth::BpAllOsd
            && nsync >= 12 && cand.score >= osd_score_min
        {
            let freq_dup = known.iter().any(|r| (r.freq_hz - cand.freq_hz).abs() < 20.0);
            if !freq_dup {
                let osd_depth: u8 = if nsync >= 18 { 3 } else { 2 };
                for llr_osd in [&llr_set.llra, &llr_set.llrb, &llr_set.llrc, &llr_set.llrd] {
                    let osd_result = if osd_depth == 3 {
                        osd_decode_deep(llr_osd, 3)
                    } else {
                        osd_decode(llr_osd)
                    };
                    if let Some(osd) = osd_result {
                        if osd.hard_errors >= 56 { continue; }
                        let itone = message_to_tones(&osd.message77);
                        let snr_db = compute_snr_db(cs, &itone);
                        return Some(DecodeResult {
                            message77: osd.message77,
                            freq_hz: cand.freq_hz,
                            dt_sec: refined.dt_sec,
                            hard_errors: osd.hard_errors,
                            sync_score: refined.score,
                            pass: 4,
                            sync_cv,
                            snr_db,
                        });
                    }
                }
            }
        }

        // AP-assisted BP (when AP hint available and normal decode failed)
        if use_ap {
            if let Some(ap) = ap_hint {
                if ap.has_info() {
                    let apmag = llr_set.llra.iter()
                        .map(|v| v.abs())
                        .fold(0.0f32, f32::max) * 1.01;
                    let (ap_mask, ap_llr_override) = ap.build_ap(apmag);

                    for &(base_llr, _) in llr_variants {
                        // Overlay AP values onto channel LLR
                        let mut llr_ap = *base_llr;
                        for i in 0..LDPC_N {
                            if ap_mask[i] {
                                llr_ap[i] = ap_llr_override[i];
                            }
                        }
                        if let Some(bp) = bp_decode(&llr_ap, Some(&ap_mask), BP_MAX_ITER) {
                            let itone = message_to_tones(&bp.message77);
                            let snr_db = compute_snr_db(cs, &itone);
                            return Some(DecodeResult {
                                message77: bp.message77,
                                freq_hz: cand.freq_hz,
                                dt_sec: refined.dt_sec,
                                hard_errors: bp.hard_errors,
                                sync_score: refined.score,
                                pass: 5, // AP pass indicator
                                sync_cv,
                                snr_db,
                            });
                        }
                    }
                }
            }
        }

        None
    };

    match eq_mode {
        EqMode::Off => try_decode(&cs_raw, true),
        EqMode::Local => {
            let mut cs_eq = cs_raw.clone();
            equalizer::equalize_local(&mut cs_eq);
            try_decode(&cs_eq, true)
        }
        EqMode::Adaptive => {
            let mut cs_eq = cs_raw.clone();
            equalizer::equalize_local(&mut cs_eq);
            if let Some(r) = try_decode(&cs_eq, true) {
                return Some(r);
            }
            try_decode(&cs_raw, true)
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────

/// Inner decode loop shared by [`decode_frame`] and [`decode_frame_subtract`].
///
/// `osd_score_min` — minimum coarse-sync score required for OSD fallback.
/// `known`         — messages already decoded in earlier passes (skipped).
fn decode_frame_inner(
    audio: &[i16],
    freq_min: f32,
    freq_max: f32,
    sync_min: f32,
    freq_hint: Option<f32>,
    depth: DecodeDepth,
    max_cand: usize,
    osd_score_min: f32,
    known: &[DecodeResult],
    eq_mode: EqMode,
) -> Vec<DecodeResult> {
    let candidates = coarse_sync(audio, freq_min, freq_max, sync_min, freq_hint, max_cand);
    if candidates.is_empty() {
        return Vec::new();
    }

    let fft_cache = build_fft_cache(audio);

    #[cfg(feature = "parallel")]
    let raw: Vec<DecodeResult> = candidates
        .par_iter()
        .filter_map(|cand| process_candidate(cand, audio, &fft_cache, depth, osd_score_min, known, eq_mode, None))
        .collect();
    #[cfg(not(feature = "parallel"))]
    let raw: Vec<DecodeResult> = candidates
        .iter()
        .filter_map(|cand| process_candidate(cand, audio, &fft_cache, depth, osd_score_min, known, eq_mode, None))
        .collect();

    // Deduplicate: preserve first occurrence; drop messages already in `known`.
    let mut results: Vec<DecodeResult> = Vec::new();
    for r in raw {
        if !known.iter().any(|k| k.message77 == r.message77)
            && !results.iter().any(|x| x.message77 == r.message77)
        {
            results.push(r);
        }
    }
    results
}

// ────────────────────────────────────────────────────────────────────────────
// Multi-pass decode with signal subtraction

/// Decode a 15-second FT8 frame using successive signal subtraction.
///
/// Runs three decode passes with decreasing sync thresholds.  After each
/// pass every newly decoded signal is subtracted from the residual audio,
/// revealing weaker signals that were previously hidden.
///
/// | Pass | sync_min factor | OSD score min | Purpose |
/// |------|----------------|---------------|---------|
/// | 1    | 1.0×           | 2.5           | Strong signals (BP + OSD) |
/// | 2    | 0.75×          | 2.5           | Medium signals on residual |
/// | 3    | 0.5×           | 2.0           | Weak / spurious signals |
///
/// Pass 3 uses a lower OSD score threshold (`2.0` vs the normal `2.5`) to
/// also subtract signals that are marginal but have valid CRC — even if they
/// were questionable in the original audio, subtracting their reconstructed
/// waveform from the already-cleaned residual does more good than harm.
pub fn decode_frame_subtract(
    audio: &[i16],
    freq_min: f32,
    freq_max: f32,
    sync_min: f32,
    freq_hint: Option<f32>,
    depth: DecodeDepth,
    max_cand: usize,
) -> Vec<DecodeResult> {
    let mut residual = audio.to_vec();
    let mut all_results: Vec<DecodeResult> = Vec::new();

    // (sync_min_factor, osd_score_min)
    let passes: &[(f32, f32)] = &[(1.0, 2.5), (0.75, 2.5), (0.5, 2.0)];

    for &(factor, osd_score_min) in passes {
        let new = decode_frame_inner(
            &residual,
            freq_min, freq_max,
            sync_min * factor,
            freq_hint, depth, max_cand,
            osd_score_min,
            &all_results,
            EqMode::Off,
        );

        for r in &new {
            // QSB gate: if Costas-array power CV > 0.3 the channel is time-varying
            // and the amplitude estimate is less accurate — use half gain to avoid
            // over-subtraction artefacts that would corrupt later passes.
            let sub_gain = if r.sync_cv > 0.3 { 0.5 } else { 1.0 };
            subtract_signal_weighted(&mut residual, r, sub_gain);
        }
        all_results.extend(new);
    }

    all_results
}

// ────────────────────────────────────────────────────────────────────────────
// Convenience: sniper-mode decode (single target frequency, narrow band)

/// Sniper-mode decode: search only within ±250 Hz of `target_freq`.
///
/// Intended for use after a 500 Hz hardware BPF.  The search band is
/// narrowed to `target_freq ± 250 Hz` and `sync_min` is lowered to 0.8
/// because the BPF removes strong adjacent signals that would otherwise
/// raise the noise floor.
///
/// `sync_cv` (Costas-array power coefficient of variation) is computed for
/// each decoded result and can be used downstream as a channel-quality
/// indicator for the Phase 3 adaptive equaliser.
pub fn decode_sniper(
    audio: &[i16],
    target_freq: f32,
    depth: DecodeDepth,
    max_cand: usize,
) -> Vec<DecodeResult> {
    decode_sniper_eq(audio, target_freq, depth, max_cand, EqMode::Off)
}

/// Sniper-mode decode with configurable equalizer.
///
/// Same as [`decode_sniper`] but allows enabling the adaptive equalizer
/// to correct BPF edge distortion.
pub fn decode_sniper_eq(
    audio: &[i16],
    target_freq: f32,
    depth: DecodeDepth,
    max_cand: usize,
    eq_mode: EqMode,
) -> Vec<DecodeResult> {
    decode_sniper_ap(audio, target_freq, depth, max_cand, eq_mode, None)
}

/// Sniper-mode decode with equalizer and A Priori hints.
///
/// The full sniper pipeline: hardware BPF simulation + adaptive EQ +
/// AP-assisted BP decode.  When `ap_hint` provides known callsigns,
/// the BP decoder locks those bits at high confidence, effectively
/// reducing the number of unknown bits and lowering the decode threshold.
///
/// # Example
/// ```ignore
/// let ap = ApHint::new().with_call1("CQ").with_call2("3Y0Z");
/// let results = decode_sniper_ap(
///     &audio, 1000.0, DecodeDepth::BpAllOsd, 20,
///     EqMode::Adaptive, Some(&ap),
/// );
/// ```
pub fn decode_sniper_ap(
    audio: &[i16],
    target_freq: f32,
    depth: DecodeDepth,
    max_cand: usize,
    eq_mode: EqMode,
    ap_hint: Option<&ApHint>,
) -> Vec<DecodeResult> {
    let freq_min = (target_freq - 250.0).max(100.0);
    let freq_max = (target_freq + 250.0).min(5900.0);
    let sync_min = 0.8;

    let candidates = coarse_sync(audio, freq_min, freq_max, sync_min, Some(target_freq), max_cand);
    if candidates.is_empty() {
        return Vec::new();
    }

    let fft_cache = build_fft_cache(audio);

    #[cfg(feature = "parallel")]
    let raw: Vec<DecodeResult> = candidates
        .par_iter()
        .filter_map(|cand| process_candidate(cand, audio, &fft_cache, depth, 2.5, &[], eq_mode, ap_hint))
        .collect();
    #[cfg(not(feature = "parallel"))]
    let raw: Vec<DecodeResult> = candidates
        .iter()
        .filter_map(|cand| process_candidate(cand, audio, &fft_cache, depth, 2.5, &[], eq_mode, ap_hint))
        .collect();

    let mut results: Vec<DecodeResult> = Vec::new();
    for r in raw {
        if !results.iter().any(|x| x.message77 == r.message77) {
            results.push(r);
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

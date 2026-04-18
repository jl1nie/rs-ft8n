//! Minimal FT4 decode pipeline: coarse sync → fine sync → LLR → BP decode.
//!
//! Intentionally scoped smaller than `ft8-core::decode` — no AP hints, no
//! successive-interference-cancellation subtract, no sniper single-frequency
//! entry points. Those can be added later; the goal here is to validate that
//! FT4 works end-to-end through the generic mfsk-core primitives.

use crate::Ft4;
use mfsk_core::dsp::downsample::{DownsampleCfg, build_fft_cache, downsample_cached};
use mfsk_core::llr::{compute_llr, compute_snr_db, symbol_spectra, sync_quality};
use mfsk_core::sync::{SyncCandidate, coarse_sync, refine_candidate};
use mfsk_core::{FecCodec, FecOpts, FrameLayout, MessageCodec, ModulationParams, Protocol};
use mfsk_msg::{CallsignHashTable, Wsjt77Message, wsjt77};
use num_complex::Complex;

/// FT4 downsample configuration: 12 kHz → ~666.7 Hz baseband, covering four
/// tones spaced 20.833 Hz apart plus headroom.
pub const FT4_DOWNSAMPLE: DownsampleCfg = DownsampleCfg {
    input_rate: 12_000,
    // Highly-composite FFT length ≥ slot-audio length (7.5 s × 12 kHz = 90 000).
    // 92 160 = 2^12 × 45 = 2^12 × 3² × 5 — very FFT-friendly.
    fft1_size: 92_160,
    // fft2_size / fft1_size = 1 / NDOWN = 1/18 → 92160/18 = 5120.
    fft2_size: 5_120,
    tone_spacing_hz: 20.833,
    leading_pad_tones: 1.5,
    trailing_pad_tones: 1.5,
    ntones: 4,
    edge_taper_bins: 101,
};

/// One successfully decoded FT4 message.
#[derive(Debug, Clone)]
pub struct DecodeResult {
    pub message77: [u8; 77],
    pub text: String,
    pub freq_hz: f32,
    pub dt_sec: f32,
    pub hard_errors: u32,
    pub snr_db: f32,
    pub sync_score: f32,
    pub pass: u8,
}

/// Decode an FT4 slot of 12 kHz PCM audio. Length must match the FT4 slot
/// (≈ 7.5 s of audio, but the routine tolerates any length ≥ 90 000 samples).
pub fn decode_frame(
    audio: &[i16],
    freq_min: f32,
    freq_max: f32,
    sync_min: f32,
    max_cand: usize,
) -> Vec<DecodeResult> {
    let n_sym = <Ft4 as FrameLayout>::N_SYMBOLS as usize;
    let ntones = <Ft4 as ModulationParams>::NTONES as usize;
    let fft_cache = build_fft_cache(audio, &FT4_DOWNSAMPLE);

    let cands = coarse_sync::<Ft4>(audio, freq_min, freq_max, sync_min, None, max_cand);
    let mut results: Vec<DecodeResult> = Vec::new();
    let mut ht = CallsignHashTable::new();
    let msg_codec = Wsjt77Message::default();

    for cand in cands {
        if let Some(r) = process_candidate(&cand, &fft_cache, n_sym, ntones, &msg_codec, &mut ht) {
            results.push(r);
        }
    }
    results
}

fn process_candidate(
    cand: &SyncCandidate,
    fft_cache: &[Complex<f32>],
    n_sym: usize,
    ntones: usize,
    msg_codec: &Wsjt77Message,
    ht: &mut CallsignHashTable,
) -> Option<DecodeResult> {
    let cd0 = downsample_cached(fft_cache, cand.freq_hz, &FT4_DOWNSAMPLE);
    // FT4's coarse sync uses 1-symbol (48 ms = 32 downsampled-sample) steps;
    // refine across ±1 symbol to bridge the coarse-grid quantisation.
    let refined = refine_candidate::<Ft4>(&cd0, cand, 32);

    let ds_rate = 12_000.0 / <Ft4 as ModulationParams>::NDOWN as f32;
    let tx_start = <Ft4 as FrameLayout>::TX_START_OFFSET_S;
    let i_start = ((refined.dt_sec + tx_start) * ds_rate).round() as usize;

    let cs = symbol_spectra::<Ft4>(&cd0, i_start);
    let nsync = sync_quality::<Ft4>(&cs);
    // FT4 has 16 sync symbols; require at least half correct to proceed.
    if nsync < (<Ft4 as FrameLayout>::N_SYNC / 2) as u32 {
        return None;
    }

    let llr_set = compute_llr::<Ft4>(&cs);
    let fec = <Ft4 as Protocol>::Fec::default();
    let opts = FecOpts { bp_max_iter: 30, osd_depth: 2, ap_mask: None };

    for (variant_idx, llr) in [&llr_set.llra, &llr_set.llrb, &llr_set.llrc, &llr_set.llrd]
        .iter()
        .enumerate()
    {
        if let Some(res) = fec.decode_soft(llr, &opts) {
            // info is 91 bits: 77 message + 14 CRC.
            let msg77: [u8; 77] = res.info[..77].try_into().ok()?;
            let itone = crate::encode::message_to_tones(&msg77);
            if itone.len() != n_sym {
                continue;
            }
            let snr_db = compute_snr_db::<Ft4>(&cs, &itone);

            let ctx = mfsk_core::DecodeContext {
                callsign_hash_table: Some(std::sync::Arc::new(ht.clone())),
            };
            let text = match msg_codec.unpack(&msg77, &ctx) {
                Some(t) if !t.is_empty() => t,
                _ => continue,
            };

            // Register decoded callsigns for subsequent hash lookups.
            if let Some(call) = wsjt77::unpack77_with_hash(&msg77, ht) {
                for word in call.split_whitespace() {
                    if word.len() >= 2 && !word.starts_with('<') {
                        ht.insert(word);
                    }
                }
            }

            return Some(DecodeResult {
                message77: msg77,
                text,
                freq_hz: cand.freq_hz,
                dt_sec: refined.dt_sec,
                hard_errors: res.hard_errors,
                snr_db,
                sync_score: refined.score,
                pass: variant_idx as u8,
            });
        }
    }
    let _ = ntones;
    None
}

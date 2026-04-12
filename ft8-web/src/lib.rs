use wasm_bindgen::prelude::*;
use ft8_core::decode::{
    decode_frame, decode_frame_subtract, decode_frame_subtract_with_known,
    decode_frame_with_cache, DecodeDepth, DecodeStrictness, FftCache,
};
use ft8_core::hash_table::CallsignHashTable;
use ft8_core::message::{unpack77_with_hash, is_plausible_message};
use ft8_core::resample::{resample_to_12k, resample_f32_to_12k};

use std::cell::RefCell;

thread_local! {
    static HASH_TABLE: RefCell<CallsignHashTable> = RefCell::new(CallsignHashTable::new());
    /// Cached resampled audio from Phase 1 (reused by Phase 2).
    static CACHED_AUDIO: RefCell<Option<Vec<i16>>> = RefCell::new(None);
    /// Cached 192k-point FFT from Phase 1 (reused by Phase 2 pass 1).
    static CACHED_FFT: RefCell<Option<FftCache>> = RefCell::new(None);
    /// Phase 1 decode results (passed as `known` to Phase 2).
    static CACHED_PHASE1: RefCell<Vec<ft8_core::decode::DecodeResult>> = RefCell::new(Vec::new());
}

#[wasm_bindgen]
#[derive(Clone)]
pub struct DecodedMessage {
    pub freq_hz: f32,
    pub dt_sec: f32,
    pub snr_db: f32,
    pub hard_errors: u32,
    pub pass: u8,
    message: String,
}

#[wasm_bindgen]
impl DecodedMessage {
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }
}

fn to_decoded(r: ft8_core::decode::DecodeResult) -> Option<DecodedMessage> {
    HASH_TABLE.with(|ht| {
        let ht = ht.borrow();
        let text = unpack77_with_hash(&r.message77, &ht)?;
        if text.is_empty() { return None; }
        if !is_plausible_message(&text) { return None; }
        Some(DecodedMessage {
            freq_hz: r.freq_hz,
            dt_sec: r.dt_sec,
            snr_db: r.snr_db,
            hard_errors: r.hard_errors,
            pass: r.pass,
            message: text,
        })
    })
}

fn register_callsigns(text: &str) {
    HASH_TABLE.with(|ht| {
        let mut ht = ht.borrow_mut();
        for word in text.split_whitespace() {
            if matches!(word, "CQ" | "DE" | "QRZ" | "DX" | "RRR" | "RR73" | "73" | "R" | "") {
                continue;
            }
            if word.starts_with("CQ") { continue; }
            if word.starts_with('<') || word.starts_with('+') || word.starts_with('-')
                || word.starts_with("R+") || word.starts_with("R-") { continue; }
            if word.len() == 4 {
                let b = word.as_bytes();
                if b[0].is_ascii_uppercase() && b[1].is_ascii_uppercase()
                    && b[2].is_ascii_digit() && b[3].is_ascii_digit() {
                    continue;
                }
            }
            if word.starts_with('[') { continue; }
            ht.insert(word);
        }
    });
}

fn to_strictness(level: u8) -> DecodeStrictness {
    match level {
        0 => DecodeStrictness::Strict,
        2 => DecodeStrictness::Deep,
        _ => DecodeStrictness::Normal,
    }
}

fn decode_and_register(results: Vec<ft8_core::decode::DecodeResult>) -> Vec<DecodedMessage> {
    let mut out = Vec::new();
    for r in results {
        if let Some(dm) = to_decoded(r) {
            register_callsigns(&dm.message);
            out.push(dm);
        }
    }
    out
}

/// Decode a 15-second FT8 audio frame (wide-band scan).
///
/// `sample_rate` — input PCM sample rate in Hz (e.g. 12000, 44100, 48000).
/// Non-12 000 Hz input is automatically resampled before decoding.
#[wasm_bindgen]
pub fn decode_wav(samples: &[i16], strictness: u8, sample_rate: u32) -> Vec<DecodedMessage> {
    // strictness is currently unused for non-subtract decode (BP-only path has no OSD gate)
    let _ = strictness;
    let audio = if sample_rate != 12000 { resample_to_12k(samples, sample_rate) } else { samples.to_vec() };
    decode_and_register(
        decode_frame(&audio, 100.0, 3000.0, 1.5, None, DecodeDepth::BpAllOsd, 200)
    )
}

/// Sniper-mode decode with multi-pass AP (single WASM call).
///
/// AP passes are handled internally by ft8-core (pass 6-11).
/// The deepest applicable pass is tried first based on available info:
/// Build an ApHint from the supplied AP target fields.
///
/// | callsign | grid | mycall | Hint built                            |
/// |----------|------|--------|---------------------------------------|
/// | empty    | empty| any    | None                                  |
/// | empty    | set  | any    | grid only                             |
/// | set      | any  | empty  | CQ + call2 [+ grid] (Watch phase)     |
/// | set      | any  | set    | mycall + call2       (Call phase)      |
fn build_ap_hint(callsign: &str, grid: &str, mycall: &str) -> Option<ft8_core::decode::ApHint> {
    use ft8_core::decode::ApHint;
    if callsign.is_empty() && grid.is_empty() {
        None
    } else if callsign.is_empty() {
        // grid only (no call known yet)
        Some(ApHint::new().with_grid(grid))
    } else if mycall.is_empty() {
        // Watch phase: CQ-style hint; add grid for stronger lock
        let mut h = ApHint::new().with_call1("CQ").with_call2(callsign);
        if !grid.is_empty() { h = h.with_grid(grid); }
        Some(h)
    } else {
        // Call phase: QSO hint (grid ignored — bits overlap with report field)
        Some(ApHint::new().with_call1(mycall).with_call2(callsign))
    }
}

///   mycall + dxcall + RRR/RR73/73 → 77-bit lock (passes 9-11)
///   CQ + dxcall + grid → up to 76-bit lock (passes 7/8)
///   mycall + dxcall → 61-bit lock (pass 8)
///   dxcall only → 33-bit lock (pass 6)
///   grid only → 15-bit lock (pass 6 fallback)
///
/// Pass `mycall = ""` for Watch phase (CQ-style hint + grid).
/// Pass `mycall = <own_call>` for Call phase (QSO hint, grid ignored).
#[wasm_bindgen]
pub fn decode_sniper(samples: &[i16], target_freq: f32, callsign: &str, grid: &str, mycall: &str, eq_on: bool, sample_rate: u32) -> Vec<DecodedMessage> {
    use ft8_core::decode::{decode_sniper_sic, EqMode};

    let eq_mode = if eq_on { EqMode::Adaptive } else { EqMode::Off };

    let ap = build_ap_hint(callsign, grid, mycall);

    let audio = if sample_rate != 12000 { resample_to_12k(samples, sample_rate) } else { samples.to_vec() };
    decode_and_register(
        decode_sniper_sic(
            &audio, target_freq, DecodeDepth::BpAllOsd, 20,
            eq_mode, ap.as_ref(),
        )
    )
}

#[wasm_bindgen]
pub fn encode_ft8(call1: &str, call2: &str, report: &str, freq_hz: f32) -> Result<Vec<f32>, JsValue> {
    use ft8_core::message::pack77;
    use ft8_core::wave_gen::{message_to_tones, tones_to_f32};

    let msg77 = pack77(call1, call2, report)
        .ok_or_else(|| JsValue::from_str("Failed to pack message"))?;
    let tones = message_to_tones(&msg77);
    Ok(tones_to_f32(&tones, freq_hz, 1.0))
}

/// Encode a free-text FT8 message (Type 0, n3=0) as audio samples.
///
/// `text` — up to 13 characters from the FT8 free-text alphabet.
#[wasm_bindgen]
pub fn encode_free_text(text: &str, freq_hz: f32) -> Result<Vec<f32>, JsValue> {
    use ft8_core::message::pack77_free_text;
    use ft8_core::wave_gen::{message_to_tones, tones_to_f32};

    let msg77 = pack77_free_text(text)
        .ok_or_else(|| JsValue::from_str("Invalid free text (max 13 chars, 0-9 A-Z +-./?)"))?;
    let tones = message_to_tones(&msg77);
    Ok(tones_to_f32(&tones, freq_hz, 1.0))
}

/// Decode with iterative signal subtraction.
///
/// `sample_rate` — input PCM sample rate in Hz. Non-12 000 Hz input is
/// automatically resampled before decoding.
#[wasm_bindgen]
pub fn decode_wav_subtract(samples: &[i16], strictness: u8, sample_rate: u32) -> Vec<DecodedMessage> {
    let audio = if sample_rate != 12000 { resample_to_12k(samples, sample_rate) } else { samples.to_vec() };
    decode_and_register(
        decode_frame_subtract(&audio, 100.0, 3000.0, 1.0, None, DecodeDepth::BpAllOsd, 200, to_strictness(strictness))
    )
}

// ──────────────────────────────────────────────────────────────────────────
// f32 entry points — used by the live AudioWorklet path so the JS side can
// pass a Float32Array directly without an intermediate i16 conversion loop
// (which on Atom-class CPUs costs ~5-10 ms per period and is pure waste).
// The conversion + resample + clamp now happens in one Rust pass.
// ──────────────────────────────────────────────────────────────────────────

/// f32 variant of `decode_wav`. See `decode_wav` for parameters.
#[wasm_bindgen]
pub fn decode_wav_f32(samples: &[f32], strictness: u8, sample_rate: u32) -> Vec<DecodedMessage> {
    let _ = strictness;
    let audio = resample_f32_to_12k(samples, sample_rate);
    decode_and_register(
        decode_frame(&audio, 100.0, 3000.0, 1.5, None, DecodeDepth::BpAllOsd, 200)
    )
}

/// f32 variant of `decode_wav_subtract`. See `decode_wav_subtract` for parameters.
#[wasm_bindgen]
pub fn decode_wav_subtract_f32(samples: &[f32], strictness: u8, sample_rate: u32) -> Vec<DecodedMessage> {
    let audio = resample_f32_to_12k(samples, sample_rate);
    decode_and_register(
        decode_frame_subtract(&audio, 100.0, 3000.0, 1.0, None, DecodeDepth::BpAllOsd, 200, to_strictness(strictness))
    )
}

/// f32 variant of `decode_sniper`. See `decode_sniper` for parameters.
#[wasm_bindgen]
pub fn decode_sniper_f32(samples: &[f32], target_freq: f32, callsign: &str, grid: &str, mycall: &str, eq_on: bool, sample_rate: u32) -> Vec<DecodedMessage> {
    use ft8_core::decode::{decode_sniper_sic, EqMode};

    let eq_mode = if eq_on { EqMode::Adaptive } else { EqMode::Off };

    let ap = build_ap_hint(callsign, grid, mycall);

    let audio = resample_f32_to_12k(samples, sample_rate);
    decode_and_register(
        decode_sniper_sic(
            &audio, target_freq, DecodeDepth::BpAllOsd, 20,
            eq_mode, ap.as_ref(),
        )
    )
}

// ──────────────────────────────────────────────────────────────────────────
// Pipelined decode: Phase 1 (fast) + Phase 2 (deep subtract)
//
// Phase 1 decodes strong signals quickly and caches audio + FFT in
// thread_local storage.  Phase 2 reuses the cache, runs 3-pass subtract,
// and returns only the newly decoded messages.
// ──────────────────────────────────────────────────────────────────────────

/// Phase 1 decode (i16): fast single-pass decode.
///
/// Caches the resampled audio and FFT for a subsequent `decode_phase2` call.
#[wasm_bindgen]
pub fn decode_phase1(samples: &[i16], sample_rate: u32) -> Vec<DecodedMessage> {
    let audio = if sample_rate != 12000 { resample_to_12k(samples, sample_rate) } else { samples.to_vec() };
    let (results, fft_cache) = decode_frame_with_cache(
        &audio, 100.0, 3000.0, 1.5, None, DecodeDepth::BpAllOsd, 200,
    );
    CACHED_AUDIO.with(|a| *a.borrow_mut() = Some(audio));
    CACHED_FFT.with(|f| *f.borrow_mut() = Some(fft_cache));
    CACHED_PHASE1.with(|p| *p.borrow_mut() = results.clone());
    decode_and_register(results)
}

/// Phase 2 decode (i16): 3-pass subtract using cached Phase 1 state.
///
/// Panics if `decode_phase1` was not called first.
#[wasm_bindgen]
pub fn decode_phase2(strictness: u8) -> Vec<DecodedMessage> {
    let audio = CACHED_AUDIO.with(|a| a.borrow_mut().take())
        .expect("decode_phase1 must run first");
    let fft = CACHED_FFT.with(|f| f.borrow_mut().take());
    let known = CACHED_PHASE1.with(|p| std::mem::take(&mut *p.borrow_mut()));
    decode_and_register(
        decode_frame_subtract_with_known(
            &audio, 100.0, 3000.0, 1.0, None,
            DecodeDepth::BpAllOsd, 200, to_strictness(strictness),
            &known, fft,
        )
    )
}

/// Phase 1 decode (f32): fast single-pass decode for live AudioWorklet path.
///
/// Caches the resampled audio and FFT for a subsequent `decode_phase2_f32` call.
#[wasm_bindgen]
pub fn decode_phase1_f32(samples: &[f32], sample_rate: u32) -> Vec<DecodedMessage> {
    let audio = resample_f32_to_12k(samples, sample_rate);
    let (results, fft_cache) = decode_frame_with_cache(
        &audio, 100.0, 3000.0, 1.5, None, DecodeDepth::BpAllOsd, 200,
    );
    CACHED_AUDIO.with(|a| *a.borrow_mut() = Some(audio));
    CACHED_FFT.with(|f| *f.borrow_mut() = Some(fft_cache));
    CACHED_PHASE1.with(|p| *p.borrow_mut() = results.clone());
    decode_and_register(results)
}

/// Phase 2 decode (f32): 3-pass subtract using cached Phase 1 state.
///
/// Panics if `decode_phase1_f32` was not called first.
#[wasm_bindgen]
pub fn decode_phase2_f32(strictness: u8) -> Vec<DecodedMessage> {
    let audio = CACHED_AUDIO.with(|a| a.borrow_mut().take())
        .expect("decode_phase1_f32 must run first");
    let fft = CACHED_FFT.with(|f| f.borrow_mut().take());
    let known = CACHED_PHASE1.with(|p| std::mem::take(&mut *p.borrow_mut()));
    decode_and_register(
        decode_frame_subtract_with_known(
            &audio, 100.0, 3000.0, 1.0, None,
            DecodeDepth::BpAllOsd, 200, to_strictness(strictness),
            &known, fft,
        )
    )
}

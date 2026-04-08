use wasm_bindgen::prelude::*;
use ft8_core::decode::{decode_frame, decode_frame_subtract, DecodeDepth, DecodeStrictness};
use ft8_core::hash_table::CallsignHashTable;
use ft8_core::message::{unpack77_with_hash, is_plausible_message};
use ft8_core::resample::resample_to_12k;

use std::cell::RefCell;

thread_local! {
    static HASH_TABLE: RefCell<CallsignHashTable> = RefCell::new(CallsignHashTable::new());
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
///   mycall + dxcall + RRR/RR73/73 → 77-bit lock (passes 9-11)
///   CQ + dxcall → 61-bit lock (pass 7)
///   mycall + dxcall → 61-bit lock (pass 8)
///   dxcall only → 33-bit lock (pass 6)
#[wasm_bindgen]
pub fn decode_sniper(samples: &[i16], target_freq: f32, callsign: &str, mycall: &str, eq_on: bool, sample_rate: u32) -> Vec<DecodedMessage> {
    use ft8_core::decode::{decode_sniper_ap, EqMode, ApHint};

    let eq_mode = if eq_on { EqMode::Adaptive } else { EqMode::Off };

    let ap = if callsign.is_empty() {
        None
    } else if mycall.is_empty() {
        Some(ApHint::new().with_call1("CQ").with_call2(callsign))
    } else {
        Some(ApHint::new().with_call1(mycall).with_call2(callsign))
    };

    let audio = if sample_rate != 12000 { resample_to_12k(samples, sample_rate) } else { samples.to_vec() };
    decode_and_register(
        decode_sniper_ap(
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

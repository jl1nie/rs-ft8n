use wasm_bindgen::prelude::*;
use ft8_core::decode::{decode_frame, decode_frame_subtract, DecodeDepth};
use ft8_core::hash_table::CallsignHashTable;
use ft8_core::message::{unpack77_with_hash, is_plausible_message};

use std::cell::RefCell;

thread_local! {
    /// Global callsign hash table, persists across decode calls.
    /// Populated as callsigns are decoded; used to resolve `<...>` placeholders.
    static HASH_TABLE: RefCell<CallsignHashTable> = RefCell::new(CallsignHashTable::new());
}

/// Single decoded FT8 message (returned to JS).
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

/// Register decoded callsigns in the hash table.
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
            // 4-char grid locator
            if word.len() == 4 {
                let b = word.as_bytes();
                if b[0].is_ascii_uppercase() && b[1].is_ascii_uppercase()
                    && b[2].is_ascii_digit() && b[3].is_ascii_digit() {
                    continue;
                }
            }
            // Tags like [FD], [RTTY]
            if word.starts_with('[') { continue; }
            ht.insert(word);
        }
    });
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

/// Decode FT8 from 12 kHz 16-bit mono PCM samples (single-pass).
#[wasm_bindgen]
pub fn decode_wav(samples: &[i16]) -> Vec<DecodedMessage> {
    decode_and_register(
        decode_frame(samples, 100.0, 3000.0, 1.5, None, DecodeDepth::BpAllOsd, 200)
    )
}

/// Sniper-mode decode: ±250 Hz around target_freq, with optional EQ + AP.
///
/// `target_freq` — center frequency in Hz (e.g. 1000.0)
/// `callsign` — target callsign for AP (empty string = no AP)
#[wasm_bindgen]
pub fn decode_sniper(samples: &[i16], target_freq: f32, callsign: &str) -> Vec<DecodedMessage> {
    use ft8_core::decode::{decode_sniper_ap, EqMode, ApHint};

    let ap = if callsign.is_empty() {
        None
    } else {
        Some(ApHint::new().with_call2(callsign))
    };

    decode_and_register(
        decode_sniper_ap(
            samples, target_freq, DecodeDepth::BpAllOsd, 20,
            EqMode::Adaptive, ap.as_ref(),
        )
    )
}

/// Encode an FT8 message to audio waveform (12 kHz f32 PCM).
#[wasm_bindgen]
pub fn encode_ft8(call1: &str, call2: &str, report: &str, freq_hz: f32) -> Result<Vec<f32>, JsValue> {
    use ft8_core::message::pack77;
    use ft8_core::wave_gen::{message_to_tones, tones_to_f32};

    let msg77 = pack77(call1, call2, report)
        .ok_or_else(|| JsValue::from_str("Failed to pack message"))?;
    let tones = message_to_tones(&msg77);
    Ok(tones_to_f32(&tones, freq_hz, 1.0))
}

/// Decode FT8 with multi-pass signal subtraction (3-pass).
#[wasm_bindgen]
pub fn decode_wav_subtract(samples: &[i16]) -> Vec<DecodedMessage> {
    decode_and_register(
        decode_frame_subtract(samples, 100.0, 3000.0, 1.0, None, DecodeDepth::BpAllOsd, 200)
    )
}

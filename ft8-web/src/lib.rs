use wasm_bindgen::prelude::*;
use ft8_core::decode::{decode_frame, decode_frame_subtract, DecodeDepth};
use ft8_core::message::unpack77;

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

/// Decode FT8 from 12 kHz 16-bit mono PCM samples (single-pass).
///
/// Pass an `Int16Array` from JS.  Returns an array of `DecodedMessage`.
#[wasm_bindgen]
pub fn decode_wav(samples: &[i16]) -> Vec<DecodedMessage> {
    let results = decode_frame(
        samples,
        200.0, 2800.0,
        1.5,
        None,
        DecodeDepth::BpAllOsd,
        200,
    );
    results.into_iter().map(|r| {
        let text = unpack77(&r.message77).unwrap_or_default();
        DecodedMessage {
            freq_hz: r.freq_hz,
            dt_sec: r.dt_sec,
            snr_db: r.snr_db,
            hard_errors: r.hard_errors,
            pass: r.pass,
            message: text,
        }
    }).collect()
}

/// Decode FT8 with multi-pass signal subtraction (3-pass).
#[wasm_bindgen]
pub fn decode_wav_subtract(samples: &[i16]) -> Vec<DecodedMessage> {
    let results = decode_frame_subtract(
        samples,
        200.0, 2800.0,
        1.0,
        None,
        DecodeDepth::BpAllOsd,
        200,
    );
    results.into_iter().map(|r| {
        let text = unpack77(&r.message77).unwrap_or_default();
        DecodedMessage {
            freq_hz: r.freq_hz,
            dt_sec: r.dt_sec,
            snr_db: r.snr_db,
            hard_errors: r.hard_errors,
            pass: r.pass,
            message: text,
        }
    }).collect()
}

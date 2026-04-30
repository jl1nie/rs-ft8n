// SPDX-License-Identifier: GPL-3.0-or-later
//! wasm-bindgen surface — TX/RX of signed QSL / ADV cards over uvpacket
//! audio, plus key generation and address derivation helpers exposed to
//! the JS side.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use wasm_bindgen::prelude::*;

extern crate alloc;

use mfsk_core::uvpacket::framing::{FrameHeader, MAX_PAYLOAD_BYTES};
use mfsk_core::uvpacket::puncture::Mode;
use mfsk_core::uvpacket::rx::{MultiChannelOpts, SlotEnergy};
use mfsk_core::uvpacket::{rx, tx};

/// Returns "uvpacket-web <ver> / mfsk-core <ver>" so the JS side can
/// confirm which mfsk-core actually got linked into the deployed wasm
/// (avoids the [patch.crates-io] cache-miss class of bug).
#[wasm_bindgen]
pub fn version_info() -> String {
    format!(
        "uvpacket-web {} / mfsk-core {}",
        env!("CARGO_PKG_VERSION"),
        mfsk_core::VERSION,
    )
}

/// Diagnostic: returns `[global_max, median, ratio, n_scores]` for
/// the differential preamble-correlation distribution that
/// mfsk-core's auto-detect decoder computes internally across the
/// 4-variant preamble catalogue. `ratio = global_max / median` is
/// the quantity the sync gate compares against its internal
/// threshold. Empty vector if the buffer is too short.
///
/// (0.4.0: replaces the old single-preamble coherence-ratio
/// statistic with the multi-variant differential one. Schema
/// `[max, median, ratio, n_scores]` is unchanged.)
#[wasm_bindgen]
pub fn diag_sync_stats(samples: &[f32], audio_centre_hz: f32) -> Vec<f32> {
    match rx::diag_sync_at(samples, audio_centre_hz) {
        Some((_mode, s)) => vec![s.global_max, s.median, s.ratio, s.n_scores as f32],
        None => Vec::new(),
    }
}

/// Pre-AFC vs post-AFC sync stats + estimated delta_f, packed as
/// `[pre_max, pre_median, pre_ratio, delta_f,
///   post_max, post_median, post_ratio]`.
///
/// (0.4.0: rebuilt on the new 4-variant preamble catalogue. The
/// `delta_f` step uses the winning preamble's mode for AFC search;
/// post-AFC stats are evaluated at `audio_centre_hz + delta_f`.)
///
/// Empty vector if the buffer is too short for a sync evaluation.
#[wasm_bindgen]
pub fn diag_sync_with_afc(samples: &[f32], audio_centre_hz: f32) -> Vec<f32> {
    let Some((mode, pre)) = rx::diag_sync_at(samples, audio_centre_hz) else {
        return Vec::new();
    };
    let afc_opts = rx::AfcOpts::default();
    let df = rx::diag_estimate_freq_offset(samples, 0, audio_centre_hz, mode, &afc_opts)
        .unwrap_or(0.0);
    let post = rx::diag_sync_at(samples, audio_centre_hz + df)
        .map(|(_, s)| s)
        .unwrap_or(pre);
    vec![
        pre.global_max,
        pre.median,
        pre.ratio,
        df,
        post.global_max,
        post.median,
        post.ratio,
    ]
}

use crate::address::{Addresses, derive_all};
use crate::card::{
    AdvCard, DecodedCard, QslCard, build_adv_json, build_qsl_json, parse_card,
};
use crate::monacoin::{SIG_B64_LEN, sign_message, verify_recover};

/// `app_type` (4-bit) value for signed-QSL v1 frames.
pub const APP_TYPE_QSL_V1: u8 = 0x1;
/// `app_type` (4-bit) value for ADV (advertisement) v1 frames.
pub const APP_TYPE_ADV_V1: u8 = 0x2;

fn mode_from_u8(m: u8) -> Result<Mode, JsValue> {
    // 0.4.x mode codes match `Mode::header_code()`:
    //   0 = UltraRobust, 1 = Robust, 2 = Standard, 3 = Express.
    // This replaces the 0.3.x mapping (0=Robust, 1=Standard,
    // 2=Fast, 3=Express); JS callers passing the old mapping need
    // to be updated.
    Mode::from_header_code(m).ok_or_else(|| JsValue::from_str("mode must be 0..3"))
}

fn pick_block_count(payload_len: usize) -> Result<u8, JsValue> {
    // 0.4.0: dedicated header LDPC block carries the 4-byte header
    // separately, so payload bytes pack into payload-only blocks at
    // 12 byte each — no header subtraction. Capacity = 32 * 12 = 384.
    // → block_count = ceil(payload_len / 12), clamped to 1..=32.
    if payload_len > MAX_PAYLOAD_BYTES {
        return Err(JsValue::from_str("payload exceeds 384 bytes"));
    }
    let needed = payload_len.div_ceil(12);
    Ok(needed.clamp(1, 32) as u8)
}

fn encode_signed_payload(
    json_bytes: &[u8],
    sig_b64: &str,
    app_type: u8,
    mode_code: u8,
    audio_centre_hz: f32,
    sequence: u8,
) -> Result<Vec<f32>, JsValue> {
    if sig_b64.len() != SIG_B64_LEN {
        return Err(JsValue::from_str("signature must be 88 base64 chars"));
    }
    let mode = mode_from_u8(mode_code)?;

    let mut payload = Vec::with_capacity(json_bytes.len() + sig_b64.len());
    payload.extend_from_slice(json_bytes);
    payload.extend_from_slice(sig_b64.as_bytes());

    let block_count = pick_block_count(payload.len())?;
    let header = FrameHeader {
        mode,
        block_count,
        app_type: app_type & 0x0F,
        sequence: sequence & 0x1F,
    };
    tx::encode(&header, &payload, audio_centre_hz)
        .map_err(|e| JsValue::from_str(&format!("uvpacket tx::encode: {:?}", e)))
}

// ─────────────────────────────────────────────────────────────────
// Card construction (exposed to JS as plain field setters via JS-side
// objects; we expose convenience builders below)
// ─────────────────────────────────────────────────────────────────

#[wasm_bindgen]
#[derive(Default, Clone)]
pub struct QslInput {
    fr: String,
    to: String,
    rs: String,
    date: String,
    time: String,
    freq: String,
    mode: String,
    qth: String,
}

#[wasm_bindgen]
impl QslInput {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn set_fr(&mut self, v: String) {
        self.fr = v;
    }
    pub fn set_to(&mut self, v: String) {
        self.to = v;
    }
    pub fn set_rs(&mut self, v: String) {
        self.rs = v;
    }
    pub fn set_date(&mut self, v: String) {
        self.date = v;
    }
    pub fn set_time(&mut self, v: String) {
        self.time = v;
    }
    pub fn set_freq(&mut self, v: String) {
        self.freq = v;
    }
    pub fn set_mode(&mut self, v: String) {
        self.mode = v;
    }
    pub fn set_qth(&mut self, v: String) {
        self.qth = v;
    }
}

impl From<&QslInput> for QslCard {
    fn from(i: &QslInput) -> Self {
        Self {
            fr: i.fr.clone(),
            to: i.to.clone(),
            rs: i.rs.clone(),
            date: i.date.clone(),
            time: i.time.clone(),
            freq: i.freq.clone(),
            mode: i.mode.clone(),
            qth: i.qth.clone(),
        }
    }
}

#[wasm_bindgen]
#[derive(Default, Clone)]
pub struct AdvInput {
    fr: String,
    name: String,
    bio: String,
    address: String,
}

#[wasm_bindgen]
impl AdvInput {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn set_fr(&mut self, v: String) {
        self.fr = v;
    }
    pub fn set_name(&mut self, v: String) {
        self.name = v;
    }
    pub fn set_bio(&mut self, v: String) {
        self.bio = v;
    }
    pub fn set_address(&mut self, v: String) {
        self.address = v;
    }
}

impl From<&AdvInput> for AdvCard {
    fn from(i: &AdvInput) -> Self {
        Self {
            fr: i.fr.clone(),
            name: i.name.clone(),
            bio: i.bio.clone(),
            address: i.address.clone(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// TX entry points
// ─────────────────────────────────────────────────────────────────

fn parse_secret(secret_hex: &str) -> Result<[u8; 32], JsValue> {
    let bytes = hex_decode(secret_hex)
        .ok_or_else(|| JsValue::from_str("secret_hex must be 64 hex chars"))?;
    if bytes.len() != 32 {
        return Err(JsValue::from_str("secret must be 32 bytes"));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

#[wasm_bindgen]
pub fn encode_qsl_v1(
    card: &QslInput,
    secret_hex: &str,
    audio_centre_hz: f32,
    mode_code: u8,
    sequence: u8,
) -> Result<Vec<f32>, JsValue> {
    let secret = parse_secret(secret_hex)?;
    let qsl: QslCard = card.into();
    let json = build_qsl_json(&qsl);
    let sig = sign_message(json.as_bytes(), &secret, true)
        .map_err(|e| JsValue::from_str(&format!("sign: {:?}", e)))?;
    encode_signed_payload(
        json.as_bytes(),
        &sig,
        APP_TYPE_QSL_V1,
        mode_code,
        audio_centre_hz,
        sequence,
    )
}

#[wasm_bindgen]
pub fn encode_adv_v1(
    card: &AdvInput,
    secret_hex: &str,
    audio_centre_hz: f32,
    mode_code: u8,
    sequence: u8,
) -> Result<Vec<f32>, JsValue> {
    let secret = parse_secret(secret_hex)?;
    let adv: AdvCard = card.into();
    let json = build_adv_json(&adv);
    let sig = sign_message(json.as_bytes(), &secret, true)
        .map_err(|e| JsValue::from_str(&format!("sign: {:?}", e)))?;
    encode_signed_payload(
        json.as_bytes(),
        &sig,
        APP_TYPE_ADV_V1,
        mode_code,
        audio_centre_hz,
        sequence,
    )
}

/// Encode a pre-built signed payload (`<JSON><sig_b64>`). Useful when
/// the JS side wants to round-trip a pico_tnc-format payload pasted by
/// the user (e.g. via the `sign recovery` TTY command output).
#[wasm_bindgen]
pub fn encode_signed_raw(
    payload: &str,
    app_type: u8,
    audio_centre_hz: f32,
    mode_code: u8,
    sequence: u8,
) -> Result<Vec<f32>, JsValue> {
    if payload.len() < SIG_B64_LEN + 2 {
        return Err(JsValue::from_str("payload too short"));
    }
    // Find the JSON end (depth-0 closing brace).
    let bytes = payload.as_bytes();
    let json_end = find_json_end(bytes).ok_or_else(|| JsValue::from_str("no JSON found"))?;
    let sig = &payload[json_end..];
    if sig.len() != SIG_B64_LEN {
        return Err(JsValue::from_str("trailing signature must be 88 chars"));
    }
    let mode = mode_from_u8(mode_code)?;
    let block_count = pick_block_count(payload.len())?;
    let header = FrameHeader {
        mode,
        block_count,
        app_type: app_type & 0x0F,
        sequence: sequence & 0x1F,
    };
    tx::encode(&header, bytes, audio_centre_hz)
        .map_err(|e| JsValue::from_str(&format!("uvpacket tx::encode: {:?}", e)))
}

fn find_json_end(bytes: &[u8]) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, &c) in bytes.iter().enumerate() {
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────
// RX entry point
// ─────────────────────────────────────────────────────────────────

#[wasm_bindgen]
#[derive(Clone)]
pub struct DecodedSignedFrame {
    app_type: u8,
    sequence: u8,
    mode_code: u8,
    block_count: u8,
    audio_centre_hz: f32,
    json: String,
    sig_b64: String,
    verified: bool,
    addr_mona1: String,
    addr_m: String,
    addr_p: String,
    card_kind: String, // "QSL", "ADV", or ""
}

#[wasm_bindgen]
impl DecodedSignedFrame {
    #[wasm_bindgen(getter)]
    pub fn app_type(&self) -> u8 {
        self.app_type
    }
    #[wasm_bindgen(getter)]
    pub fn sequence(&self) -> u8 {
        self.sequence
    }
    #[wasm_bindgen(getter)]
    pub fn mode_code(&self) -> u8 {
        self.mode_code
    }
    #[wasm_bindgen(getter)]
    pub fn block_count(&self) -> u8 {
        self.block_count
    }
    /// Detected audio centre frequency (Hz). For the single-station FM
    /// decode path this matches the input centre; for the multichannel
    /// SSB path it is the centre picked by the coarse-grid scan.
    #[wasm_bindgen(getter)]
    pub fn audio_centre_hz(&self) -> f32 {
        self.audio_centre_hz
    }
    #[wasm_bindgen(getter)]
    pub fn json(&self) -> String {
        self.json.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn sig_b64(&self) -> String {
        self.sig_b64.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn verified(&self) -> bool {
        self.verified
    }
    #[wasm_bindgen(getter)]
    pub fn addr_mona1(&self) -> String {
        self.addr_mona1.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn addr_m(&self) -> String {
        self.addr_m.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn addr_p(&self) -> String {
        self.addr_p.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn card_kind(&self) -> String {
        self.card_kind.clone()
    }
}

fn frame_to_signed(f: rx::DecodedFrame, audio_centre_hz: f32) -> DecodedSignedFrame {
    let payload = f.payload;
    let mut out = DecodedSignedFrame {
        app_type: f.app_type,
        sequence: f.sequence,
        mode_code: f.mode.header_code(),
        block_count: f.block_count,
        audio_centre_hz,
        json: String::new(),
        sig_b64: String::new(),
        verified: false,
        addr_mona1: String::new(),
        addr_m: String::new(),
        addr_p: String::new(),
        card_kind: String::new(),
    };
    let Some(jend) = find_json_end(&payload) else {
        return out;
    };
    if payload.len() < jend + SIG_B64_LEN {
        return out;
    }
    let Ok(json) = core::str::from_utf8(&payload[..jend]) else {
        return out;
    };
    let Ok(sig) = core::str::from_utf8(&payload[jend..jend + SIG_B64_LEN]) else {
        return out;
    };
    out.json = json.to_string();
    out.sig_b64 = sig.to_string();

    if let Ok(rec) = verify_recover(json.as_bytes(), sig) {
        let addrs: Addresses = derive_all(&rec.pubkey);
        out.verified = true;
        out.addr_mona1 = addrs.mona1;
        out.addr_m = addrs.m;
        out.addr_p = addrs.p;
    }

    match parse_card(json) {
        Ok(DecodedCard::Qsl(_, _)) => out.card_kind = "QSL".to_string(),
        Ok(DecodedCard::Adv(_, _)) => out.card_kind = "ADV".to_string(),
        _ => {}
    }
    out
}

/// Single-station decode at a known audio centre. Suitable for **NFM**
/// receive (one station per RF channel, audio centre fixed at e.g.
/// 1500 Hz). Internally calls `mfsk_core::uvpacket::rx::decode`.
#[wasm_bindgen]
pub fn decode_uvpacket(samples: &[f32], audio_centre_hz: f32) -> Vec<DecodedSignedFrame> {
    rx::decode(samples, audio_centre_hz)
        .into_iter()
        .map(|f| frame_to_signed(f, audio_centre_hz))
        .collect()
}

/// Single-station decode constrained to a caller-supplied list of
/// `(mode_code, n_blocks)` layouts.
///
/// **Compatibility shim (0.4.0):** the new mfsk-core uvpacket
/// pipeline reads `(mode, n_blocks)` from the preamble + dedicated
/// header block in 1 + n_blocks LDPC decodes per frame, so the
/// `layouts` constraint is no longer load-bearing — the unconstrained
/// `decode` is already O(n_blocks) per peak. The function signature
/// is preserved for JS-side compatibility; `mode_codes` /
/// `n_blocks` are accepted but ignored.
#[wasm_bindgen]
pub fn decode_uvpacket_with_layouts(
    samples: &[f32],
    audio_centre_hz: f32,
    _mode_codes: Vec<u8>,
    _n_blocks: Vec<u8>,
) -> Vec<DecodedSignedFrame> {
    rx::decode(samples, audio_centre_hz)
        .into_iter()
        .map(|f| frame_to_signed(f, audio_centre_hz))
        .collect()
}

/// Multi-station decode by sweeping the SSB audio passband. Suitable
/// for **SSB** receive on a private group sharing one RF channel
/// (e.g., 430.090 MHz USB) where every TX picks an audio slot inside
/// the passband. Internally calls
/// `mfsk_core::uvpacket::rx::decode_multichannel`.
///
/// `band_lo_hz` / `band_hi_hz` define the search window
/// (typical 300–2700 Hz). `coarse_step_hz` defaults to 25 Hz when 0.
/// Returns one entry per detected frame; the detected audio centre is
/// available via `DecodedSignedFrame.audio_centre_hz`.
#[wasm_bindgen]
pub fn decode_uvpacket_multichannel(
    samples: &[f32],
    band_lo_hz: f32,
    band_hi_hz: f32,
    coarse_step_hz: f32,
    _peak_rel_threshold: f32, // ignored in 0.4.0 (internal sync gate)
    _mode_codes: Vec<u8>,     // ignored: preamble identifies mode
    _n_blocks: Vec<u8>,       // ignored: header block carries n_blocks
) -> Vec<DecodedSignedFrame> {
    let mc_opts = MultiChannelOpts {
        band_lo_hz,
        band_hi_hz,
        coarse_step_hz: if coarse_step_hz > 0.0 {
            coarse_step_hz
        } else {
            MultiChannelOpts::default().coarse_step_hz
        },
        ..MultiChannelOpts::default()
    };
    let fec_opts = mfsk_core::core::FecOpts {
        bp_max_iter: 50,
        osd_depth: 2,
        ap_mask: None,
        verify_info: None,
    };
    rx::decode_multichannel(samples, &mc_opts, &fec_opts)
        .into_iter()
        .map(|(centre, frame)| frame_to_signed(frame, centre))
        .collect()
}

/// Per-slot energy survey. Used by the SSB TX path before transmitting:
/// inspect the audio passband, find a slot with low matched-filter
/// energy, transmit there. Internally calls
/// `mfsk_core::uvpacket::rx::measure_slot_energies`.
///
/// `slot_spacing_hz` defines the slot grid (typical 1200 Hz so a 2.4 kHz
/// SSB passband fits 2 slots at 800/2000 Hz). Returns alternating
/// `[centre_hz, magnitude, centre_hz, magnitude, …]` pairs in a single
/// `Float32Array` for efficient JS interop.
#[wasm_bindgen]
pub fn measure_slots(
    samples: &[f32],
    band_lo_hz: f32,
    band_hi_hz: f32,
    slot_spacing_hz: f32,
) -> Vec<f32> {
    let mc_opts = MultiChannelOpts {
        band_lo_hz,
        band_hi_hz,
        ..MultiChannelOpts::default()
    };
    let energies: Vec<SlotEnergy> = rx::measure_slot_energies(samples, &mc_opts, slot_spacing_hz);
    let mut out = Vec::with_capacity(energies.len() * 2);
    for s in energies {
        out.push(s.audio_centre_hz);
        out.push(s.mean_mf_magnitude);
    }
    out
}

// ─────────────────────────────────────────────────────────────────
// Key / address helpers
// ─────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct KeyInfo {
    secret_hex: String,
    pubkey_hex: String,
    addr_mona1: String,
    addr_m: String,
    addr_p: String,
}

#[wasm_bindgen]
impl KeyInfo {
    #[wasm_bindgen(getter)]
    pub fn secret_hex(&self) -> String {
        self.secret_hex.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn pubkey_hex(&self) -> String {
        self.pubkey_hex.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn addr_mona1(&self) -> String {
        self.addr_mona1.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn addr_m(&self) -> String {
        self.addr_m.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn addr_p(&self) -> String {
        self.addr_p.clone()
    }
}

fn key_info_from_secret(secret: &[u8; 32]) -> Result<KeyInfo, JsValue> {
    use k256::ecdsa::SigningKey;
    let sk = SigningKey::from_bytes(secret.into())
        .map_err(|_| JsValue::from_str("invalid secret"))?;
    let vk = sk.verifying_key();
    let pubkey_pt = vk.to_encoded_point(true);
    let mut pubkey = [0u8; 33];
    pubkey.copy_from_slice(pubkey_pt.as_bytes());
    let addrs = derive_all(&pubkey);
    Ok(KeyInfo {
        secret_hex: hex_encode(secret),
        pubkey_hex: hex_encode(&pubkey),
        addr_mona1: addrs.mona1,
        addr_m: addrs.m,
        addr_p: addrs.p,
    })
}

#[wasm_bindgen]
pub fn keyinfo_from_secret_hex(secret_hex: &str) -> Result<KeyInfo, JsValue> {
    let secret = parse_secret(secret_hex)?;
    key_info_from_secret(&secret)
}

#[wasm_bindgen]
pub fn generate_key() -> Result<KeyInfo, JsValue> {
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).map_err(|_| JsValue::from_str("RNG failed"))?;
    // Reject the (vanishingly unlikely) all-zero / >n cases by retry.
    for _ in 0..16 {
        if k256::ecdsa::SigningKey::from_bytes((&secret).into()).is_ok() {
            return key_info_from_secret(&secret);
        }
        getrandom::getrandom(&mut secret).map_err(|_| JsValue::from_str("RNG failed"))?;
    }
    Err(JsValue::from_str("RNG produced invalid secrets repeatedly"))
}

// ─────────────────────────────────────────────────────────────────
// Hex utilities (JS interop, no dependency)
// ─────────────────────────────────────────────────────────────────

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0F) as usize] as char);
    }
    out
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for chunk in bytes.chunks(2) {
        let hi = nibble(chunk[0])?;
        let lo = nibble(chunk[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}


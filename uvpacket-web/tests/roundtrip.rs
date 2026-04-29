// SPDX-License-Identifier: GPL-3.0-or-later
//! End-to-end interop test: build a signed QSL JSON, encode through
//! mfsk-core's uvpacket TX, decode through uvpacket RX, verify the
//! signature recovers the same pubkey.
//!
//! This is the same path the WASM bindings expose to the browser, but
//! native so we can run it under `cargo test`.

use mfsk_core::uvpacket::framing::FrameHeader;
use mfsk_core::uvpacket::puncture::Mode;
use mfsk_core::uvpacket::{rx, tx};

use uvpacket_web::address::derive_all;
use uvpacket_web::card::{QslCard, build_qsl_json, parse_card, DecodedCard};
use uvpacket_web::monacoin::{SIG_B64_LEN, sign_message, verify_recover};

const APP_TYPE_QSL_V1: u8 = 0x1;
const AUDIO_CENTRE_HZ: f32 = 1500.0;

fn deterministic_secret() -> [u8; 32] {
    // Fixed test key — never reuse in production.
    [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E,
        0x1F, 0x20,
    ]
}

fn pubkey_for(secret: &[u8; 32]) -> [u8; 33] {
    use k256::ecdsa::SigningKey;
    let sk = SigningKey::from_bytes(secret.into()).unwrap();
    let vk = sk.verifying_key();
    let p = vk.to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(p.as_bytes());
    out
}

#[test]
fn signed_qsl_passes_clean_uvpacket_channel() {
    let card = QslCard {
        fr: "JL1NIE".into(),
        to: "JA1UMW".into(),
        rs: "59".into(),
        date: "2026-04-29".into(),
        time: "12:34".into(),
        freq: "430.090".into(),
        mode: "USB".into(),
        qth: "Tokyo".into(),
    };

    // 1. Build the canonical JSON payload.
    let json = build_qsl_json(&card);
    assert!(json.starts_with("{\"FR\":\"JL1NIE\",\"QSL\":"));

    // 2. Sign with a fixed secret.
    let secret = deterministic_secret();
    let sig = sign_message(json.as_bytes(), &secret, true).expect("sign");
    assert_eq!(sig.len(), SIG_B64_LEN);

    // 3. Build the wire payload <JSON><sig_b64>.
    let mut payload = Vec::with_capacity(json.len() + sig.len());
    payload.extend_from_slice(json.as_bytes());
    payload.extend_from_slice(sig.as_bytes());

    // 4. Encode through uvpacket TX. Pick the smallest block_count that fits.
    let block_count = (((payload.len() + 4) + 11) / 12).clamp(1, 32) as u8;
    let header = FrameHeader {
        mode: Mode::Standard,
        block_count,
        app_type: APP_TYPE_QSL_V1,
        sequence: 7,
    };
    let audio = tx::encode(&header, &payload, AUDIO_CENTRE_HZ).expect("uvpacket encode");
    assert!(!audio.is_empty());

    // 5. Decode through uvpacket RX (clean channel).
    let frames = rx::decode(&audio, AUDIO_CENTRE_HZ);
    assert_eq!(
        frames.len(),
        1,
        "expected exactly one frame on clean channel, got {}",
        frames.len()
    );
    let f = &frames[0];
    assert_eq!(f.app_type, APP_TYPE_QSL_V1);
    assert_eq!(f.sequence, 7);
    assert_eq!(f.block_count, block_count);
    // The receiver returns the full per-frame payload buffer including any
    // zero-padding to the LDPC block boundary; only the structural prefix
    // (`<JSON><88-char b64 sig>`) matters.
    assert!(f.payload.len() >= payload.len());
    assert_eq!(&f.payload[..payload.len()], payload.as_slice());

    // 6. Split payload back into JSON + sig.
    let json_end = f
        .payload
        .iter()
        .scan((0i32, false, false), |st, &c| {
            let (depth, in_str, esc) = *st;
            let new_st = if in_str {
                if esc {
                    (depth, in_str, false)
                } else if c == b'\\' {
                    (depth, in_str, true)
                } else if c == b'"' {
                    (depth, false, false)
                } else {
                    (depth, in_str, false)
                }
            } else if c == b'"' {
                (depth, true, false)
            } else if c == b'{' {
                (depth + 1, in_str, false)
            } else if c == b'}' {
                (depth - 1, in_str, false)
            } else {
                (depth, in_str, false)
            };
            *st = new_st;
            Some(new_st.0)
        })
        .position(|d| d == 0)
        .map(|i| i + 1)
        .expect("JSON terminator");
    let json_back = std::str::from_utf8(&f.payload[..json_end]).expect("utf8");
    let sig_back =
        std::str::from_utf8(&f.payload[json_end..json_end + SIG_B64_LEN]).expect("utf8");
    assert_eq!(json_back, json);
    assert_eq!(sig_back, sig);

    // 7. Verify signature recovers our pubkey, and Mona addresses match
    //    what we'd derive locally.
    let rec = verify_recover(json_back.as_bytes(), sig_back).expect("verify");
    assert_eq!(rec.pubkey, pubkey_for(&secret));

    let addrs_recovered = derive_all(&rec.pubkey);
    let addrs_local = derive_all(&pubkey_for(&secret));
    assert_eq!(addrs_recovered, addrs_local);
    assert!(addrs_local.m.starts_with('M'));
    assert!(addrs_local.p.starts_with('P'));
    assert!(addrs_local.mona1.starts_with("mona1"));

    // 8. The JSON is parseable as a QSL card and matches our input.
    match parse_card(json_back).expect("parse") {
        DecodedCard::Qsl(c, ext) => {
            assert_eq!(c, card);
            assert!(ext.is_empty());
        }
        _ => panic!("expected QSL card"),
    }
}

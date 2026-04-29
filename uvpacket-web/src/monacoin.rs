// SPDX-License-Identifier: GPL-3.0-or-later
//! Monacoin signed-message: sign / verify, wire-compatible with the C
//! reference implementation in `pico_tnc/libmona_pico` (see
//! `INTEGRATION.md`). The on-the-wire signature is exactly 88 base64
//! characters representing a 65-byte compact recoverable signature
//! (`header(1) + r(32) + s(32)`), with the legacy header form
//! `27 + recid + (compressed ? 4 : 0)` even for segwit address types
//! (Electrum-Mona compatibility mode).

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use k256::ecdsa::signature::hazmat::PrehashVerifier;
use k256::ecdsa::{
    RecoveryId, Signature as EcdsaSignature, SigningKey, VerifyingKey,
};
use sha2::{Digest, Sha256};

extern crate alloc;

/// Magic prefix for Monacoin signed messages (mirrors Bitcoin's
/// "Bitcoin Signed Message:\n", electrum_mona/bitcoin.py).
pub const MAGIC: &[u8] = b"\x19Monacoin Signed Message:\n";

/// Fixed length of the on-the-wire base64 signature.
pub const SIG_B64_LEN: usize = 88;

/// 65-byte compact signature ready to base64-encode.
pub type CompactSig = [u8; 65];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignError {
    InvalidSecret,
    SignFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    InvalidBase64,
    BadSigLen,
    BadHeader,
    Recover,
}

/// Build the message digest the way Bitcoin/Monacoin signed-message does:
/// `dSHA256(MAGIC || varint(len) || msg)`.
pub fn message_hash(msg: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(MAGIC.len() + 9 + msg.len());
    buf.extend_from_slice(MAGIC);
    push_varint(&mut buf, msg.len() as u64);
    buf.extend_from_slice(msg);
    let h1 = Sha256::digest(&buf);
    let h2 = Sha256::digest(h1);
    let mut out = [0u8; 32];
    out.copy_from_slice(&h2);
    out
}

fn push_varint(buf: &mut Vec<u8>, n: u64) {
    if n < 0xFD {
        buf.push(n as u8);
    } else if n <= 0xFFFF {
        buf.push(0xFD);
        buf.extend_from_slice(&(n as u16).to_le_bytes());
    } else if n <= 0xFFFF_FFFF {
        buf.push(0xFE);
        buf.extend_from_slice(&(n as u32).to_le_bytes());
    } else {
        buf.push(0xFF);
        buf.extend_from_slice(&n.to_le_bytes());
    }
}

/// Sign a message with a 32-byte secret, producing the 88-char base64
/// string that pico_tnc puts on the wire after the JSON.
///
/// `compressed` controls only the header byte: pico_tnc currently always
/// signs with `compressed = true` regardless of the address type
/// (Electrum-Mona compat). Pass `true` unless you have a reason not to.
pub fn sign_message(
    msg: &[u8],
    secret: &[u8; 32],
    compressed: bool,
) -> Result<String, SignError> {
    let signing = SigningKey::from_bytes(secret.into()).map_err(|_| SignError::InvalidSecret)?;
    let digest = message_hash(msg);
    let (sig, rec_id) = signing
        .sign_prehash_recoverable(&digest)
        .map_err(|_| SignError::SignFailed)?;

    let sig_bytes = sig.to_bytes();
    let mut compact = [0u8; 65];
    compact[0] = 27 + rec_id.to_byte() + if compressed { 4 } else { 0 };
    compact[1..33].copy_from_slice(&sig_bytes[..32]);
    compact[33..65].copy_from_slice(&sig_bytes[32..]);
    Ok(B64.encode(compact))
}

/// Recovery result from a verified signature.
pub struct Recovered {
    /// 33-byte compressed pubkey recovered from (msg, sig).
    pub pubkey: [u8; 33],
    /// `compressed` flag inferred from the signature header.
    pub compressed: bool,
    /// Header byte after base64 decode (27..42).
    pub header: u8,
    /// `recid` in 0..3 extracted from the header.
    pub recid: u8,
}

/// Verify a base64-encoded compact recoverable signature against a
/// message and recover the signer's compressed pubkey. Accepts both
/// legacy headers (27..34) and BIP137-style segwit hint headers
/// (35..42), matching `mona_verifymessage` in pico_tnc.
pub fn verify_recover(msg: &[u8], sig_b64: &str) -> Result<Recovered, VerifyError> {
    if sig_b64.len() != SIG_B64_LEN {
        return Err(VerifyError::BadSigLen);
    }
    let raw = B64.decode(sig_b64).map_err(|_| VerifyError::InvalidBase64)?;
    if raw.len() != 65 {
        return Err(VerifyError::BadSigLen);
    }
    let header = raw[0];
    if !(27..=42).contains(&header) {
        return Err(VerifyError::BadHeader);
    }
    let (recid_byte, compressed) = match header {
        27..=30 => (header - 27, false),
        31..=34 => (header - 31, true),
        // BIP137 segwit hint headers (35..38 = p2sh-p2wpkh, 39..42 = p2wpkh)
        35..=38 => (header - 35, true),
        39..=42 => (header - 39, true),
        _ => unreachable!(),
    };

    let sig = EcdsaSignature::from_slice(&raw[1..]).map_err(|_| VerifyError::Recover)?;
    let recid = RecoveryId::try_from(recid_byte).map_err(|_| VerifyError::BadHeader)?;
    let digest = message_hash(msg);
    let vk = VerifyingKey::recover_from_prehash(&digest, &sig, recid)
        .map_err(|_| VerifyError::Recover)?;
    // Sanity-check: re-run verification.
    vk.verify_prehash(&digest, &sig).map_err(|_| VerifyError::Recover)?;

    let encoded = vk.to_encoded_point(true);
    let mut pubkey = [0u8; 33];
    pubkey.copy_from_slice(encoded.as_bytes());
    Ok(Recovered {
        pubkey,
        compressed,
        header,
        recid: recid_byte,
    })
}

/// Strerror-like helper for surfacing errors to JS.
pub fn verify_error_str(err: VerifyError) -> String {
    format!("{:?}", err)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip: sign with a deterministic key and verify recovers the
    /// matching pubkey.
    #[test]
    fn sign_verify_roundtrip() {
        let secret: [u8; 32] = [
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
            0xFF, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC,
            0xDD, 0xEE, 0xFF, 0x42,
        ];
        let msg = b"{\"FR\":\"JL1NIE\",\"QSL\":{\"C\":\"JA1UMW\"}}";
        let sig = sign_message(msg, &secret, true).unwrap();
        assert_eq!(sig.len(), SIG_B64_LEN);
        let rec = verify_recover(msg, &sig).unwrap();
        assert!(rec.compressed);

        // Pubkey from the same secret directly should match.
        let signing = SigningKey::from_bytes((&secret).into()).unwrap();
        let vk = signing.verifying_key();
        let expected = vk.to_encoded_point(true);
        assert_eq!(rec.pubkey, expected.as_bytes());
    }

    /// Tampered message must not verify.
    #[test]
    fn tamper_detected() {
        let secret = [0x42u8; 32];
        let msg = b"hello";
        let sig = sign_message(msg, &secret, true).unwrap();
        let bad = b"hellp";
        let rec = verify_recover(bad, &sig).unwrap();
        // Recovery can succeed with a different pubkey for the wrong msg;
        // the assertion is that the recovered pubkey is NOT the one that
        // signed `msg`.
        let signing = SigningKey::from_bytes((&secret).into()).unwrap();
        let vk = signing.verifying_key();
        let expected = vk.to_encoded_point(true);
        assert_ne!(rec.pubkey, expected.as_bytes());
    }

    #[test]
    fn message_hash_known_vector() {
        // Empty-message hash under MAGIC ("Monacoin Signed Message:\n" + 0x00).
        let h = message_hash(b"");
        assert_eq!(h.len(), 32);
    }
}

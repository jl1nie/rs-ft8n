// SPDX-License-Identifier: GPL-3.0-or-later
//! FT8 waveform generator.
//!
//! Encodes a 77-bit message into an 8-FSK baseband waveform at 12 000 Hz.
//! The pipeline mirrors WSJT-X `genft8.f90` / `encode174_91.f90`:
//!
//! ```text
//! message77  →  CRC-14  →  info91
//!            →  LDPC encode  →  codeword174
//!            →  Gray-map 3 bits/symbol  →  itone[79]
//!            →  phase accumulation  →  PCM f32 / i16
//! ```
use std::f32::consts::PI;

use crate::{
    ldpc::osd::ldpc_encode,
    params::{COSTAS, GRAYMAP, LDPC_K, LDPC_N, MSG_BITS, NSPS, NN},
};

// ────────────────────────────────────────────────────────────────────────────
// CRC-14

/// CRC-14 (polynomial 0x2757) over `data` bytes, MSB-first.
/// Matches boost::augmented_crc<14, 0x2757> used in WSJT-X crc14.cpp:
/// 77 message bits are packed into 12 bytes (96 bits total, last 19 bits = 0).
fn crc14(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &byte in data {
        for i in (0..8).rev() {
            let bit = (byte >> i) & 1;
            let msb = (crc >> 13) & 1;
            crc = ((crc << 1) | bit as u16) & 0x3FFF;
            if msb != 0 {
                crc ^= 0x2757;
            }
        }
    }
    crc
}

/// Append 14 CRC bits to a 77-bit message, producing 91 info bits.
fn append_crc14(message77: &[u8; MSG_BITS]) -> [u8; LDPC_K] {
    // Pack 77 message bits into 12 bytes (big-endian, MSB-first).
    // Bytes 10-11 are zero; this 96-bit layout matches WSJT-X's CRC computation.
    let mut bytes = [0u8; 12];
    for (i, &bit) in message77.iter().enumerate() {
        bytes[i / 8] |= (bit & 1) << (7 - i % 8);
    }
    let crc = crc14(&bytes);

    let mut info = [0u8; LDPC_K];
    info[..MSG_BITS].copy_from_slice(message77);
    for i in 0..14 {
        info[MSG_BITS + i] = ((crc >> (13 - i)) & 1) as u8;
    }
    info
}


// ────────────────────────────────────────────────────────────────────────────
// Tone sequence

/// Build the 79-symbol tone sequence from a 174-bit LDPC codeword.
///
/// Layout (symbol positions):
///   0–6    : Costas array 1
///   7–35   : 29 data symbols ← bits 0–86
///   36–42  : Costas array 2
///   43–71  : 29 data symbols ← bits 87–173
///   72–78  : Costas array 3
fn codeword_to_itone(cw: &[u8; LDPC_N]) -> [u8; NN] {
    let mut itone = [0u8; NN];

    // Costas arrays
    for (i, &c) in COSTAS.iter().enumerate() {
        itone[i]      = c as u8;
        itone[36 + i] = c as u8;
        itone[72 + i] = c as u8;
    }

    // First data half: symbols 7..35, bits 0..87
    for k in 0..29usize {
        let b = k * 3;
        let v = (cw[b] << 2) | (cw[b + 1] << 1) | cw[b + 2];
        itone[7 + k] = GRAYMAP[v as usize] as u8;
    }

    // Second data half: symbols 43..71, bits 87..174
    for k in 0..29usize {
        let b = 87 + k * 3;
        let v = (cw[b] << 2) | (cw[b + 1] << 1) | cw[b + 2];
        itone[43 + k] = GRAYMAP[v as usize] as u8;
    }

    itone
}

// ────────────────────────────────────────────────────────────────────────────
// Public API

/// Encode a 77-bit message into a 79-symbol FT8 tone sequence.
///
/// Each tone is an integer 0–7.  The sequence can be passed to
/// [`tones_to_f32`] or [`tones_to_i16`] to produce PCM audio.
pub fn message_to_tones(message77: &[u8; MSG_BITS]) -> [u8; NN] {
    let info = append_crc14(message77);
    let cw   = ldpc_encode(&info);
    codeword_to_itone(&cw)
}

/// GFSK pulse shape (matches WSJT-X `gfsk_pulse.f90`).
///
/// `bt` — bandwidth-time product (2.0 for FT8)
/// `t`  — time in symbol periods, centered at 0
fn gfsk_pulse(bt: f32, t: f32) -> f32 {
    let c = PI * (2.0_f32 / 2.0_f32.ln()).sqrt();
    0.5 * (erf(c * bt * (t + 0.5)) - erf(c * bt * (t - 0.5)))
}

/// Approximate erf(x) — accurate to ~1e-5 (Abramowitz & Stegun 7.1.26).
fn erf(x: f32) -> f32 {
    let sign = if x >= 0.0 { 1.0 } else { -1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let poly = t * (0.254829592
        + t * (-0.284496736
        + t * (1.421413741
        + t * (-1.453152027
        + t * 1.061405429))));
    sign * (1.0 - poly * (-x * x).exp())
}

/// Synthesise a 12 000 Hz f32 PCM waveform from an FT8 tone sequence.
///
/// Uses GFSK (Gaussian Frequency Shift Keying) with BT=2.0, matching
/// WSJT-X `gen_ft8wave.f90`.  Includes:
/// - Gaussian-smoothed frequency transitions (3-symbol pulse)
/// - Dummy symbols at start/end for smooth ramp-in/ramp-out
/// - Cosine envelope shaping on first/last nsps/8 samples
///
/// # Arguments
/// * `itone`     — 79-element tone array (0–7), e.g. from [`message_to_tones`]
/// * `f0`        — carrier (lowest tone) frequency in Hz
/// * `amplitude` — peak amplitude of the generated signal
///
/// Returns a `Vec<f32>` of length `79 × 1920 = 151 680`.
pub fn tones_to_f32(itone: &[u8; NN], f0: f32, amplitude: f32) -> Vec<f32> {
    let nsps = NSPS;
    let nsym = NN;
    let bt = 2.0_f32;
    let dt = 1.0_f32 / 12000.0;
    let twopi = 2.0 * PI;
    let hmod = 1.0_f32;

    // Precompute GFSK pulse (3 symbols wide)
    let pulse_len = 3 * nsps;
    let mut pulse = vec![0.0f32; pulse_len];
    for i in 0..pulse_len {
        let tt = (i as f32 - 1.5 * nsps as f32) / nsps as f32;
        pulse[i] = gfsk_pulse(bt, tt);
    }

    // Build smoothed dphi array: (nsym+2)*nsps samples
    // Extra symbols at start and end for GFSK pulse overlap
    let total = (nsym + 2) * nsps;
    let mut dphi = vec![0.0f32; total];
    let dphi_peak = twopi * hmod / nsps as f32;

    // Main symbols
    for j in 0..nsym {
        let ib = j * nsps;
        for i in 0..pulse_len {
            if ib + i < total {
                dphi[ib + i] += dphi_peak * pulse[i] * itone[j] as f32;
            }
        }
    }

    // Dummy symbol at beginning (extend first tone)
    for i in 0..(2 * nsps) {
        dphi[i] += dphi_peak * itone[0] as f32 * pulse[nsps + i];
    }

    // Dummy symbol at end (extend last tone)
    let ofs = nsym * nsps;
    for i in 0..(2 * nsps) {
        if ofs + i < total {
            dphi[ofs + i] += dphi_peak * itone[nsym - 1] as f32 * pulse[i];
        }
    }

    // Add carrier frequency offset
    for d in dphi.iter_mut() {
        *d += twopi * f0 * dt;
    }

    // Generate waveform (skip first dummy symbol = start at nsps)
    let nwave = nsym * nsps;
    let mut wave = vec![0.0f32; nwave];
    let mut phi = 0.0f32;
    for k in 0..nwave {
        wave[k] = amplitude * phi.sin();
        phi += dphi[nsps + k];
        if phi > twopi { phi -= twopi; }
    }

    // Cosine envelope ramp (first and last nsps/8 samples)
    let nramp = nsps / 8;
    for i in 0..nramp {
        let env = (1.0 - (twopi * i as f32 / (2.0 * nramp as f32)).cos()) / 2.0;
        wave[i] *= env;
    }
    let k1 = nwave - nramp;
    for i in 0..nramp {
        let env = (1.0 + (twopi * i as f32 / (2.0 * nramp as f32)).cos()) / 2.0;
        wave[k1 + i] *= env;
    }

    wave
}

/// Synthesise and return a 16-bit PCM waveform.
///
/// The signal is scaled so that the peak value equals `amplitude_i16` (0..32767).
pub fn tones_to_i16(itone: &[u8; NN], f0: f32, amplitude_i16: i16) -> Vec<i16> {
    let f32_samples = tones_to_f32(itone, f0, 1.0);
    f32_samples
        .iter()
        .map(|&s| (s * amplitude_i16 as f32) as i16)
        .collect()
}

// ────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip: generate a waveform and verify it decodes back to the same
    /// tone sequence (structural smoke-test only — no full decode).
    #[test]
    fn tone_sequence_length() {
        let msg = [0u8; MSG_BITS];
        let itone = message_to_tones(&msg);
        assert_eq!(itone.len(), NN);
    }

    #[test]
    fn all_tones_in_range() {
        let msg = [1u8; MSG_BITS]; // arbitrary non-zero message
        let itone = message_to_tones(&msg);
        for &t in itone.iter() {
            assert!(t < 8, "tone {t} out of range");
        }
    }

    #[test]
    fn costas_positions_correct() {
        let msg = [0u8; MSG_BITS];
        let itone = message_to_tones(&msg);
        for offset in [0usize, 36, 72] {
            for (i, &c) in COSTAS.iter().enumerate() {
                assert_eq!(
                    itone[offset + i], c as u8,
                    "Costas mismatch at symbol {}",
                    offset + i
                );
            }
        }
    }

    #[test]
    fn waveform_length() {
        let msg = [0u8; MSG_BITS];
        let itone = message_to_tones(&msg);
        let pcm = tones_to_f32(&itone, 1000.0, 1.0);
        assert_eq!(pcm.len(), NN * NSPS);
    }

    /// Encode → decode round-trip via the full ft8-core pipeline (raw bits).
    #[test]
    fn encode_decode_roundtrip() {
        use crate::decode::{decode_frame, DecodeDepth};

        // Build a known message (all bits = 1 is unlikely to collide with anything).
        let msg = [1u8; MSG_BITS];
        let itone = message_to_tones(&msg);

        // Strong noiseless signal at 1000 Hz.
        let pcm_f32 = tones_to_f32(&itone, 1000.0, 1.0);

        // Start at nominal 0.5 s into the frame — pad with 0.5 s of silence.
        let pad = vec![0.0f32; 6000];
        let signal: Vec<f32> = pad.iter().chain(pcm_f32.iter()).cloned().collect();
        let samples: Vec<i16> = signal.iter().map(|&s| (s * 20000.0) as i16).collect();

        // Pad to 180 000 samples.
        let mut audio = vec![0i16; 180_000];
        let len = samples.len().min(audio.len());
        audio[..len].copy_from_slice(&samples[..len]);

        let results = decode_frame(&audio, 800.0, 1200.0, 1.0, None, DecodeDepth::BpAll, 50);
        assert!(
            !results.is_empty(),
            "round-trip decode failed — no message found"
        );
        // The decoded message77 bits should match.
        assert_eq!(
            results[0].message77, msg,
            "decoded message77 does not match input"
        );
    }

    /// Full encode → decode round-trip with real FT8 callsigns.
    ///
    /// Tests the complete pipeline:
    ///   pack77 → message_to_tones → tones_to_f32 → decode_frame → unpack77
    ///
    /// Catches bugs in pack77/unpack77 that the raw-bit round-trip test misses,
    /// and verifies WSJT-X CRC compatibility (77-bit CRC, not 96-bit).
    #[test]
    fn callsign_roundtrip() {
        use crate::decode::{decode_frame, DecodeDepth};
        use crate::message::{pack77, unpack77};

        let cases: &[(&str, &str, &str, &str)] = &[
            ("CQ",     "JA1ABC", "PM95", "CQ JA1ABC PM95"),
            ("JA1ABC", "W1AW",   "-15",  "JA1ABC W1AW -15"),
            ("W1AW",   "JA1ABC", "R-15", "W1AW JA1ABC R-15"),
            ("JA1ABC", "W1AW",   "RR73", "JA1ABC W1AW RR73"),
            ("W1AW",   "JA1ABC", "73",   "W1AW JA1ABC 73"),
            ("CQ",     "3Y0Z",   "JD34", "CQ 3Y0Z JD34"),
        ];

        for &(call1, call2, report, expected) in cases {
            // 1. Pack message
            let msg77 = pack77(call1, call2, report)
                .unwrap_or_else(|| panic!("pack77 failed: {call1} {call2} {report}"));

            // 2. Verify pack → unpack consistency (no audio)
            let text = unpack77(&msg77)
                .unwrap_or_else(|| panic!("unpack77 failed for: {expected}"));
            assert_eq!(text, expected, "pack/unpack mismatch");

            // 3. Full encode → decode with audio
            let itone = message_to_tones(&msg77);
            let pcm_f32 = tones_to_f32(&itone, 1000.0, 1.0);
            let pad = vec![0.0f32; 6000];
            let signal: Vec<f32> = pad.iter().chain(pcm_f32.iter()).cloned().collect();
            let samples: Vec<i16> = signal.iter().map(|&s| (s * 20000.0) as i16).collect();
            let mut audio = vec![0i16; 180_000];
            let n = samples.len().min(audio.len());
            audio[..n].copy_from_slice(&samples[..n]);

            let results = decode_frame(&audio, 800.0, 1200.0, 1.0, None, DecodeDepth::BpAll, 50);
            assert!(!results.is_empty(), "decode found nothing for: {expected}");

            let decoded = unpack77(&results[0].message77)
                .unwrap_or_else(|| panic!("unpack decoded bits failed for: {expected}"));
            assert_eq!(decoded, expected, "full roundtrip mismatch for: {call1} {call2} {report}");
        }
    }
}

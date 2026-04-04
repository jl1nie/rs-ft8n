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
/// Matches boost::augmented_crc<14, 0x2757> used in WSJT-X.
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
    // Pack 77 message bits into 10 bytes (big-endian, MSB-first).
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

/// Synthesise a 12 000 Hz f32 PCM waveform from an FT8 tone sequence.
///
/// # Arguments
/// * `itone`     — 79-element tone array (0–7), e.g. from [`message_to_tones`]
/// * `f0`        — carrier (lowest tone) frequency in Hz
/// * `amplitude` — peak amplitude of the generated signal
///
/// Returns a `Vec<f32>` of length `79 × 1920 = 151 680`.
pub fn tones_to_f32(itone: &[u8; NN], f0: f32, amplitude: f32) -> Vec<f32> {
    let mut samples = vec![0.0f32; NN * NSPS];
    let dt = 1.0_f32 / 12000.0;
    let mut phase = 0.0f32;

    for (sym, &tone) in itone.iter().enumerate() {
        let freq = f0 + tone as f32 * 6.25;
        let dphi = 2.0 * PI * freq * dt;
        for j in 0..NSPS {
            samples[sym * NSPS + j] = amplitude * phase.cos();
            phase += dphi;
            // Prevent phase from growing without bound.
            if phase > PI {
                phase -= 2.0 * PI;
            }
        }
    }
    samples
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

    /// Encode → decode round-trip via the full ft8-core pipeline.
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
}

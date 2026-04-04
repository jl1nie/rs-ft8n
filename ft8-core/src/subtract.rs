// SPDX-License-Identifier: GPL-3.0-or-later
//! FT8 signal subtraction (successive interference cancellation).
//!
//! Given a decoded message and its time/frequency coordinates, reconstruct the
//! ideal waveform and subtract it from the audio buffer.  This exposes weaker
//! signals that were hidden under the decoded signal.
//!
//! The amplitude is estimated by projecting the received signal onto both the
//! in-phase (`cos`) and quadrature (`sin`) components of the reconstructed
//! waveform — equivalent to a complex least-squares fit — so that an arbitrary
//! carrier phase offset in the received signal is handled correctly.

use std::f32::consts::PI;

use crate::{
    decode::DecodeResult,
    params::{NN, NSPS},
    wave_gen::message_to_tones,
};

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers

/// Generate phase-continuous IQ (cosine, sine) waveform for a decoded message.
///
/// Returns `(w_cos, w_sin)` each of length `NN * NSPS = 151 680`.
/// `freq_hz` is the carrier (lowest tone) frequency.
fn generate_iq(message77: &[u8; 77], freq_hz: f32) -> (Vec<f32>, Vec<f32>) {
    const FS: f32 = 12_000.0;
    let itone = message_to_tones(message77);
    let n = NN * NSPS;
    let mut w_cos = vec![0.0f32; n];
    let mut w_sin = vec![0.0f32; n];
    let mut phase = 0.0f32;

    for (sym, &tone) in itone.iter().enumerate() {
        let freq = freq_hz + tone as f32 * 6.25;
        let dphi = 2.0 * PI * freq / FS;
        for j in 0..NSPS {
            w_cos[sym * NSPS + j] = phase.cos();
            w_sin[sym * NSPS + j] = phase.sin();
            phase += dphi;
            if phase > PI {
                phase -= 2.0 * PI;
            }
        }
    }
    (w_cos, w_sin)
}

// ────────────────────────────────────────────────────────────────────────────
// Public API

/// Subtract a decoded FT8 signal from `audio` in-place.
///
/// Reconstructs the ideal I/Q waveform from the decoded message, estimates
/// the complex amplitude (scale_cos · cos + scale_sin · sin) by least-squares
/// projection onto the received signal, and subtracts the result.
///
/// Works in f32 internally; final values are clamped to i16 range.
pub fn subtract_signal(audio: &mut Vec<i16>, result: &DecodeResult) {
    const FS: f32 = 12_000.0;

    let (w_cos, w_sin) = generate_iq(&result.message77, result.freq_hz);

    // Start sample in the 15-second receive buffer
    let start = ((0.5 + result.dt_sec) * FS).round() as usize;
    let len = w_cos.len().min(audio.len().saturating_sub(start));
    if len == 0 {
        return;
    }

    // Complex least-squares: rx[t] ≈ a·cos(φ(t)) + b·sin(φ(t))
    // Since cos and sin are nearly orthogonal over the full frame:
    //   a = Σ(rx · w_cos) / Σ(w_cos²)
    //   b = Σ(rx · w_sin) / Σ(w_sin²)
    let mut num_a = 0.0f32;
    let mut num_b = 0.0f32;
    let mut den_a = 0.0f32;
    let mut den_b = 0.0f32;

    for i in 0..len {
        let rx = audio[start + i] as f32;
        num_a += rx * w_cos[i];
        num_b += rx * w_sin[i];
        den_a += w_cos[i] * w_cos[i];
        den_b += w_sin[i] * w_sin[i];
    }

    let a = if den_a > f32::EPSILON { num_a / den_a } else { 0.0 };
    let b = if den_b > f32::EPSILON { num_b / den_b } else { 0.0 };

    // Subtract reconstructed signal
    for i in 0..len {
        let sub = a * w_cos[i] + b * w_sin[i];
        let new_val = audio[start + i] as f32 - sub;
        audio[start + i] = new_val.clamp(-32_768.0, 32_767.0) as i16;
    }
}

// ────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::DecodeDepth;
    use crate::wave_gen::tones_to_i16;

    /// Subtracting a known signal should significantly reduce its power.
    #[test]
    fn subtract_reduces_power() {
        let msg = [0u8; 77];
        let itone = message_to_tones(&msg);
        let samples = tones_to_i16(&itone, 1000.0, 20_000);

        // Pad to a full 15-second frame starting at 0.5 s
        let mut audio = vec![0i16; 180_000];
        let offset = 6_000usize; // 0.5 s
        let len = samples.len().min(180_000 - offset);
        audio[offset..offset + len].copy_from_slice(&samples[..len]);

        // Power before subtraction
        let power_before: f32 = audio
            .iter()
            .map(|&s| (s as f32).powi(2))
            .sum::<f32>()
            / audio.len() as f32;

        // Create a fake DecodeResult (freq, dt, message)
        let result = DecodeResult {
            message77: msg,
            freq_hz: 1000.0,
            dt_sec: 0.0,
            hard_errors: 0,
            sync_score: 10.0,
            pass: 0,
        };

        let mut audio = audio;
        subtract_signal(&mut audio, &result);

        let power_after: f32 = audio
            .iter()
            .map(|&s| (s as f32).powi(2))
            .sum::<f32>()
            / audio.len() as f32;

        // At least 90% power reduction expected for a clean signal
        assert!(
            power_after < power_before * 0.10,
            "power before={power_before:.1} after={power_after:.1} — subtraction ineffective"
        );
    }

    /// Subtract using the exact timing used during generation.
    /// Power should drop to near quantization-noise level.
    #[test]
    fn subtract_with_exact_timing_near_zero() {
        let msg = [1u8; 77];
        let itone = message_to_tones(&msg);
        let samples = tones_to_i16(&itone, 1000.0, 20_000);

        let mut audio = vec![0i16; 180_000];
        let offset = 6_000usize; // 0.5 s start
        let len = samples.len().min(180_000 - offset);
        audio[offset..offset + len].copy_from_slice(&samples[..len]);

        let power_before: f32 = audio.iter().map(|&s| (s as f32).powi(2)).sum::<f32>();

        // Use exact known timing (dt_sec = 0.0 → start = 6000)
        let result = DecodeResult {
            message77: msg,
            freq_hz: 1000.0,
            dt_sec: 0.0,
            hard_errors: 0,
            sync_score: 10.0,
            pass: 0,
        };
        subtract_signal(&mut audio, &result);

        let power_after: f32 = audio.iter().map(|&s| (s as f32).powi(2)).sum::<f32>();
        // With exact alignment, residual is quantization noise only (< 0.01% of original).
        assert!(
            power_after < power_before * 0.001,
            "power before={power_before:.0} after={power_after:.0} — near-exact subtraction expected"
        );
    }

    /// Multi-pass: subtract a strong signal → a hidden weak signal becomes decodable.
    #[test]
    fn subtract_reveals_hidden_signal() {
        use crate::decode::decode_frame_subtract;

        // Strong signal at 1000 Hz
        let msg_strong = [0u8; 77];
        let itone_s = message_to_tones(&msg_strong);
        let strong = tones_to_i16(&itone_s, 1000.0, 20_000);

        // Weak signal at 1500 Hz (would be hidden if mixed with strong signal
        // and sync_min is set too high for the weak signal alone)
        let msg_weak = [1u8; 77];
        let itone_w = message_to_tones(&msg_weak);
        let weak = tones_to_i16(&itone_w, 1500.0, 3_000);

        let mut audio = vec![0i16; 180_000];
        let off = 6_000usize;
        let len = strong.len().min(180_000 - off);
        for i in 0..len {
            let v = strong[i] as i32 + weak[i] as i32;
            audio[off + i] = v.clamp(-32_768, 32_767) as i16;
        }

        // Multi-pass subtract should decode both
        let results = decode_frame_subtract(
            &audio, 800.0, 1700.0, 1.0, None, DecodeDepth::BpAll, 50,
        );
        let found_strong = results.iter().any(|r| r.message77 == msg_strong);
        let found_weak   = results.iter().any(|r| r.message77 == msg_weak);
        assert!(found_strong, "strong signal not decoded");
        assert!(found_weak,   "weak signal not decoded after subtract");
    }
}

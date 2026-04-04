// SPDX-License-Identifier: GPL-3.0-or-later
//! Synthetic FT8 scenario generator.
//!
//! Produces a 15-second mixed audio frame (12 000 Hz, 16-bit PCM) containing
//! one or more FT8 signals at specified SNR values plus AWGN.  The SNR
//! convention matches WSJT-X: reference bandwidth = **2500 Hz**.
//!
//! ```text
//! SNR_dB = 10 * log10(Ps / (N0 * 2500))
//! ```
//!
//! where `N0` is the one-sided noise power spectral density (W/Hz).

use std::f32::consts::PI;
use std::path::Path;

use ft8_core::params::MSG_BITS;
use ft8_core::wave_gen::{message_to_tones, tones_to_f32};

// ────────────────────────────────────────────────────────────────────────────
// Public types

/// One synthetic FT8 signal to inject into the mix.
pub struct SimSignal {
    /// 77-bit message payload
    pub message77: [u8; MSG_BITS],
    /// Carrier frequency of the lowest tone (Hz)
    pub freq_hz: f32,
    /// SNR in dB, WSJT-X convention (reference bandwidth 2500 Hz)
    pub snr_db: f32,
    /// Time offset relative to the nominal 0.5 s frame start (seconds)
    pub dt_sec: f32,
}

/// Configuration for one synthetic scenario.
pub struct SimConfig {
    /// Signals to mix together
    pub signals: Vec<SimSignal>,
    /// Optional RNG seed for reproducible noise (defaults to 12345 if None)
    pub noise_seed: Option<u64>,
}

// ────────────────────────────────────────────────────────────────────────────
// Gaussian RNG (LCG + Box-Muller, no external crate required)

struct LcgRng {
    state: u64,
    spare: Option<f32>,
}

impl LcgRng {
    fn new(seed: u64) -> Self {
        LcgRng { state: seed.wrapping_add(1), spare: None }
    }

    fn next_u64(&mut self) -> u64 {
        // Knuth multiplicative LCG
        self.state = self.state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.state
    }

    /// Uniform in (0, 1]
    fn uniform(&mut self) -> f32 {
        ((self.next_u64() >> 11) as f32 + 1.0) / ((1u64 << 53) as f32 + 1.0)
    }

    /// Standard-normal sample via Box-Muller.
    fn gaussian(&mut self) -> f32 {
        if let Some(s) = self.spare.take() {
            return s;
        }
        let u = self.uniform();
        let v = self.uniform();
        let mag = (-2.0 * u.ln()).sqrt();
        let (z0, z1) = (mag * (2.0 * PI * v).cos(), mag * (2.0 * PI * v).sin());
        self.spare = Some(z1);
        z0
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Frame generation

/// Generate a 15-second FT8 frame mixed from multiple signals plus AWGN.
///
/// Returns 180 000 samples (15 s × 12 000 S/s) as i16, scaled so that the
/// loudest peak sits at ≈29 000 (≈88% of full range) to avoid clipping.
///
/// **SNR convention** (WSJT-X compatible):
///
/// ```text
/// A = sqrt(2 * 10^(snr_db/10) * 2500 / 12000) * σ_noise
/// ```
///
/// With `σ_noise = 1.0` (unit noise), this directly gives the correct
/// signal amplitude for the requested SNR.
pub fn generate_frame(config: &SimConfig) -> Vec<i16> {
    const FS: f32 = 12_000.0;
    const NMAX: usize = 180_000;
    const REF_BW: f32 = 2_500.0;

    let mut mix = vec![0.0f32; NMAX];

    // σ_noise = 1.0; signal amplitudes scaled to SNR target
    for sig in &config.signals {
        let snr_linear = 10.0_f32.powf(sig.snr_db / 10.0);
        // A² / 2 = snr_linear * σ²_noise * REF_BW / FS
        let amplitude = (2.0 * snr_linear * REF_BW / FS).sqrt();

        let itone = message_to_tones(&sig.message77);
        let pcm = tones_to_f32(&itone, sig.freq_hz, amplitude);

        let start = ((0.5 + sig.dt_sec) * FS).round() as usize;
        let copy_len = pcm.len().min(NMAX.saturating_sub(start));
        for i in 0..copy_len {
            mix[start + i] += pcm[i];
        }
    }

    // Add AWGN (σ = 1.0)
    let mut rng = LcgRng::new(config.noise_seed.unwrap_or(12345));
    for s in mix.iter_mut() {
        *s += rng.gaussian();
    }

    // Scale to i16 with headroom
    let peak = mix.iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
    let scale = if peak > 1e-6 { 29_000.0 / peak } else { 1.0 };
    mix.iter()
        .map(|&s| (s * scale).clamp(-32_768.0, 32_767.0) as i16)
        .collect()
}

/// Write a 12 000 Hz mono 16-bit WAV file.
pub fn write_wav(path: &Path, samples: &[i16]) -> Result<(), hound::Error> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 12_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)?;
    for &s in samples {
        writer.write_sample(s)?;
    }
    writer.finalize()
}

// ────────────────────────────────────────────────────────────────────────────
// Convenience builders

/// Build a scenario with a weak target and a strong adjacent interferer.
///
/// * `target_freq` — Hz, lowest tone of the target signal
/// * `target_snr_db` — SNR of the target in dB (WSJT-X convention)
/// * `interferer_freq` — Hz, lowest tone of the interferer
/// * `interference_db` — power advantage of the interferer over the target (dB)
///   (e.g. +40 for a +40 dB adjacent signal)
pub fn make_interference_scenario(
    target_msg: [u8; MSG_BITS],
    target_freq: f32,
    target_snr_db: f32,
    interferer_msg: [u8; MSG_BITS],
    interferer_freq: f32,
    interference_db: f32,
    noise_seed: Option<u64>,
) -> SimConfig {
    SimConfig {
        signals: vec![
            SimSignal {
                message77: target_msg,
                freq_hz: target_freq,
                snr_db: target_snr_db,
                dt_sec: 0.0,
            },
            SimSignal {
                message77: interferer_msg,
                freq_hz: interferer_freq,
                snr_db: target_snr_db + interference_db,
                dt_sec: 0.0,
            },
        ],
        noise_seed,
    }
}

// ────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_frame_length() {
        let config = SimConfig { signals: vec![], noise_seed: Some(0) };
        let samples = generate_frame(&config);
        assert_eq!(samples.len(), 180_000);
    }

    #[test]
    fn generate_frame_no_overflow() {
        let msg = [0u8; MSG_BITS];
        let config = SimConfig {
            signals: vec![SimSignal {
                message77: msg,
                freq_hz: 1000.0,
                snr_db: 10.0,
                dt_sec: 0.0,
            }],
            noise_seed: Some(42),
        };
        let samples = generate_frame(&config);
        let max_abs = samples.iter().map(|&s| s.abs()).max().unwrap_or(0);
        assert!(max_abs < 32_000, "peak {max_abs} too close to clipping");
    }

    #[test]
    fn weak_signal_roundtrip() {
        use ft8_core::decode::{decode_frame, DecodeDepth};

        // Generate a signal at SNR = +10 dB; should decode easily.
        let msg = [0u8; MSG_BITS];
        let config = SimConfig {
            signals: vec![SimSignal {
                message77: msg,
                freq_hz: 1000.0,
                snr_db: 10.0,
                dt_sec: 0.0,
            }],
            noise_seed: Some(1),
        };
        let audio = generate_frame(&config);
        let results = decode_frame(&audio, 800.0, 1200.0, 1.0, None, DecodeDepth::BpAll, 20);
        assert!(
            !results.is_empty(),
            "should decode SNR +10 dB signal; got 0 results"
        );
        assert_eq!(results[0].message77, msg, "decoded message mismatch");
    }
}

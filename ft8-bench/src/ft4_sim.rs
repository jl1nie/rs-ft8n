// SPDX-License-Identifier: GPL-3.0-or-later
//! Synthetic FT4 scenario generator.
//!
//! Mirrors [`crate::simulator`] but targets the FT4 protocol: 4-FSK @ 12 kHz,
//! 48 ms symbols, 103 active symbols → 4.944 s of audio within a 7.5 s slot.
//! SNR convention identical (WSJT-X, 2500 Hz reference bandwidth).

use std::f32::consts::PI;

use mfsk_core::ft4::encode::{message_to_tones, tones_to_f32};

const FS: f32 = 12_000.0;
const REF_BW: f32 = 2_500.0;
/// FT4 slot length in samples at 12 kHz (7.5 s).
pub const SLOT_SAMPLES: usize = 90_000;

/// One synthetic FT4 signal to mix into a slot.
pub struct SimSignal {
    pub message77: [u8; 77],
    pub freq_hz: f32,
    pub snr_db: f32,
    /// Seconds relative to the nominal 0.5 s frame-start offset inside the slot.
    pub dt_sec: f32,
}

pub struct SimConfig {
    pub signals: Vec<SimSignal>,
    pub noise_seed: Option<u64>,
}

// Simple LCG + Box-Muller Gaussian RNG (reused from FT8 simulator shape).
struct LcgRng {
    state: u64,
    spare: Option<f32>,
}

impl LcgRng {
    fn new(seed: u64) -> Self {
        Self { state: seed.wrapping_add(1), spare: None }
    }
    fn next_u64(&mut self) -> u64 {
        self.state = self
            .state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.state
    }
    fn uniform(&mut self) -> f32 {
        ((self.next_u64() >> 11) as f32 + 1.0) / ((1u64 << 53) as f32 + 1.0)
    }
    fn gaussian(&mut self) -> f32 {
        if let Some(s) = self.spare.take() {
            return s;
        }
        let u = self.uniform();
        let v = self.uniform();
        let mag = (-2.0 * u.ln()).sqrt();
        let z0 = mag * (2.0 * PI * v).cos();
        let z1 = mag * (2.0 * PI * v).sin();
        self.spare = Some(z1);
        z0
    }
}

/// Generate a 7.5-s FT4 slot mix as i16 PCM.
pub fn generate_slot(config: &SimConfig) -> Vec<i16> {
    let mut mix = vec![0.0f32; SLOT_SAMPLES];
    for sig in &config.signals {
        let snr_linear = 10f32.powf(sig.snr_db / 10.0);
        // WSJT-X / weakmon convention: noise σ² = 1 per sample,
        // one-sided noise PSD over the Nyquist band FS/2 = 6 kHz.
        // Noise power in REF_BW = 2·σ²·B/FS = 2·2500/12000 = 5/12 ≈ 0.417.
        // For SNR = signal_power / noise_power_in_REF_BW to match the
        // requested value, A²/2 = SNR · 2σ²·B/FS → A = sqrt(4·SNR·B/FS).
        let amplitude = (4.0 * snr_linear * REF_BW / FS).sqrt();
        let itone = message_to_tones(&sig.message77);
        let pcm = tones_to_f32(&itone, sig.freq_hz, amplitude);
        let start = ((0.5 + sig.dt_sec) * FS).round() as usize;
        let copy_len = pcm.len().min(SLOT_SAMPLES.saturating_sub(start));
        for i in 0..copy_len {
            mix[start + i] += pcm[i];
        }
    }
    let mut rng = LcgRng::new(config.noise_seed.unwrap_or(12345));
    for s in mix.iter_mut() {
        *s += rng.gaussian();
    }
    let peak = mix.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    let scale = if peak > 1e-6 { 29_000.0 / peak } else { 1.0 };
    mix.iter()
        .map(|&s| (s * scale).clamp(-32_768.0, 32_767.0) as i16)
        .collect()
}

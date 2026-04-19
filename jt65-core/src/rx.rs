//! JT65 receiver: audio → 63 hard-decision RS symbols → message.
//!
//! JT65 demodulation is hard-decision (unlike FT8/FT4/FST4/WSPR's
//! bit-LLR path): for each of the 63 data positions we run a
//! symbol-length FFT and take the argmax across the 64 data-tone
//! bins. The resulting symbols are de-Gray'd, de-interleaved, and
//! fed straight to [`mfsk_fec::Rs63_12::decode_jt65`].
//!
//! Geometry: NSPS = 4460 samples at 12 kHz gives bin width ≈
//! 2.6906 Hz = one JT65A tone spacing.

use mfsk_core::ModulationParams;
use num_complex::Complex;
use rustfft::FftPlanner;

use crate::gray::inv_gray6;
use crate::interleave::deinterleave;
use crate::sync_pattern::JT65_NPRC;
use crate::Jt65;

/// Demodulate 63 data symbols from aligned audio. Returns the 63
/// hard-decision symbols in **RS codeword order** (Gray-decoded and
/// de-interleaved), ready for [`Rs63_12::decode_jt65`].
pub fn demodulate_aligned(
    audio: &[f32],
    sample_rate: u32,
    start_sample: usize,
    base_freq_hz: f32,
) -> Option<[u8; 63]> {
    let nsps = (sample_rate as f32 * <Jt65 as ModulationParams>::SYMBOL_DT).round() as usize;
    let df = sample_rate as f32 / nsps as f32; // ≡ TONE_SPACING_HZ
    let base_bin = (base_freq_hz / df).round() as usize;

    // Sanity bounds.
    if start_sample + 126 * nsps > audio.len() || base_bin + 66 >= nsps / 2 {
        return None;
    }

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(nsps);
    let mut scratch = vec![Complex::new(0f32, 0f32); fft.get_inplace_scratch_len()];
    let mut buf: Vec<Complex<f32>> = vec![Complex::new(0f32, 0f32); nsps];

    // Walk 126 symbol windows. For data positions, argmax the 64
    // data-tone bins (indices `base_bin + 2..=base_bin + 65`).
    let mut symbols = [0u8; 63];
    let mut k = 0usize;

    for sym_idx in 0..126 {
        let sym_start = start_sample + sym_idx * nsps;
        for (slot, &s) in buf.iter_mut().zip(&audio[sym_start..sym_start + nsps]) {
            *slot = Complex::new(s, 0.0);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);

        if JT65_NPRC[sym_idx] == 1 {
            continue; // sync position, no data
        }

        // Find the loudest tone among the 64 data tones (index 2..=65).
        let mut best = 0u8;
        let mut best_pwr = f32::NEG_INFINITY;
        for tone in 0u8..64 {
            let bin = base_bin + 2 + tone as usize;
            let p = buf[bin].norm_sqr();
            if p > best_pwr {
                best_pwr = p;
                best = tone;
            }
        }
        symbols[k] = inv_gray6(best);
        k += 1;
    }
    debug_assert_eq!(k, 63);

    // De-interleave (inverse of the TX 7×9 transpose).
    deinterleave(&mut symbols);
    Some(symbols)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tx::synthesize_standard;
    use mfsk_core::{DecodeContext, MessageCodec};
    use mfsk_fec::Rs63_12;
    use mfsk_msg::{Jt72Codec, Jt72Message};

    #[test]
    fn synth_decode_roundtrip_cq_k1abc_fn42() {
        let freq = 1270.0;
        let audio = synthesize_standard("CQ", "K1ABC", "FN42", 12_000, freq, 0.3)
            .expect("pack+synth");
        let received = demodulate_aligned(&audio, 12_000, 0, freq).expect("demod");
        let rs = Rs63_12::new();
        let (info, nerr) = rs.decode_jt65(&received).expect("clean decode");
        assert_eq!(nerr, 0, "clean synth should have zero errors");

        // Pack 12 × 6-bit words into 72 MSB-first bits, then unpack
        // via Jt72 codec.
        let mut payload = [0u8; 72];
        for (i, bit) in payload.iter_mut().enumerate() {
            let word = info[i / 6];
            let shift = 5 - (i % 6);
            *bit = (word >> shift) & 1;
        }
        let msg = Jt72Codec::default()
            .unpack(&payload, &DecodeContext::default())
            .expect("unpack");
        match msg {
            Jt72Message::Standard { call1, call2, grid_or_report } => {
                assert_eq!(call1, "CQ");
                assert_eq!(call2, "K1ABC");
                assert_eq!(grid_or_report, "FN42");
            }
            other => panic!("expected Standard, got {:?}", other),
        }
    }
}

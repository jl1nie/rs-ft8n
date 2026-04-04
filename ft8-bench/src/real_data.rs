/// Evaluate the ft8-core decoder against real recorded FT8 WAV files.
///
/// Reference recordings from jl1nie/RustFT8:
///   data/191111_110130.wav  (15 s, 12000 Hz, 16-bit PCM mono)
///   data/191111_110200.wav
use std::path::Path;

use ft8_core::decode::{decode_frame, decode_frame_subtract, DecodeDepth, DecodeResult};
use ft8_core::message::unpack77;

// ────────────────────────────────────────────────────────────────────────────

pub struct RealDataReport {
    pub wav_path: String,
    pub sample_rate: u32,
    pub num_samples: usize,
    /// Single-pass decode results
    pub messages: Vec<DecodeResult>,
    /// Multi-pass subtract decode results
    pub messages_subtract: Vec<DecodeResult>,
}

fn format_result(i: usize, r: &DecodeResult) -> String {
    let text = unpack77(&r.message77)
        .unwrap_or_else(|| "<undecodable>".to_string());
    format!(
        "  [{i:2}] freq={:7.1} Hz  dt={:+.2} s  errors={:2}  pass={}  \"{}\"",
        r.freq_hz, r.dt_sec, r.hard_errors, r.pass, text
    )
}

impl RealDataReport {
    pub fn print(&self) {
        println!("=== {} ===", self.wav_path);
        println!(
            "  WAV: {} Hz, {} samples ({:.1} s)",
            self.sample_rate,
            self.num_samples,
            self.num_samples as f64 / self.sample_rate as f64
        );

        // Single-pass
        println!("  [single-pass] Decoded: {} message(s)", self.messages.len());
        for (i, r) in self.messages.iter().enumerate() {
            println!("{}", format_result(i, r));
        }

        // Subtract: show only messages gained in later passes
        let extra: Vec<&DecodeResult> = self.messages_subtract
            .iter()
            .filter(|r| !self.messages.iter().any(|m| m.message77 == r.message77))
            .collect();

        if extra.is_empty() {
            println!("  [subtract   ] no additional messages");
        } else {
            println!("  [subtract   ] +{} additional message(s):", extra.len());
            for (i, r) in extra.iter().enumerate() {
                println!("{}", format_result(i, r));
            }
        }
        println!();
    }
}

// ────────────────────────────────────────────────────────────────────────────

/// Decode a real 15-second WAV file over the full FT8 band (200–2800 Hz).
///
/// The WAV must be mono 16-bit PCM at 12 000 Hz (standard FT8 audio).
pub fn evaluate_real_data(wav_path: &Path) -> Result<RealDataReport, String> {
    let mut reader =
        hound::WavReader::open(wav_path).map_err(|e| format!("open WAV: {e}"))?;

    let spec = reader.spec();
    if spec.channels != 1 {
        return Err(format!(
            "expected mono WAV, got {} channels",
            spec.channels
        ));
    }
    if spec.sample_rate != 12_000 {
        return Err(format!(
            "expected 12000 Hz WAV, got {} Hz",
            spec.sample_rate
        ));
    }

    let samples: Vec<i16> = match spec.sample_format {
        hound::SampleFormat::Int if spec.bits_per_sample == 16 => reader
            .samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read samples: {e}"))?,
        hound::SampleFormat::Int if spec.bits_per_sample == 8 => reader
            .samples::<i8>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read samples: {e}"))?
            .into_iter()
            .map(|s| (s as i16) << 8)
            .collect(),
        _ => {
            return Err(format!(
                "unsupported WAV format: {:?} {}bps",
                spec.sample_format, spec.bits_per_sample
            ))
        }
    };

    let num_samples = samples.len();

    let messages = decode_frame(
        &samples,
        200.0,
        2800.0,
        1.5,
        None,
        DecodeDepth::BpAllOsd,
        200,
    );

    let messages_subtract = decode_frame_subtract(
        &samples,
        200.0,
        2800.0,
        1.5,
        None,
        DecodeDepth::BpAllOsd,
        200,
    );

    Ok(RealDataReport {
        wav_path: wav_path.display().to_string(),
        sample_rate: spec.sample_rate,
        num_samples,
        messages,
        messages_subtract,
    })
}

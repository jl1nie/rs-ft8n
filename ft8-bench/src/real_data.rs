/// Evaluate the ft8-core decoder against real recorded FT8 WAV files.
///
/// Reference recordings from jl1nie/RustFT8:
///   data/191111_110130.wav  (15 s, 12000 Hz, 16-bit PCM mono)
///   data/191111_110200.wav
use std::path::Path;

use ft8_core::decode::{decode_frame, decode_frame_subtract, DecodeDepth, DecodeResult, DecodeStrictness};
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
        "  [{i:2}] freq={:7.1} Hz  dt={:+.2} s  snr={:+5.1} dB  errors={:2}  pass={}  \"{}\"",
        r.freq_hz, r.dt_sec, r.snr_db, r.hard_errors, r.pass, text
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
        DecodeStrictness::Normal,
    );

    Ok(RealDataReport {
        wav_path: wav_path.display().to_string(),
        sample_rate: spec.sample_rate,
        num_samples,
        messages,
        messages_subtract,
    })
}

// ────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use ft8_core::message::unpack77;

    /// Verify the decoder against a real WSJT-X recording.
    ///
    /// WAV source: https://github.com/jl1nie/RustFT8/tree/main/data
    ///   191111_110200.wav  — mono 12 kHz 16-bit PCM, typical busy 40m band
    ///
    /// To run: place the WAV in ft8-bench/testdata/ then:
    ///   cargo test -p ft8-bench real_wav -- --ignored --nocapture
    ///
    /// WSJT-X reference decode list for 191111_110200.wav (from WSJT-X 2.2):
    ///   CQ LZ1JZ KN22, JA4HXF JH1HHC PM95, K5RHR JA8LN PM74, etc.
    ///   Any run producing ≥ 8 messages with LZ1JZ and JH1HHC is correct.
    #[test]
    #[ignore = "requires 191111_110200.wav in testdata/ (download from jl1nie/RustFT8)"]
    fn real_wav_110200_decodes_known_callsigns() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("testdata")
            .join("191111_110200.wav");

        assert!(
            path.exists(),
            "WAV not found: {}  —  place 191111_110200.wav from jl1nie/RustFT8 data/ in testdata/",
            path.display()
        );

        let report = evaluate_real_data(&path).expect("decode failed");

        // Collect all decoded text messages (single-pass + subtract).
        let all_msgs: Vec<String> = report
            .messages_subtract
            .iter()
            .filter_map(|r| unpack77(&r.message77))
            .collect();

        println!("Decoded {} messages:", all_msgs.len());
        for m in &all_msgs {
            println!("  {m}");
        }

        // Must decode a reasonable number of messages from a busy band.
        assert!(
            all_msgs.len() >= 8,
            "too few messages decoded ({}) — decoder may not be WSJT-X compatible",
            all_msgs.len()
        );

        // Verify at least one message contains LZ1JZ (CQ from KN22).
        // This callsign appears clearly in the band and WSJT-X always decodes it.
        let has_lz1jz = all_msgs.iter().any(|m| m.contains("LZ1JZ"));
        assert!(
            has_lz1jz,
            "LZ1JZ not found in decoded messages — decoder is not WSJT-X compatible\n\
             All messages: {all_msgs:?}"
        );
    }

    /// Same check on 191111_110130.wav.
    #[test]
    #[ignore = "requires 191111_110130.wav in testdata/ (download from jl1nie/RustFT8)"]
    fn real_wav_110130_decodes_messages() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("testdata")
            .join("191111_110130.wav");

        assert!(path.exists(), "WAV not found: {}", path.display());

        let report = evaluate_real_data(&path).expect("decode failed");

        let all_msgs: Vec<String> = report
            .messages_subtract
            .iter()
            .filter_map(|r| unpack77(&r.message77))
            .collect();

        println!("Decoded {} messages:", all_msgs.len());
        for m in &all_msgs {
            println!("  {m}");
        }

        assert!(
            all_msgs.len() >= 5,
            "too few messages decoded ({}) — decoder may not be WSJT-X compatible",
            all_msgs.len()
        );
    }
}

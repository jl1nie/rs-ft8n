//! Generic DSP primitives shared by every MFSK protocol.
//!
//! Nothing in this module knows about FT8, FT4 or any specific modulation —
//! it operates on raw sample buffers, sample rates, and target frequencies.
//! Protocol-aware DSP (sync correlators, LLR, etc.) lives outside `dsp`.

pub mod downsample;
pub mod resample;

pub use downsample::{DownsampleCfg, build_fft_cache, downsample, downsample_cached};
pub use resample::{resample_f32_to_12k, resample_to_12k};

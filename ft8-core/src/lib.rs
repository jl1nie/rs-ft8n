//! # ft8-core
//!
//! Pure-Rust FT8 decoder library.
//!
//! ## Sample rate
//!
//! The internal decode pipeline assumes **12 000 Hz** PCM input.
//! For other sample rates (e.g. 44 100, 48 000 Hz), use
//! [`resample::resample_to_12k`] to convert before calling
//! [`decode::decode_frame`] or [`decode::decode_sniper_ap`].
//!
//! The WASM wrapper (`ft8-web`) accepts a `sample_rate` parameter
//! on each decode function and handles this conversion automatically.

pub mod params;
pub mod ldpc;
pub mod downsample;
pub mod sync;
pub mod llr;
pub mod wave_gen;
pub mod subtract;
pub mod equalizer;
pub mod decode;
pub mod message;
pub mod hash_table;
pub mod resample;

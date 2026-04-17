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
//!
//! ## Protocol trait
//!
//! The zero-sized [`Ft8`] type implements the generic
//! [`mfsk_core::Protocol`] trait so downstream pipeline code (shared with
//! FT4, FT2, FST4) can dispatch on `P: Protocol` at compile time.

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

use mfsk_core::{FrameLayout, ModulationParams, Protocol, ProtocolId};
use mfsk_fec::Ldpc174_91;
use mfsk_msg::Wsjt77Message;

/// FT8 protocol marker: 8-GFSK, 79 symbols over a 15 s slot, 6.25 Hz tone
/// spacing, three 7-symbol Costas arrays, LDPC(174,91) FEC, WSJT 77-bit
/// message payload. Carries no data — used as a type-level switch.
#[derive(Copy, Clone, Debug, Default)]
pub struct Ft8;

impl ModulationParams for Ft8 {
    const NTONES: u32 = params::NTONES as u32;
    const BITS_PER_SYMBOL: u32 = 3;
    const NSPS: u32 = params::NSPS as u32;
    const SYMBOL_DT: f32 = params::SYMBOL_DT;
    const TONE_SPACING_HZ: f32 = 6.25;
    const GRAY_MAP: &'static [u8] = &FT8_GRAY_MAP;
}

impl FrameLayout for Ft8 {
    const N_DATA: u32 = params::ND as u32;
    const N_SYNC: u32 = params::NS as u32;
    const N_SYMBOLS: u32 = params::NN as u32;
    const SYNC_PATTERN: &'static [u8] = &FT8_COSTAS;
    const SYNC_POSITIONS: &'static [u32] = &FT8_COSTAS_POS;
    const T_SLOT_S: f32 = 15.0;
}

impl Protocol for Ft8 {
    type Fec = Ldpc174_91;
    type Msg = Wsjt77Message;
    const ID: ProtocolId = ProtocolId::Ft8;
}

// `params::GRAYMAP` / `params::COSTAS` / `params::COSTAS_POS` are `[usize; _]`
// for historical reasons, but `ModulationParams::GRAY_MAP` etc. require
// `&'static [u8]`. Narrow them here at compile time.
const FT8_GRAY_MAP: [u8; 8] = {
    let mut out = [0u8; 8];
    let mut i = 0;
    while i < 8 {
        out[i] = params::GRAYMAP[i] as u8;
        i += 1;
    }
    out
};

const FT8_COSTAS: [u8; 7] = {
    let mut out = [0u8; 7];
    let mut i = 0;
    while i < 7 {
        out[i] = params::COSTAS[i] as u8;
        i += 1;
    }
    out
};

const FT8_COSTAS_POS: [u32; 3] = {
    let mut out = [0u32; 3];
    let mut i = 0;
    while i < 3 {
        out[i] = params::COSTAS_POS[i] as u32;
        i += 1;
    }
    out
};

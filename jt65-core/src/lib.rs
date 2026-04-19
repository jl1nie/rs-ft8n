//! # jt65-core
//!
//! JT65 protocol implementation on the `mfsk-*` stack.
//!
//! JT65 uses:
//! - **65-FSK** modulation (1 sync tone at index 0 + 64 data tones
//!   at indices 2..=65; index 1 is unused). Plain FSK, no GFSK.
//! - **RS(63, 12) over GF(2^6)** for error correction (51 parity
//!   symbols, corrects up to 25 symbol errors). Implemented in
//!   [`mfsk_fec::Rs63_12`].
//! - **72-bit JT message payload** packed into 12 × 6-bit symbols —
//!   the same layout as JT9 ([`mfsk_msg::Jt72Codec`]).
//! - **Pseudo-random distributed sync**: a fixed 126-bit pattern
//!   (`nprc`) marks 63 positions that carry tone 0 (sync) and 63
//!   that carry Gray-coded data symbols. Expressed in our abstraction
//!   as 63 length-1 `SyncBlock` entries under the existing
//!   `SyncMode::Block` variant — no new `SyncMode` case required.
//!
//! Only the **JT65A** sub-mode (tone spacing = baud ≈ 2.69 Hz) is
//! currently wired. JT65B and JT65C differ by a tone-spacing
//! multiplier (2×, 4×) and can be added as separate ZSTs sharing
//! every other piece.
//!
//! References:
//! - WSJT-X `lib/jt65sim.f90`, `lib/setup65.f90`, `lib/interleave63.f90`,
//!   `lib/graycode65.f90`, `lib/wrapkarn.c`

use mfsk_core::{FrameLayout, ModulationParams, Protocol, ProtocolId, SyncMode};
use mfsk_fec::Rs63_12;
use mfsk_msg::Jt72Codec;

pub mod gray;
pub mod interleave;
pub mod rx;
pub mod sync_pattern;
pub mod tx;

pub use gray::{gray6, inv_gray6};
pub use interleave::{deinterleave, interleave};
pub use rx::demodulate_aligned;
pub use sync_pattern::{
    JT65_DATA_POSITIONS, JT65_NPRC, JT65_SYNC_BLOCKS, JT65_SYNC_POSITIONS,
};
pub use tx::{encode_channel_symbols, synthesize_audio, synthesize_standard};

/// Top-level: decode a JT65 signal at a known (start_sample, base_freq)
/// and return the recovered message if RS succeeds. Mirrors the shape of
/// `jt9_core::decode_at`.
pub fn decode_at(
    audio: &[f32],
    sample_rate: u32,
    start_sample: usize,
    base_freq_hz: f32,
) -> Option<mfsk_msg::Jt72Message> {
    use mfsk_core::{DecodeContext, MessageCodec};

    let received = rx::demodulate_aligned(audio, sample_rate, start_sample, base_freq_hz)?;
    let rs = Rs63_12::new();
    let (info, _nerr) = rs.decode_jt65(&received)?;
    let mut payload = [0u8; 72];
    for (i, bit) in payload.iter_mut().enumerate() {
        let word = info[i / 6];
        let shift = 5 - (i % 6);
        *bit = (word >> shift) & 1;
    }
    mfsk_msg::Jt72Codec::default().unpack(&payload, &DecodeContext::default())
}

/// JT65A protocol marker.
///
/// The `A` sub-mode uses the native baud ≈ 2.69 Hz tone spacing
/// (12 000 / 4460 Hz). B and C modes share everything else but
/// apply 2×/4× multipliers to the spacing.
#[derive(Copy, Clone, Debug, Default)]
pub struct Jt65;

impl ModulationParams for Jt65 {
    /// 66 = max tone index (65) + 1. Tones 2..=65 are the 64 data
    /// tones; tone 0 is sync; tone 1 is unused (a single-slot gap
    /// above the sync tone, a quirk of the WSJT-X tone numbering).
    const NTONES: u32 = 66;
    const BITS_PER_SYMBOL: u32 = 6;
    /// 4460 samples/symbol at 12 kHz gives baud ≈ 2.6906 Hz — the
    /// canonical rounded value WSJT-X uses internally derives from
    /// 11 025 / 4096 but the integer-sample convention in our
    /// pipeline is NSPS.
    const NSPS: u32 = 4460;
    const SYMBOL_DT: f32 = 4460.0 / 12_000.0;
    const TONE_SPACING_HZ: f32 = 12_000.0 / 4460.0; // ≈ 2.6906 Hz
    /// No Gray map here — Gray is applied at the *symbol* level
    /// (6-bit) in [`gray::gray6`], not at the FSK-tone level. A
    /// minimal identity map satisfies the trait's `GRAY_MAP.len()
    /// == NTONES` invariant.
    const GRAY_MAP: &'static [u8] = &IDENTITY_66;
    const GFSK_BT: f32 = 0.0; // plain FSK
    const GFSK_HMOD: f32 = 1.0;
    const NFFT_PER_SYMBOL_FACTOR: u32 = 2;
    const NSTEP_PER_SYMBOL: u32 = 2;
    /// 12 000 / 4 = 3000 Hz baseband (enough for the 65-tone span).
    const NDOWN: u32 = 4;
}

const IDENTITY_66: [u8; 66] = {
    let mut m = [0u8; 66];
    let mut i = 0usize;
    while i < 66 {
        m[i] = i as u8;
        i += 1;
    }
    m
};

impl FrameLayout for Jt65 {
    const N_DATA: u32 = 63;
    const N_SYNC: u32 = 63;
    const N_SYMBOLS: u32 = 126;
    const N_RAMP: u32 = 0;
    const SYNC_MODE: SyncMode = SyncMode::Block(&JT65_SYNC_BLOCKS);
    /// 46.8-second frame, scheduled in 60-second slots with a few
    /// seconds of leading silence — matches WSJT-X's JT65 slot.
    const T_SLOT_S: f32 = 60.0;
    const TX_START_OFFSET_S: f32 = 0.0;
}

impl Protocol for Jt65 {
    /// Reed-Solomon (63, 12) over GF(2^6). Does NOT implement
    /// `FecCodec` (bit-LLR oriented) — jt65-core's decode path
    /// bypasses the generic pipeline and calls the symbol-level
    /// API directly. Declared here so the protocol's FEC intent
    /// is still visible in the trait surface.
    type Fec = Rs63_12;
    /// 72-bit message payload (12 × 6-bit words), shared with JT9.
    type Msg = Jt72Codec;
    const ID: ProtocolId = ProtocolId::Jt65;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jt65_trait_surface() {
        assert_eq!(<Jt65 as ModulationParams>::NTONES, 66);
        assert_eq!(<Jt65 as ModulationParams>::BITS_PER_SYMBOL, 6);
        assert_eq!(<Jt65 as ModulationParams>::NSPS, 4460);
        assert_eq!(<Jt65 as FrameLayout>::N_SYMBOLS, 126);
        assert_eq!(<Jt65 as FrameLayout>::N_DATA, 63);
        assert_eq!(<Jt65 as FrameLayout>::N_SYNC, 63);
        match <Jt65 as FrameLayout>::SYNC_MODE {
            SyncMode::Block(blocks) => {
                assert_eq!(blocks.len(), 63);
                for b in blocks {
                    assert_eq!(b.pattern, &[0u8]);
                }
            }
            SyncMode::Interleaved { .. } => panic!("JT65 must use Block sync"),
        }
        // RS(63, 12) doesn't implement FecCodec — we only verify the
        // associated-type wiring compiles by spelling the path out.
        let _fec = Rs63_12::default();
    }
}

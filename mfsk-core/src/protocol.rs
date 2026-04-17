//! Protocol trait hierarchy.
//!
//! A `Protocol` is a zero-sized type that ties together the four axes of
//! variation across WSJT-family digital modes:
//!
//! | Axis               | Trait              | Examples                          |
//! |--------------------|--------------------|-----------------------------------|
//! | Tones / baseband   | `ModulationParams` | 8-FSK @ 6.25 Hz (FT8) vs 4-FSK (FT4) |
//! | Frame layout       | `FrameLayout`      | Costas pattern, sync positions    |
//! | FEC                | `FecCodec`         | LDPC(174,91) / Reed–Solomon / Fano |
//! | Message payload    | `MessageCodec`     | WSJT 77-bit / JT 72-bit / WSPR 50 |
//!
//! Splitting the traits lets implementations share code: FT4 reuses FT8's
//! `Ldpc174_91` and `Wsjt77Message` and differs only in `ModulationParams` +
//! `FrameLayout`, so SIMD optimisations to the shared LDPC decoder
//! automatically benefit every LDPC-based protocol.

/// Runtime protocol tag — used at FFI boundaries where generics cannot cross
/// the C ABI. Order is stable; append new variants at the end.
#[repr(u8)]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
pub enum ProtocolId {
    Ft8 = 0,
    Ft4 = 1,
    Ft2 = 2,
    Fst4 = 3,
    Jt65 = 4,
    Jt9 = 5,
    Wspr = 6,
}

/// Baseband modulation parameters (tones, symbol rate, Gray mapping).
///
/// All constants are evaluated at compile time; the trait carries no data so
/// implementors are typically zero-sized types.
pub trait ModulationParams: Copy + Default + 'static {
    /// Number of FSK tones (M in M-ary FSK).
    const NTONES: u32;

    /// Information bits carried per modulated symbol (= log2(NTONES)).
    const BITS_PER_SYMBOL: u32;

    /// Samples per symbol at the 12 kHz pipeline sample rate.
    const NSPS: u32;

    /// Symbol duration in seconds (= NSPS / 12000).
    const SYMBOL_DT: f32;

    /// Spacing between adjacent tones, in Hz.
    const TONE_SPACING_HZ: f32;

    /// Gray-code map: `GRAY_MAP[tone_index]` returns the NATURAL-bit pattern
    /// for that tone. Length must equal `NTONES`.
    const GRAY_MAP: &'static [u8];
}

/// Frame structure: data / sync symbol counts and the Costas-style sync
/// pattern.
pub trait FrameLayout: Copy + Default + 'static {
    /// Data symbols carrying FEC-coded payload.
    const N_DATA: u32;

    /// Sync symbols (Costas arrays, pilot tones, …).
    const N_SYNC: u32;

    /// Total channel symbols per frame (= N_DATA + N_SYNC).
    const N_SYMBOLS: u32;

    /// Repeating tone pattern of a single Costas / pilot block.
    const SYNC_PATTERN: &'static [u8];

    /// Symbol indices at which each copy of `SYNC_PATTERN` begins within the
    /// frame. E.g. FT8 has three Costas arrays at symbols {0, 36, 72}.
    const SYNC_POSITIONS: &'static [u32];

    /// Nominal TX/RX slot length in seconds (informational — used by schedulers
    /// and UI, not by the DSP pipeline).
    const T_SLOT_S: f32;
}

// ──────────────────────────────────────────────────────────────────────────
// FEC
// ──────────────────────────────────────────────────────────────────────────

/// Options controlling FEC decoding depth / fall-backs.
///
/// This is deliberately a plain data struct rather than a trait — it describes
/// *how* to decode, not *what* code to use. Codecs ignore fields that don't
/// apply (e.g. convolutional decoders ignore `osd_depth`).
#[derive(Copy, Clone, Debug)]
pub struct FecOpts {
    /// Maximum belief-propagation iterations (LDPC).
    pub bp_max_iter: u32,
    /// Ordered-statistics-decoding search depth (0 disables OSD fallback).
    pub osd_depth: u32,
    /// Optional a-priori hint: bits whose LLR should be clamped to a strong
    /// known value before decoding. `Some((mask, values))` where `mask[i] == 1`
    /// means `values[i]` is locked.
    pub ap_mask: Option<(&'static [u8], &'static [u8])>,
}

impl Default for FecOpts {
    fn default() -> Self {
        Self {
            bp_max_iter: 30,
            osd_depth: 0,
            ap_mask: None,
        }
    }
}

/// Result of a successful FEC decode.
#[derive(Clone, Debug)]
pub struct FecResult {
    /// Hard-decision information bits (length = `FecCodec::K`).
    pub info: Vec<u8>,
    /// Number of hard-decision errors corrected (for quality metric).
    pub hard_errors: u32,
    /// Iterations consumed (0 if N/A).
    pub iterations: u32,
}

/// Forward-error-correction codec: maps `K` information bits ↔ `N` codeword
/// bits.
///
/// Implementors MUST be `Default`-constructible so generic pipeline code can
/// obtain an instance via `P::Fec::default()` without plumbing state.
/// Stateless codecs (matrices in `const` / `static`) are the common case.
pub trait FecCodec: Default + 'static {
    /// Codeword length.
    const N: usize;

    /// Information-bit length.
    const K: usize;

    /// Systematic encode: `info.len() == K`, `codeword.len() == N`. The first
    /// `K` bits of `codeword` must equal `info` (systematic form).
    fn encode(&self, info: &[u8], codeword: &mut [u8]);

    /// Soft-decision decode from log-likelihood ratios.
    ///
    /// `llr.len() == N`. On success returns the `K` information bits plus
    /// decoder statistics. On failure returns `None`.
    fn decode_soft(&self, llr: &[f32], opts: &FecOpts) -> Option<FecResult>;
}

// ──────────────────────────────────────────────────────────────────────────
// Message codec
// ──────────────────────────────────────────────────────────────────────────

/// Human-facing message payload codec (callsigns, grids, reports, free text).
///
/// Operates on the FEC-decoded information bits (`PAYLOAD_BITS` wide, NOT
/// including any CRC protecting them — callers handle the CRC layer).
///
/// Unlike `FecCodec`, this trait is an acceptable place for `dyn` when the
/// caller juggles heterogeneous protocols at runtime (FFI, CLI dump tools):
/// message unpacking is a cold path relative to DSP/FEC inner loops.
pub trait MessageCodec: Default + 'static {
    /// Decoded high-level representation returned by `unpack`.
    type Unpacked;

    /// Number of information bits consumed by `pack` / produced by `unpack`.
    const PAYLOAD_BITS: u32;

    /// CRC width guarding the payload during transmission (0 if the FEC itself
    /// provides all error detection, as with JT65 Reed–Solomon).
    const CRC_BITS: u32;

    /// Encode high-level fields to a bit vector of length `PAYLOAD_BITS`.
    /// Returns `None` on encoding failure (invalid callsign format, overflow…).
    fn pack(&self, fields: &MessageFields) -> Option<Vec<u8>>;

    /// Decode a `PAYLOAD_BITS`-long bit vector to the protocol-specific
    /// unpacked representation. `ctx` carries side information such as the
    /// callsign-hash table.
    fn unpack(&self, payload: &[u8], ctx: &DecodeContext) -> Option<Self::Unpacked>;
}

/// Generic input to `MessageCodec::pack` — protocol-specific codecs accept
/// the subset of fields they understand and return `None` for unsupported
/// combinations.
#[derive(Clone, Debug, Default)]
pub struct MessageFields {
    pub call1: Option<String>,
    pub call2: Option<String>,
    pub grid: Option<String>,
    pub report: Option<i32>,
    pub free_text: Option<String>,
}

/// Side information passed to `MessageCodec::unpack`.
///
/// `callsign_hash_table` is an opaque pointer the protocol crate
/// downcasts to its own table type — generic code does not need to know the
/// shape. This keeps `mfsk-msg` optional at the `mfsk-core` level.
#[derive(Clone, Debug, Default)]
pub struct DecodeContext {
    /// Optional hashed-callsign lookup owned by the caller. Concrete layout is
    /// protocol-defined; interpret via `Any::downcast_ref` inside the codec.
    pub callsign_hash_table: Option<std::sync::Arc<dyn std::any::Any + Send + Sync>>,
}

// ──────────────────────────────────────────────────────────────────────────
// Protocol facade
// ──────────────────────────────────────────────────────────────────────────

/// The full protocol description: ties `ModulationParams`, `FrameLayout`, a
/// FEC codec and a message codec together under one trait for ergonomic
/// `<P: Protocol>` bounds.
pub trait Protocol: ModulationParams + FrameLayout + 'static {
    /// FEC codec carrying `N_DATA * BITS_PER_SYMBOL` coded bits.
    type Fec: FecCodec;

    /// Message codec consuming the FEC-decoded information bits.
    type Msg: MessageCodec;

    /// Runtime tag used at FFI / WASM boundaries.
    const ID: ProtocolId;
}

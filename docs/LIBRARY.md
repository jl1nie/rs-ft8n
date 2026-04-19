# rs-ft8n — Library Architecture & ABI Reference

> **日本語版:** [LIBRARY.ja.md](LIBRARY.ja.md)

This document covers the rs-ft8n library surface for embedders: Rust
crate consumers, C/C++ projects linking `libwsjt.so`, and
Kotlin/Android apps using the JNI scaffold.

## 0. Introduction

### 0.1 Background

The weak-signal digital modes addressed by this library — FT8, FT4,
FST4, WSPR and their siblings — were developed by Joe Taylor K1JT
and his collaborators as part of the WSJT-X project, which is the
reference implementation for the entire family. Every algorithm in
rs-ft8n (sync correlation, LLR computation, LDPC BP / OSD decoding,
Fano sequential decoding of convolutional codes, per-protocol
message encoding, …) is derived from WSJT-X. Each source file's
docstring cites the corresponding file under `lib/ft8/`, `lib/ft4/`,
`lib/fst4/`, or `lib/wsprd/`.

WSJT-X evolved as a C++ + Fortran desktop application, and has been
refined in that form over many years. Deploying those same
algorithms outside the desktop — running them in a browser PWA,
embedding them in a standalone Android app, or calling them as a
library from another Rust or C++ project — requires a non-trivial
amount of per-platform work if one starts from the upstream source.

### 0.2 Goal

rs-ft8n re-implements the WSJT-X algorithms in Rust and organises them
as a library that can be consumed identically from several runtimes
(native Rust, WebAssembly, Android JNI, C ABI). The aim is to keep
algorithmic equivalence with the upstream C++/Fortran code while
broadening the set of platforms that can host it.

### 0.3 Design approach

Protocol-independent algorithms — DSP, sync, LLR, the equaliser,
LDPC BP / OSD, Fano convolutional decoding, and the shared parts of
the message codec — live in the common crates `mfsk-core`,
`mfsk-fec`, and `mfsk-msg`. Each protocol is a comparatively small
zero-sized type (ZST) that declares its own constants and the
specific FEC / message codec it uses. The pipeline is expressed as
`decode_frame::<P>()`, taking `P: Protocol` as a compile-time type
parameter so that monomorphisation produces specialised code per
protocol. The abstraction does not add runtime cost.

Some direct consequences of this approach:

- The same algorithm implementation runs under native Rust, WASM,
  Android, and C / C++.
- Improvements to a shared path (e.g. LDPC BP) automatically benefit
  every protocol that uses it.
- Adding a new protocol tends to keep the diff confined to that
  protocol's own code (see §2 for the concrete steps).
- The C ABI in `wsjt-ffi` branches only once via `match protocol_id`;
  past that point, the code is already specialised.

### 0.4 Currently supported protocols

| Protocol   | Slot    | FEC                          | Message | Sync                 | Upstream source |
|------------|---------|------------------------------|---------|----------------------|-----------------|
| FT8        | 15 s    | LDPC(174, 91) + CRC-14        | 77 bit | 3×Costas-7           | `lib/ft8/`      |
| FT4        | 7.5 s   | LDPC(174, 91) + CRC-14        | 77 bit | 4×Costas-4           | `lib/ft4/`      |
| FST4-60A   | 60 s    | LDPC(240, 101) + CRC-24       | 77 bit | 5×Costas-8           | `lib/fst4/`     |
| WSPR       | 120 s   | convolutional r=½ K=32 + Fano | 50 bit | per-symbol LSB       | `lib/wsprd/`    |
| JT9        | 60 s    | convolutional r=½ K=32 + Fano | 72 bit | 16 distributed slots | `lib/jt9_decode.f90`, `lib/conv232.f90` |
| JT65       | 60 s    | Reed-Solomon(63, 12) GF(2⁶)   | 72 bit | 63 distributed slots (pseudo-random) | `lib/jt65_decode.f90`, `lib/wrapkarn.c` |

### 0.5 Checking that the design actually works — using WSPR

FT8, FT4 and FST4 share so much (LDPC FEC, 77-bit messages, block
Costas sync) that their common code is unavoidable rather than a
test of the abstraction. WSPR, in contrast, differs from the FT
family in three structural ways, which makes it a useful check on
whether the abstraction holds up.

1. **Different FEC family** — convolutional (r=1/2, K=32) with Fano
   sequential decoding instead of LDPC. Added as
   `mfsk_fec::conv::ConvFano`.
2. **Different message length** — 50 bits instead of 77. Types 1, 2
   and 3 are implemented in `mfsk_msg::wspr::Wspr50Message`.
3. **Different sync structure** — the lower bit of every channel
   symbol carries one bit of a fixed 162-bit sync vector, so sync is
   not a block of Costas arrays. Captured by adding an `Interleaved`
   variant to `FrameLayout::SYNC_MODE`.

Each of these touched a different axis of the trait surface. All
three were absorbed by adding new implementations / variants, and
the FT8 / FT4 / FST4 code paths were left alone. In practice, those
three protocols still use `SyncMode::Block` and emit the same bytes
they did before.

## 1. Crate layout

```
mfsk-core  ──┐
             │
mfsk-fec    ─┼─┐    (LDPC 174/91, LDPC 240/101, ConvFano r=1/2 K=32)
             │ │
mfsk-msg    ─┼─┼─┬── ft8-core   ──┐
             │ │ │                 │
             │ │ ├── ft4-core   ──┤
             │ │ │                 ├── ft8-web (WASM / PWA)
             │ │ ├── fst4-core  ──┤
             │ │ │                 │
             │ │ └── wspr-core  ──┼── wsjt-ffi (C ABI cdylib)
             │ │                   │         │
             │ │                   │         └── examples/{cpp_smoke, kotlin_jni}
             │ └── (future) rs codec (JT65)
             └── (future) jt72 msg codec (JT9 / JT65)
```

| Crate        | Role                                                                  |
|--------------|-----------------------------------------------------------------------|
| `mfsk-core`  | Protocol traits, DSP (resample / downsample / subtract / GFSK), sync, LLR, equalize, pipeline |
| `mfsk-fec`   | `FecCodec` implementations: `Ldpc174_91`, `Ldpc240_101`, `ConvFano`    |
| `mfsk-msg`   | 77-bit (`Wsjt77Message`) + 50-bit (`Wspr50Message`) message codecs, AP hints |
| `ft8-core`   | `Ft8` ZST + FT8-tuned decode orchestration (AP / sniper / SIC)        |
| `ft4-core`   | `Ft4` ZST + FT4-tuned entry points                                    |
| `fst4-core`  | `Fst4s60` ZST — 60-s sub-mode, LDPC(240, 101)                         |
| `wspr-core`  | `Wspr` ZST + WSPR TX synth / RX demod / spectrogram search            |
| `ft8-web`    | `wasm-bindgen` surface — FT8 / FT4 / WSPR exposed to the PWA          |
| `wsjt-ffi`   | C ABI cdylib + cbindgen-generated `include/wsjt.h`                    |

Each crate is `[package.edition = "2024"]`. `mfsk-core` is `no_std`-clean
in principle (rayon is optional behind the `parallel` feature).

## 2. Protocol trait hierarchy

Every supported mode is described by a zero-sized type that
implements three composable traits:

```rust
pub trait ModulationParams: Copy + Default + 'static {
    const NTONES: u32;
    const BITS_PER_SYMBOL: u32;
    const NSPS: u32;              // samples/symbol @ 12 kHz
    const SYMBOL_DT: f32;
    const TONE_SPACING_HZ: f32;
    const GRAY_MAP: &'static [u8];
    const GFSK_BT: f32;
    const GFSK_HMOD: f32;
    const NFFT_PER_SYMBOL_FACTOR: u32;
    const NSTEP_PER_SYMBOL: u32;
    const NDOWN: u32;
    const LLR_SCALE: f32 = 2.83;
}

pub trait FrameLayout: Copy + Default + 'static {
    const N_DATA: u32;
    const N_SYNC: u32;
    const N_SYMBOLS: u32;
    const N_RAMP: u32;
    const SYNC_MODE: SyncMode;  // Block(&[SyncBlock]) or Interleaved { .. }
    const T_SLOT_S: f32;
    const TX_START_OFFSET_S: f32;
}

pub enum SyncMode {
    /// Block-based Costas / pilot arrays at fixed symbol positions.
    /// Used by FT8 / FT4 / FST4.
    Block(&'static [SyncBlock]),
    /// Per-symbol bit-interleaved sync: one bit of a known sync vector
    /// is embedded at `sync_bit_pos` within every channel-symbol tone
    /// index. Used by WSPR (symbol = 2·data + sync_bit).
    Interleaved {
        sync_bit_pos: u8,
        vector: &'static [u8],
    },
}

pub trait Protocol: ModulationParams + FrameLayout + 'static {
    type Fec: FecCodec;
    type Msg: MessageCodec;
    const ID: ProtocolId;
}
```

### Worked examples — how the traits compose

Two concrete cases, taken from the corresponding crates, show how the
three traits combine on a real ZST.

**FT4** — a standard block-Costas protocol that shares its FEC and
message codec with FT8:

```rust
// ft4-core/src/lib.rs (abridged)
pub struct Ft4;

impl ModulationParams for Ft4 {
    const NTONES: u32 = 4;
    const BITS_PER_SYMBOL: u32 = 2;
    const NSPS: u32 = 576;          // 48 ms @ 12 kHz
    const TONE_SPACING_HZ: f32 = 20.833;
    const GRAY_MAP: &'static [u8] = &[0, 1, 3, 2];
    // … (GFSK_BT, NFFT_PER_SYMBOL_FACTOR, NDOWN, …)
}

impl FrameLayout for Ft4 {
    const N_DATA: u32 = 87;
    const N_SYNC: u32 = 16;
    const N_SYMBOLS: u32 = 103;
    const SYNC_MODE: SyncMode = SyncMode::Block(&FT4_SYNC_BLOCKS);
    const T_SLOT_S: f32 = 7.5;
    const TX_START_OFFSET_S: f32 = 0.5;
}

impl Protocol for Ft4 {
    type Fec = Ldpc174_91;          // shared with FT8
    type Msg = Wsjt77Message;       // shared with FT8
    const ID: ProtocolId = ProtocolId::Ft4;
}

const FT4_SYNC_BLOCKS: [SyncBlock; 4] = [
    SyncBlock { start_symbol:  0, pattern: &[0, 1, 3, 2] },
    SyncBlock { start_symbol: 33, pattern: &[1, 0, 2, 3] },
    SyncBlock { start_symbol: 66, pattern: &[2, 3, 1, 0] },
    SyncBlock { start_symbol: 99, pattern: &[3, 2, 0, 1] },
];
```

**WSPR** — structurally different on all three axes. The `Fec` and
`Msg` associated types switch to a new pair, and the sync is
expressed via `SyncMode::Interleaved`:

```rust
// wspr-core/src/lib.rs (abridged)
pub struct Wspr;

impl ModulationParams for Wspr {
    const NTONES: u32 = 4;
    const BITS_PER_SYMBOL: u32 = 2;
    const NSPS: u32 = 8192;                  // ~683 ms @ 12 kHz
    const TONE_SPACING_HZ: f32 = 12_000.0 / 8192.0;  // ≈ 1.4648
    const GRAY_MAP: &'static [u8] = &[0, 1, 2, 3];
    // …
}

impl FrameLayout for Wspr {
    const N_DATA: u32 = 162;
    const N_SYNC: u32 = 0;                   // sync is embedded in data symbols
    const N_SYMBOLS: u32 = 162;
    const SYNC_MODE: SyncMode = SyncMode::Interleaved {
        sync_bit_pos: 0,                     // LSB of the tone index
        vector: &WSPR_SYNC_VECTOR,           // 162-bit npr3
    };
    const T_SLOT_S: f32 = 120.0;
    const TX_START_OFFSET_S: f32 = 1.0;
}

impl Protocol for Wspr {
    type Fec = ConvFano;                     // convolutional + Fano
    type Msg = Wspr50Message;                // 50-bit message
    const ID: ProtocolId = ProtocolId::Wspr;
}
```

Calling code just passes the ZST as a type argument —
`decode_frame::<Ft4>(...)` or `decode_frame::<Wspr>(...)` — and the
trait composition pulls in the appropriate FEC, message codec, and
sync mode automatically.

### Monomorphisation & zero cost

All hot-path functions (`sync::coarse_sync<P>`, `llr::compute_llr<P>`,
`pipeline::process_candidate_basic<P>`, …) take `P: Protocol` as a
**compile-time** type parameter. rustc monomorphises one copy per
concrete protocol; LLVM sees a fully-specialised function and inlines
the trait constants as literals. The abstraction is free — the
generated FT8 code is byte-identical to the hand-written FT8-only
path the library was forked from, and FT4 benefits from every
micro-optimisation applied to the shared functions.

`dyn Trait` is reserved for cold paths only: the FFI boundary, the
protocol toggle in JS, and the `MessageCodec` that unpacks decoded
text (which runs once per successful decode, not once per candidate).

### Adding a new protocol

How much work a new protocol needs depends on how much of the
existing infrastructure it can reuse. In practice the cases fall
into three steps.

1. **Same FEC and same message as an existing mode** (e.g. FT2, or
   the other FST4 sub-modes). Define a new ZST and swap the numeric
   constants (`NTONES`, `NSPS`, `TONE_SPACING_HZ`, `SYNC_MODE`, and
   the sync pattern). `Fec` and `Msg` can be type aliases to the
   existing implementations, and the full `decode_frame::<P>()`
   pipeline runs unchanged.

2. **New FEC but same message** (e.g. a different LDPC size). Add
   the codec as a new module under `mfsk-fec` and implement
   `FecCodec` for it. The BP / OSD / systematic-encode algorithms
   generalise naturally across LDPC sizes, so the only real changes
   are the parity-check and generator tables and the code
   dimensions (N, K). `mfsk_fec::ldpc240_101` is the concrete
   example to follow.

3. **Both FEC and message are new** (e.g. WSPR). Add the FEC
   implementation, add the message codec, and — if the sync
   structure is fundamentally different — extend `SyncMode` with a
   new variant. WSPR was added via this route, introducing
   `ConvFano` + `Wspr50Message` + `SyncMode::Interleaved` while
   continuing to use the existing pipeline machinery (coarse
   search, spectrogram, candidate de-duplication, CRC check,
   message unpack).

JT65 (Reed–Solomon) and JT9 (convolutional, 72-bit) fall into
case 3. Each needs a new `FecCodec` and a new `MessageCodec`;
`SyncMode` already has the variants they require.

## 3. Shared primitives (`mfsk-core`)

### DSP (`mfsk_core::dsp`)

| Module           | Purpose                                                     |
|------------------|-------------------------------------------------------------|
| `resample`       | linear resampler to 12 kHz                                  |
| `downsample`     | FFT-based complex decimation (`DownsampleCfg`)              |
| `gfsk`           | GFSK tone-to-PCM synthesiser (`GfskCfg`)                    |
| `subtract`       | phase-continuous least-squares SIC (`SubtractCfg`)          |

Each takes a runtime `*Cfg` struct (not `<P>`) because the tuning
parameters include composite-FFT sizes that are not trivially derived
from trait constants alone. Protocol crates expose a `const *_CFG` for
each — `ft8-core::downsample::FT8_CFG`, `ft4-core::decode::FT4_DOWNSAMPLE`, etc.

### Sync (`mfsk_core::sync`)

* `coarse_sync::<P>(audio, freq_min, freq_max, …)` — UTC-aligned 2D
  peak search over `P::SYNC_MODE.blocks()`.
* `refine_candidate::<P>(cd0, cand, search_steps)` — integer-sample
  scan + parabolic sub-sample interpolation.
* `make_costas_ref(pattern, ds_spb)` / `score_costas_block(...)` — raw
  correlation helpers exposed for diagnostics and custom pipelines.

### LLR (`mfsk_core::llr`)

* `symbol_spectra::<P>(cd0, i_start)` — per-symbol FFT bins.
* `compute_llr::<P>(cs)` — four WSJT-style LLR variants (a/b/c/d).
* `sync_quality::<P>(cs)` — hard-decision sync symbol count.

### Equalise (`mfsk_core::equalize`)

* `equalize_local::<P>(cs)` — per-tone Wiener equaliser driven by
  `P::SYNC_MODE.blocks()` pilot observations; linearly extrapolates any tones
  that Costas doesn't visit.

### Pipeline (`mfsk_core::pipeline`)

* `decode_frame::<P>(...)` — coarse sync → parallel process_candidate → dedupe.
* `decode_frame_subtract::<P>(...)` — 3-pass SIC driver.
* `process_candidate_basic::<P>(...)` — single-candidate BP+OSD.

AP-aware variants live in `mfsk_msg::pipeline_ap` because AP hint
construction is 77-bit specific.

## 4. Feature flags

| Crate      | Feature        | Default | Effect                                                        |
|------------|----------------|---------|---------------------------------------------------------------|
| `mfsk-core`| `parallel`     | on      | Enables rayon `par_iter` in pipeline (no-op under WASM)       |
| `mfsk-msg` | `osd-deep`     | off     | Adds OSD-3 fallback to AP decodes under ≥55-bit lock          |
| `mfsk-msg` | `eq-fallback`  | off     | Lets `EqMode::Adaptive` fall back to non-EQ when EQ fails     |
| `ft8-core` | `parallel`     | on      | same as above, re-exported for convenience                    |

Both `osd-deep` and `eq-fallback` are heavy: they were measured to
boost FT4's −18 dB success rate by ~5/10 → 6/10 at the cost of ~10×
decode time. Left **off** by default so the stock build fits a 7.5 s
WASM slot comfortably; turn them on when running on a desktop where
CPU budget is abundant.

## 5. Using from Rust

### 5.1 Dependencies

```toml
[dependencies]
ft8-core  = { path = "../rs-ft8n/ft8-core" }
ft4-core  = { path = "../rs-ft8n/ft4-core" }
wspr-core = { path = "../rs-ft8n/wspr-core" }
mfsk-core = { path = "../rs-ft8n/mfsk-core" }
mfsk-msg  = { path = "../rs-ft8n/mfsk-msg" }
hound     = "3"   # for WAV reading (example only)
```

Pull in only the protocol crates you actually need; the example below
shows them all.

### 5.2 Using the composition — one `<P: Protocol>` helper for FT8 and FT4

The same ZSTs shown composing in §2 (`Ft4`, `Wspr`, …) can be passed
directly to `mfsk_core::pipeline::decode_frame::<P>`, a generic
function that holds the shared slot-decode logic. Writing one small
helper parameterised on `P: Protocol` and calling it with different
ZSTs is the most direct way to see the composition at work.

The program below reads FT8 and FT4 WAV files, runs them through the
same `decode_slot::<P>` helper with only the type argument and DSP
config changing, and prints every recovered message:

```rust
use ft4_core::Ft4;
use ft4_core::decode::FT4_DOWNSAMPLE;
use ft8_core::Ft8;
use ft8_core::downsample::FT8_CFG;
use mfsk_core::dsp::downsample::DownsampleCfg;
use mfsk_core::equalize::EqMode;
use mfsk_core::pipeline::{decode_frame, DecodeDepth, DecodeResult, DecodeStrictness};
use mfsk_core::Protocol;
use mfsk_msg::{wsjt77::unpack77_with_hash, CallsignHashTable};

/// Swap `P` for FT8 / FT4 / (FST4) and the same function works. Inside,
/// `P::Fec`, `P::Msg`, and `P::SYNC_MODE` get specialised at monomorphisation
/// time — LLVM sees a fully resolved per-protocol function.
fn decode_slot<P: Protocol>(
    audio: &[i16],
    cfg: &DownsampleCfg,
    freq_range: (f32, f32),
    sync_min: f32,
    max_cand: usize,
) -> Vec<DecodeResult> {
    let (results, _fft_cache) = decode_frame::<P>(
        audio,
        cfg,
        freq_range.0,
        freq_range.1,
        sync_min,
        /*freq_hint*/ None,
        DecodeDepth::BpAllOsd,
        max_cand,
        DecodeStrictness::Normal,
        EqMode::Off,
        /*refine_steps*/ 10,
        /*sync_q_min*/  0,
    );
    results
}

fn print_results(tag: &str, hash: &mut CallsignHashTable, results: Vec<DecodeResult>) {
    for r in results {
        let Some(text) = unpack77_with_hash(&r.message77, hash) else { continue };
        println!(
            "[{tag}] {:7.1} Hz  dt {:+.2} s  snr {:+.0} dB  {text}",
            r.freq_hz, r.dt_sec, r.snr_db,
        );
        // Remember callsigns so that subsequent slots can resolve the
        // `<…>` hash-abbreviated form back to a real call.
        for w in text.split_whitespace() {
            if w.chars().all(|c| c.is_ascii_alphanumeric() || c == '/') {
                hash.insert(w);
            }
        }
    }
}

fn load_wav_12k(path: &str) -> Result<Vec<i16>, Box<dyn std::error::Error>> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let raw: Vec<i16> = reader.samples::<i16>().collect::<Result<_, _>>()?;
    Ok(if spec.sample_rate == 12_000 {
        raw
    } else {
        mfsk_core::dsp::resample::resample_to_12k(&raw, spec.sample_rate)
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let ft8_audio = load_wav_12k("ft8.wav")?;   // 15-second slot
    let ft4_audio = load_wav_12k("ft4.wav")?;   // 7.5-second slot
    let mut hash = CallsignHashTable::new();

    // Same helper, different type argument.
    let ft8_results = decode_slot::<Ft8>(&ft8_audio, &FT8_CFG,
                                         (100.0, 3000.0), 1.5, 200);
    print_results("FT8", &mut hash, ft8_results);

    let ft4_results = decode_slot::<Ft4>(&ft4_audio, &FT4_DOWNSAMPLE,
                                         (300.0, 2700.0), 1.2, 50);
    print_results("FT4", &mut hash, ft4_results);

    Ok(())
}
```

The payoff from §2's trait composition shows up at
`decode_slot::<Ft8>(...)` versus `decode_slot::<Ft4>(...)`: the same
function body is reused, while the FEC (LDPC(174, 91)), message
codec (77-bit), and sync layout (`SyncMode::Block`) are picked up
automatically from each ZST's trait impls. FST4-60A works the same
way when called as `decode_slot::<Fst4s60>(...)`, though the
corresponding `DownsampleCfg` has not been exposed in the crate yet
at the time of writing.

### 5.3 WSPR — a separate demod path that still fits the abstraction

WSPR takes symbol-length FFTs directly at 12 kHz rather than
decimating to an FT-style baseband first, so its demodulation
pipeline is staged differently and isn't offered via
`decode_frame::<Wspr>`. `wspr-core` exposes its own entry points.
The FEC (`ConvFano`) and message codec (`Wspr50Message`) are still
declared as associated types on `impl Protocol for Wspr`, so the
trait surface remains consistent — only the slot-level decoder
differs.

```rust
use mfsk_msg::WsprMessage;
use wspr_core::decode::decode_scan_default;

let samples_f32: Vec<f32> = /* 120 s × 12 kHz of f32 samples */;

let decodes = decode_scan_default(&samples_f32, /*sample_rate*/ 12_000);
for d in decodes {
    match d.message {
        WsprMessage::Type1 { callsign, grid, power_dbm } => {
            println!("{:7.2} Hz  {} {} {}dBm", d.freq_hz, callsign, grid, power_dbm);
        }
        WsprMessage::Type2 { callsign, power_dbm } => {
            println!("{:7.2} Hz  {} {}dBm", d.freq_hz, callsign, power_dbm);
        }
        WsprMessage::Type3 { callsign_hash, grid6, power_dbm } => {
            // Hash may be resolvable via a Type-1 reception heard earlier.
            println!("{:7.2} Hz  <#{:05x}> {} {}dBm",
                     d.freq_hz, callsign_hash, grid6, power_dbm);
        }
    }
}
```

`decode_scan_default` runs the (frequency × time) coarse search over
the whole slot internally. If the frequency and start sample are
already known, `wspr_core::decode::decode_at(samples, rate,
start_sample, freq_hz)` bypasses the scan.

### 5.4 Sniper mode + AP hint

Narrowing the search to ±500 Hz and supplying an a-priori hint lets
the decoder recover weaker signals:

```rust
use ft4_core::decode::{decode_sniper_ap, ApHint};
use mfsk_core::equalize::EqMode;

let ap = ApHint::new().with_call1("CQ").with_call2("JA1ABC");
for r in decode_sniper_ap(&samples, /*target_hz*/ 1000.0, /*max_cand*/ 15,
                          EqMode::Adaptive, Some(&ap)) {
    // …
}
```

The FT8 equivalent is `ft8_core::decode::decode_sniper_sic` with the
same signature shape.

## 6. C / C++ consumers via `wsjt-ffi`

### Artefacts

`cargo build -p wsjt-ffi --release` emits:

* `target/release/libwsjt.so`  (Linux / Android shared object)
* `target/release/libwsjt.a`   (static, for bundling)
* `wsjt-ffi/include/wsjt.h`    (cbindgen-generated, committed)

### API

See `wsjt-ffi/include/wsjt.h` for the authoritative declarations.
Summary:

```c
enum WsjtProtocol { WSJT_PROTOCOL_FT8 = 0, WSJT_PROTOCOL_FT4 = 1 };

uint32_t          wsjt_version(void);            // major<<16 | minor<<8 | patch
WsjtDecoder*      wsjt_decoder_new(WsjtProtocol protocol);
void              wsjt_decoder_free(WsjtDecoder* dec);

WsjtStatus        wsjt_decode_i16(WsjtDecoder*, const int16_t* samples,
                                  size_t n, uint32_t sample_rate,
                                  WsjtMessageList* out);
WsjtStatus        wsjt_decode_f32(WsjtDecoder*, const float*,  size_t,
                                  uint32_t, WsjtMessageList* out);

void              wsjt_message_list_free(WsjtMessageList* list);
const char*       wsjt_last_error(void);
```

`WsjtMessageList` is caller-owned storage filled by the decode call;
text fields are `char*` UTF-8 NUL-terminated, owned by the list and
freed by `wsjt_message_list_free`.

See `wsjt-ffi/examples/cpp_smoke/` for a minimal end-to-end demo.

### Memory rules

1. **Handles**: allocate with `wsjt_decoder_new`, free with
   `wsjt_decoder_free`. One handle per thread. Free is idempotent on
   NULL.
2. **Message lists**: zero-initialise a `WsjtMessageList` on the
   stack, pass its address to the decode call, free with
   `wsjt_message_list_free` when done reading. Do *not* free
   individual `text` pointers yourself.
3. **Errors**: on non-zero `WsjtStatus`, call `wsjt_last_error` on the
   **same thread** to retrieve a human-readable diagnostic. The
   returned pointer is valid until the next fallible call on that
   thread.

### Thread safety

* A `WsjtDecoder` is `!Sync`: one handle per concurrent thread.
* The decoder uses thread-local state for caching and error reporting,
  so spawning multiple threads each with its own handle is cheap.

## 7. Kotlin / Android consumers

`wsjt-ffi/examples/kotlin_jni/` ships a drop-in scaffold:

```kotlin
package io.github.rsft8n

Wsjt.open(Wsjt.Protocol.FT4).use { dec ->
    val pcm: ShortArray = /* captured audio */
    for (m in dec.decode(pcm, sampleRate = 12_000)) {
        Log.i("ft4", "${m.freqHz} Hz  ${m.snrDb} dB  ${m.text}")
    }
}
```

* `libwsjt.so` built via `cargo build --target aarch64-linux-android`.
* `libwsjt_jni.so` built from the ~115-line C shim, marshals
  `ShortArray` ↔ `WsjtMessageList`.
* `Wsjt.kt` exposes an `AutoCloseable` Kotlin class; use with
  `.use { }` to guarantee release.

Full build instructions in `wsjt-ffi/examples/kotlin_jni/README.md`.

## 8. WASM / JS consumers via `ft8-web`

```ts
import init, {
    decode_wav,         // FT8
    decode_ft4_wav,     // FT4
    decode_wspr_wav,    // WSPR (120-s slot; coarse search internal)
    decode_sniper,
    decode_ft4_sniper,
    encode_ft8,
    encode_ft4,
    encode_wspr,        // Type-1 WSPR: (callsign, grid, dBm, freq) → f32 PCM
} from './ft8_web.js';

await init();
const ft8Msgs  = decode_wav(int16Samples,      /* strictness */ 1, /* sampleRate */ 48_000);
const wsprMsgs = decode_wspr_wav(int16Samples, /* sampleRate */ 48_000);
```

The PWA in `docs/` demonstrates usage end-to-end, including the
Phase 1 / Phase 2 pipelined decode for FT8 (`decode_phase1` +
`decode_phase2` share a thread-local FFT cache) and the protocol
selector in the settings cog that switches slot scheduling between
FT8 (15 s), FT4 (7.5 s), and WSPR (120 s).

## 9. Protocol notes

| Protocol   | Slot   | Tones | Symbols | Tone Δf    | FEC              | Msg   | Sync       | Status |
|------------|--------|-------|---------|------------|------------------|-------|------------|--------|
| FT8        | 15 s   | 8     | 79      | 6.25 Hz    | LDPC(174, 91)    | 77 b  | 3×Costas-7 | implemented |
| FT4        | 7.5 s  | 4     | 103     | 20.833 Hz  | LDPC(174, 91)    | 77 b  | 4×Costas-4 | implemented |
| FST4-60A   | 60 s   | 4     | 160     | 3.125 Hz   | LDPC(240, 101)   | 77 b  | 5×Costas-8 | implemented |
| FST4 other | 15–1800 s | 4 | var     | var        | LDPC(240, 101)   | 77 b  | 5×Costas-8 | one more ZST per sub-mode |
| WSPR       | 120 s  | 4     | 162     | 1.465 Hz   | conv r=½ K=32 + Fano | 50 b | per-symbol LSB (npr3) | implemented |
| JT9        | 60 s   | 9     | 85      | 1.736 Hz   | conv r=½ K=32 + Fano | 72 b  | 16 distributed | implemented |
| JT65       | 60 s   | 65    | 126     | 2.69 Hz    | RS(63, 12) GF(2⁶)     | 72 b  | 63 distributed | implemented |

FST4 does not share FT8's LDPC(174, 91); it uses a separate
LDPC(240, 101) + 24-bit CRC, implemented as `mfsk_fec::ldpc240_101`.
The BP / OSD algorithms are structurally the same across LDPC
sizes, so the new material is essentially the parity-check and
generator tables together with the code dimensions. FST4-60A is
complete end-to-end; the other FST4 sub-modes (-15/-30/-120/-300/
-900/-1800) differ only in `NSPS` / `SYMBOL_DT` /
`TONE_SPACING_HZ`, and each can be added as a short ZST reusing the
same FEC, sync and DSP.

WSPR is structurally different from the three modes above: it uses
convolutional coding (`mfsk_fec::conv::ConvFano`, ported from
WSJT-X `lib/wsprd/fano.c`) rather than LDPC, a 50-bit message
rather than 77-bit (`mfsk_msg::wspr::Wspr50Message`, covering
Types 1 / 2 / 3), and a per-symbol interleaved sync
(`SyncMode::Interleaved`) rather than block Costas arrays. The
`wspr-core` crate contributes its own TX synthesiser, RX
demodulator, and a quarter-symbol spectrogram used to keep the
coarse search over a 120-s slot within a reasonable time budget.

## 10. See also

* `CLAUDE.md` — project vision, sniper-mode design rationale.
* `README.md` / `README.en.md` — user-facing guide to the PWA.
* `wsjt-ffi/examples/cpp_smoke/` — minimal C++ demo.
* `wsjt-ffi/examples/kotlin_jni/` — Kotlin wrapper + JNI shim.

## License

Library code is GPL-3.0-or-later, derived from WSJT-X reference
algorithms.

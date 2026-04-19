# rs-ft8n — Library Architecture & ABI Reference

> **日本語版:** [LIBRARY.ja.md](LIBRARY.ja.md)

This document covers the rs-ft8n library surface for embedders: Rust
crate consumers, C/C++ projects linking `libwsjt.so`, and
Kotlin/Android apps using the JNI scaffold.

## 0. Why this exists

WSJT-X is the reference decoder for the FT8/FT4/FST4/WSPR family, but
it is a desktop C++ + Fortran binary with 20+ years of accretion.
Getting it to run in a browser PWA, on an Android phone, or as an
embeddable library inside another app means rewriting non-trivial
portions per platform — and each rewrite diverges further from
upstream.

**rs-ft8n solves this by refactoring the decode pipeline around a
zero-cost trait abstraction.** The algorithms (DSP, sync correlation,
LLR, equaliser, LDPC BP/OSD, convolutional + Fano) live in shared
crates (`mfsk-core`, `mfsk-fec`, `mfsk-msg`). Each protocol is a
~100–300 line ZST that declares its constants and the specific FEC /
message codec it uses; the entire pipeline is then available via
`decode_frame::<P>()`. Because `P` is a compile-time type parameter,
monomorphisation produces code byte-identical to a hand-written
per-protocol decoder — the abstraction is free.

### What you get from this structure

| Benefit                                    | How it shows up in practice                                                 |
|--------------------------------------------|-----------------------------------------------------------------------------|
| **One codebase → four platforms**          | Same crates compile to native Rust, WASM (PWA), Android ARM64 (JNI), C/C++ (cbindgen) |
| **Shared optimisations propagate**         | A SIMD tweak in `mfsk-fec::ldpc::bp_decode` speeds up FT8, FT4 *and* FST4 simultaneously |
| **New protocols are cheap**                | FT4 = ~150 lines on top of the FT8 stack; FST4-60A = ~90 lines + LDPC tables; WSPR brings its own FEC family and still reuses the pipeline scaffold |
| **Clean ABI surface**                      | The C ABI in `wsjt-ffi` dispatches once via `match protocol_id`; the specialised code paths are already monomorphised away |
| **Algorithm correctness is testable in isolation** | 118 workspace tests cover each codec, each message type, sync, LLR, etc. before any integration |

### What the library can decode / encode today

- **FT8** (15 s slot, 8-GFSK, LDPC(174, 91) + CRC-14, 77-bit message)
- **FT4** (7.5 s slot, 4-GFSK, LDPC(174, 91) + CRC-14, 77-bit message)
- **FST4-60A** (60 s slot, 4-GFSK, LDPC(240, 101) + CRC-24, 77-bit message)
- **WSPR** (120 s slot, 4-FSK, convolutional r=1/2 K=32 + Fano, 50-bit message)

JT65 (Reed–Solomon, 72-bit) and JT9 (convolutional, 72-bit) slot into
the same abstraction cleanly — the work is adding one more `FecCodec`
and one more `MessageCodec` implementation.

### Evidence that the abstraction is real, not nominal

WSPR is the stress test. Unlike the FT-family, WSPR uses:

1. A different FEC family (convolutional + sequential Fano, not LDPC)
2. A different message size (50 bits, not 77)
3. A different sync structure (per-symbol interleaved sync vector, not
   block Costas arrays)

Every one of these pushed on a different axis of the trait surface —
`FecCodec` had to accept `ConvFano`, `MessageCodec::Unpacked` had to
generalise from `String` (FT8) to `WsprMessage` (enum), and
`FrameLayout::SYNC_MODE` gained an `Interleaved` variant. The FT8/FT4/FST4
code paths stayed *unchanged*: their impls still use `SyncMode::Block`
and produce the same bits they did before. The multi-crate refactor
paid for itself at WSPR time — there was no "tear out the FT8-only
assumption" cliff to climb.

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

Three tiers depending on how much the new mode shares:

1. **Same FEC + same message (e.g. FT2, other FST4 sub-modes)** —
   one ZST, ~20–100 lines. Change only the numeric constants
   (`NTONES`, `NSPS`, `TONE_SPACING_HZ`, `SYNC_MODE`). `Fec` and `Msg`
   are aliases to existing impls. The entire `decode_frame::<P>()`
   pipeline works out of the box.

2. **New FEC, same message (e.g. a second LDPC size)** — add the
   codec module in `mfsk-fec`, implement `FecCodec` for it. The
   BP / OSD / systematic-encode *algorithms* generalise across
   LDPC sizes automatically; only parity-check + generator tables
   and the `N`/`K` constants change. See `mfsk_fec::ldpc240_101` for
   the pattern.

3. **New FEC *and* new message (e.g. WSPR)** — add the codec, add
   the message codec in `mfsk-msg`, and if the sync structure differs
   fundamentally add a `SyncMode` variant. This is the path WSPR took:
   `ConvFano` + `Wspr50Message` + `SyncMode::Interleaved`. The shared
   pipeline scaffolding still applies — coarse search, spectrogram,
   candidate dedup, CRC / message unpack all remain available.

For JT65 (Reed–Solomon) and JT9 (convolutional, 72-bit), the work
is tier 3: one new `FecCodec` + one new `MessageCodec` each. The
`SyncMode` trait already has the needed variants.

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

```toml
[dependencies]
ft4-core = { path = "../rs-ft8n/ft4-core" }
mfsk-msg = { path = "../rs-ft8n/mfsk-msg" }
```

```rust
use ft4_core::decode::{decode_frame, decode_sniper_ap, ApHint};
use mfsk_core::equalize::EqMode;

let audio: Vec<i16> = /* 12 kHz PCM, 7.5 s */;

// Wide-band decode
for r in decode_frame(&audio, 300.0, 2700.0, 1.2, 50) {
    println!("{:4.0} Hz  {:+.2} s  SNR {:+.0} dB", r.freq_hz, r.dt_sec, r.snr_db);
}

// Narrow-band "sniper" decode with AP hint
let ap = ApHint::new().with_call1("CQ").with_call2("JA1ABC");
for r in decode_sniper_ap(&audio, 1000.0, 15, EqMode::Adaptive, Some(&ap)) {
    // …
}
```

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
| FT8        | 15 s   | 8     | 79      | 6.25 Hz    | LDPC(174, 91)    | 77 b  | 3×Costas-7 | shipping |
| FT4        | 7.5 s  | 4     | 103     | 20.833 Hz  | LDPC(174, 91)    | 77 b  | 4×Costas-4 | shipping |
| FST4-60A   | 60 s   | 4     | 160     | 3.125 Hz   | LDPC(240, 101)   | 77 b  | 5×Costas-8 | shipping |
| FST4 other | 15–1800 s | 4 | var     | var        | LDPC(240, 101)   | 77 b  | 5×Costas-8 | one more ZST per sub-mode |
| WSPR       | 120 s  | 4     | 162     | 1.465 Hz   | conv r=½ K=32 + Fano | 50 b | per-symbol LSB (npr3) | shipping |
| JT65       | 60 s   | 65    | 126     | ~2.7 Hz    | RS(63, 12)       | 72 b  | pseudo-rand | TODO |
| JT9        | 60 s   | 9     | 85      | 1.736 Hz   | conv r=½ + Fano  | 72 b  | block      | TODO |

FST4 does **not** share FT8's LDPC(174, 91); it uses LDPC(240, 101)
with 24-bit CRC, implemented in `mfsk_fec::ldpc240_101`. The BP / OSD
algorithm is structurally the same — only the parity-check / generator
tables and code dimensions differ. FST4-60A is shipping end-to-end;
the other FST4 sub-modes (-15/-30/-120/-300/-900/-1800) differ only in
`NSPS` / `SYMBOL_DT` / `TONE_SPACING_HZ`, and each is a ~20-line ZST
reusing the same FEC + sync + DSP.

WSPR is the structurally different member of the family: convolutional
FEC instead of LDPC (`mfsk_fec::conv::ConvFano`, ported from WSJT-X
`lib/wsprd/fano.c`), 50-bit message (`mfsk_msg::wspr::Wspr50Message`
covering Type 1 / 2 / 3), and per-symbol interleaved sync
(`SyncMode::Interleaved`) instead of block Costas. The `wspr-core`
crate adds its own TX synthesiser, RX demodulator and a quarter-symbol
spectrogram for ~40× faster coarse search over a 120-s slot.

## 10. See also

* `CLAUDE.md` — project vision, sniper-mode design rationale.
* `README.md` / `README.en.md` — user-facing guide to the PWA.
* `wsjt-ffi/examples/cpp_smoke/` — minimal C++ demo.
* `wsjt-ffi/examples/kotlin_jni/` — Kotlin wrapper + JNI shim.

## License

Library code is GPL-3.0-or-later, derived from WSJT-X reference
algorithms.

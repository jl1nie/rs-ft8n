# rs-ft8n — Library Architecture & ABI Reference

> **日本語版:** [LIBRARY.ja.md](LIBRARY.ja.md)

This document covers the rs-ft8n library surface for embedders: Rust
crate consumers, C/C++ projects linking `libwsjt.so`, and
Kotlin/Android apps using the JNI scaffold.

## 1. Crate layout

```
mfsk-core  ──┐
             │
mfsk-fec    ─┼─┐
             │ │
mfsk-msg    ─┼─┼─┬── ft8-core ──┐
             │ │ │               │
             │ │ └── ft4-core ──┼── ft8-web (WASM)
             │ │                 │
             │ │                 └── wsjt-ffi (C ABI cdylib)
             │ │                          │
             │ │                          └── examples/{cpp_smoke, kotlin_jni}
             │ └── (future) rs codec, conv codec…
             └── (future) sync / llr / tx reused by other families
```

| Crate        | Role                                                                  |
|--------------|-----------------------------------------------------------------------|
| `mfsk-core`  | Protocol traits, DSP (resample / downsample / subtract / GFSK), sync, LLR, equalize, pipeline |
| `mfsk-fec`   | LDPC(174, 91) codec implementing `FecCodec`                            |
| `mfsk-msg`   | WSJT 77-bit message codec + AP hints + AP-aware pipeline             |
| `ft8-core`   | `Ft8` ZST + FT8-tuned decode orchestration (AP / sniper / SIC)        |
| `ft4-core`   | `Ft4` ZST + FT4-tuned entry points                                    |
| `ft8-web`    | `wasm-bindgen` surface — FT8 *and* FT4 exposed to the PWA             |
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
    const SYNC_BLOCKS: &'static [SyncBlock];
    const T_SLOT_S: f32;
    const TX_START_OFFSET_S: f32;
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

To add FST4, FT2, or any new LDPC-based mode:

1. Create `your-core/` crate with a ZST `YourMode`.
2. Implement the three traits, slotting `SYNC_BLOCKS` to the protocol's
   Costas layout and the numeric constants.
3. Declare `type Fec = Ldpc174_91;` (shared with FT8/FT4) if the code
   is the same, otherwise point at a new `FecCodec` implementation in
   `mfsk-fec`.
4. Declare `type Msg = Wsjt77Message;` if the mode uses the 77-bit
   message layout (FT8/FT4/FT2/FST4 all do).

The decode / encode machinery is already generic — you get a working
pipeline without writing any DSP code. For JT65 / JT9 / WSPR, provide
a new `FecCodec` (Reed-Solomon or convolutional) and a new
`MessageCodec` (72-bit / 50-bit payload).

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
  peak search over `P::SYNC_BLOCKS`.
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
  `P::SYNC_BLOCKS` pilot observations; linearly extrapolates any tones
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
    decode_sniper,
    decode_ft4_sniper,
} from './ft8_web.js';

await init();
const messages = decode_wav(int16Samples, /* strictness */ 1, /* sampleRate */ 48_000);
```

The PWA in `docs/` demonstrates usage end-to-end, including the
Phase 1 / Phase 2 pipelined decode for FT8 (`decode_phase1` +
`decode_phase2` share a thread-local FFT cache).

## 9. Protocol notes

| Protocol | Slot   | Tones | Symbols | Tone Δf    | FEC          | Msg   | Status |
|----------|--------|-------|---------|------------|--------------|-------|--------|
| FT8      | 15 s   | 8     | 79      | 6.25 Hz    | LDPC(174,91) | 77 b  | shipping |
| FT4      | 7.5 s  | 4     | 103     | 20.833 Hz  | LDPC(174,91) | 77 b  | shipping |
| FT2      | ~4.5 s | 4     | ~100    | 83 Hz      | LDPC(174,91) | 77 b  | TODO   |
| FST4     | var    | 4     | var     | var        | LDPC(174,91) | 77 b  | TODO   |
| JT65     | 60 s   | 65    | 126     | ~2.7 Hz    | RS(63,12)    | 72 b  | TODO   |
| JT9      | 60 s   | 9     | 85      | 1.736 Hz   | conv + Fano  | 72 b  | TODO   |
| WSPR     | 110 s  | 4     | 162     | 1.465 Hz   | conv + Fano  | 50 b  | TODO   |

## 10. See also

* `CLAUDE.md` — project vision, sniper-mode design rationale.
* `README.md` / `README.en.md` — user-facing guide to the PWA.
* `wsjt-ffi/examples/cpp_smoke/` — minimal C++ demo.
* `wsjt-ffi/examples/kotlin_jni/` — Kotlin wrapper + JNI shim.

## License

Library code is GPL-3.0-or-later, derived from WSJT-X reference
algorithms.

# rs-ft8n — FT8 Sniper-Mode Decoder

**[日本語版](README.md)**

Pure Rust FT8 decoder with **adaptive equalizer** and **500 Hz hardware BPF** integration.
Decodes signals that WSJT-X cannot — verified on synthetic worst-case scenarios.

## Why This Exists

FT8 operates on a 3 kHz-wide audio band shared by dozens of stations.
When a +40 dB adjacent signal is present, a standard 16-bit ADC devotes
nearly all its dynamic range to the strong station, burying the weak
target in quantization noise. WSJT-X, which processes the full 3 kHz
band equally, cannot recover it.

**rs-ft8n** takes a different approach:

```
[Antenna] → [500 Hz BPF] → [ADC 16 bit] → rs-ft8n (sniper + EQ) → decoded message
              ↑ removes strong QRM before digitization
```

By placing a narrow hardware bandpass filter *before* the ADC, the strong
interferers are physically removed and the ADC's full dynamic range is
devoted to the target signal. The software equalizer then corrects the
amplitude roll-off and phase distortion introduced by the filter edges.
When the target callsign is known, A Priori (AP) decoding locks 32 of
the 77 message bits, further lowering the decode threshold by several dB.

## Key Results

### WSJT-X comparison (real recordings)

Tested on WAV files from [jl1nie/RustFT8](https://github.com/jl1nie/RustFT8)
(`191111_110200.wav`, single-pass):

| Signal | SNR | WSJT-X | rs-ft8n | Method |
|--------|-----|--------|---------|--------|
| CQ R7IW LN35 | -8 dB | ✓ | ✓ | BP |
| CQ DX R6WA LN32 | — | ✗ | ✓ | BP |
| CQ TA6CQ KN70 | -8 dB | ✓ | ✓ | BP |
| OH3NIV ZS6S RR73 | -17 dB | ✓ | ✓ | OSD-3 |
| CQ LZ1JZ KN22 | -17 dB | ✓ | ✓ | OSD-2 |

With multi-pass signal subtraction (`191111_110130.wav`):

| Signal | Method | Note |
|--------|--------|------|
| TK4LS YC1MRF 73 | OSD pass-3 | Recovered after subtracting 4 stronger signals |

### Busy-band ADC saturation (synthetic, 15 crowd @ +40 dB, target @ -14 dB)

| Decode mode | Target decoded? |
|-------------|-----------------|
| Full-band (WSJT-X equivalent) | **missed** — ADC clipped by crowd |
| Sniper (software-only, no BPF) | missed — crowd distortion |
| **500 Hz BPF + sniper** | **20/20 seeds (100%)** |

### BPF edge + adaptive equalizer (target @ -18 dB, 4-pole Butterworth 500 Hz)

| Position | BPF atten | EQ OFF | EQ Adaptive |
|----------|-----------|--------|-------------|
| Center | 0 dB | 40% | 40% |
| Shoulder | -0.5 dB | 30% | 40% |
| **Edge** | **-3.0 dB** | **10%** | **30%** |

The equalizer triples the decode rate at the filter edge with zero
degradation at center.

### WSJT-X stress test

`sim_stress_bpf_edge_clean.wav` — target at -18 dB, BPF edge (-3 dB attenuation):

| Decoder | Result |
|---------|--------|
| **WSJT-X** | **decode failure** |
| **rs-ft8n sniper + EQ** | **CQ 3Y0Z JD34 decoded** |

### BPF edge SNR sweep — cumulative effect of BPF + EQ + AP

BPF edge (-3 dB), target callsign (3Y0Z) known, 20 seeds:

| SNR | EQ OFF | EQ Adaptive | **EQ + AP** |
|-----|--------|-------------|-------------|
| -16 dB | 95% | 100% | 100% |
| **-18 dB** | **10%** | **30%** | **60%** |
| -20 dB | 0% | 0% | 5% |
| -22 dB | 0% | 0% | 0% |

At -18 dB: WSJT-X 0%, rs-ft8n EQ+AP 60%. Each stage (BPF → EQ → AP) progressively lowers the threshold.

### In-band crowd + signal subtraction

BPF passband with 4 crowd stations (@ +8 dB) masking target (@ -14 dB):

| Mode | Decoded | Target |
|------|---------|--------|
| Single-pass | 4 (crowd only) | missed |
| **Subtract** | **5** | **CQ 3Y0Z JD34 ★** |

### Performance (100 stations, release build)

Environment: AMD Ryzen 9 9900X (12C/24T), 32 GB RAM, rustc 1.94.0, WSL2 Linux 5.15

| Mode | Decoded | Mean time | Budget (2.4 s) |
|------|---------|-----------|----------------|
| decode_frame (single) | 82 | 19 ms | 0.8% |
| decode_frame_subtract (3-pass) | 89 | 119 ms | 5.0% |
| sniper + EQ (Adaptive) | 16 | 22 ms | 0.9% |

## Features

### Decode Pipeline

```
PCM 16-bit 12 kHz
  ↓ downsample (192k-pt FFT + Hann window → 200 Hz complex baseband)
  ↓ coarse_sync (Costas correlation, 2-D time-freq grid)
  ↓ refine_candidate (3-array peak + parabolic interpolation)
  ↓ symbol_spectra (32-pt FFT × 79 symbols)
  ↓ [equalizer] (Wiener pilot correction from Costas arrays)
  ↓ compute_llr (Gray-coded soft metrics, 4 variants a/b/c/d)
  ├→ BP decode (log-domain, 30 iter, CRC-14)
  ├→ OSD fallback (order 2-3, when BP fails + sync_q ≥ 12)
  └→ [AP pass] (lock known bits, retry BP, pass=5)
```

### Adaptive Equalizer (`equalizer.rs`)

Corrects BPF amplitude/phase distortion using Costas arrays as pilot tones.

- **Pilot estimation:** 3 Costas arrays × 7 tones → average per tone;
  tone 7 (unvisited by Costas) linearly extrapolated from tones 5-6.
- **Wiener filter:** `W[t] = pilot[t]* / (|pilot[t]|² + σ²_noise)`.
  Self-regulating: near-passthrough at low SNR, full correction at high SNR.
- **Adaptive mode (`EqMode::Adaptive`):** Tries EQ first to recover edge
  signals; falls back to raw decode for center signals. No degradation at
  center, maximum benefit at edge.

### A Priori (AP) Decoding (`decode.rs`)

When the target callsign is known, locks 32 of 77 message bits at high-confidence
LLR values. Locked bits are frozen during BP iterations (same mechanism as WSJT-X),
reducing the number of unknown bits and lowering the decode threshold.

- **AP magnitude:** `apmag = max(|llr|) × 1.01`
- **Locked bits (call2 only):** bits 29–57 (28-bit call + 1-bit flag) + bits 74–76 (i3=1) = 32 bits
- **Activation:** AP pass runs only after BP + OSD fail (pass=5)

### Signal Subtraction (`subtract.rs` + `decode.rs`)

Three-pass successive interference cancellation:

| Pass | Sync threshold | OSD threshold | Purpose |
|------|---------------|---------------|---------|
| 1 | 1.0× | 2.5 | Strong signals |
| 2 | 0.75× | 2.5 | Medium signals on residual |
| 3 | 0.5× | 2.0 | Weak signals after cleanup |

- IQ least-squares amplitude estimation (arbitrary carrier phase)
- QSB gate: reduces subtraction gain to 0.5 when Costas power CV > 0.3

### Butterworth BPF Simulation (`bpf.rs`)

4-pole (8th-order) IIR bandpass filter for simulating hardware CW filters:

```
Filter response (500 Hz BW, center = 1000 Hz):
   750 Hz:  -3.0 dB    (passband edge)
   900 Hz:  -0.0 dB
  1000 Hz:  -0.0 dB    (center)
  1250 Hz:  -3.0 dB    (passband edge)
  1500 Hz: -20.2 dB    (stopband)
```

### Message Codec (`message.rs`)

Bidirectional 77-bit FT8 message encoding/decoding:

- **Unpack:** Type 0 (free text, DXpedition), Type 1/2 (standard), Type 3 (RTTY), Type 4 (non-standard call)
- **Pack:** `pack28` (callsign → 28-bit token), `pack_grid4`, `pack77_type1` (CQ/call/grid → 77 bits)

## Architecture

```
rs-ft8n/
├── ft8-core/          Pure Rust FT8 decode library
│   └── src/
│       ├── params.rs       FT8 protocol constants
│       ├── downsample.rs   FFT-based 12 kHz → 200 Hz complex baseband
│       ├── sync.rs         Costas correlation + parabolic fine sync
│       ├── llr.rs          Soft-decision LLR (4 metric variants)
│       ├── equalizer.rs    Adaptive channel equalizer (Wiener pilot)
│       ├── wave_gen.rs     FT8 waveform encoder (message → PCM)
│       ├── subtract.rs     Signal subtraction (IQ amplitude estimation)
│       ├── message.rs      77-bit message pack/unpack
│       ├── decode.rs       End-to-end pipeline (single/subtract/sniper)
│       └── ldpc/
│           ├── bp.rs       Belief Propagation (30 iter)
│           ├── osd.rs      Ordered Statistics Decoding (order 1-3)
│           └── tables.rs   LDPC(174,91) parity-check matrix
└── ft8-bench/         Benchmark & scenario harness
    └── src/
        ├── main.rs         All scenarios + speed benchmark
        ├── bpf.rs          Butterworth BPF (4-pole IIR)
        ├── simulator.rs    Synthetic FT8 frame generator
        ├── real_data.rs    Real WAV evaluation
        └── diag.rs         Per-signal pipeline trace
```

47 unit tests, all passing.

## Build

```bash
cargo build --release
```

Dependencies: `rustfft`, `num-complex`, `hound`, `rayon`

### Run all scenarios + benchmark

```bash
# Place test WAVs (optional, for real-data evaluation):
#   ft8-bench/testdata/191111_110130.wav
#   ft8-bench/testdata/191111_110200.wav
#   (from https://github.com/jl1nie/RustFT8/tree/main/data)

cargo run -p ft8-bench --release
```

### Use as library

```rust
use ft8_core::decode::{decode_frame, DecodeDepth};

let samples: Vec<i16> = /* 12000 Hz, 16-bit PCM */;
let results = decode_frame(
    &samples,
    200.0, 2800.0,        // freq range (Hz)
    1.5,                   // sync_min threshold
    None,                  // freq_hint
    DecodeDepth::BpAllOsd, // BP + OSD fallback
    200,                   // max candidates
);

for r in &results {
    let text = ft8_core::message::unpack77(&r.message77);
    println!("{:+.0} dB  {:.1} Hz  {}", r.snr_db, r.freq_hz,
             text.unwrap_or_default());
}
```

Sniper mode (BPF + EQ + AP):

```rust
use ft8_core::decode::{decode_sniper_ap, DecodeDepth, EqMode, ApHint};

let ap = ApHint::new().with_call2("3Y0Z");
let results = decode_sniper_ap(
    &samples,
    1000.0,                // target frequency (Hz)
    DecodeDepth::BpAllOsd,
    20,                    // max candidates
    EqMode::Adaptive,      // equalizer mode
    Some(&ap),             // A Priori hint
);
```

## References

- [WSJT-X](https://github.com/saitohirga/WSJT-X) — FT8 Fortran reference implementation
- [jl1nie/RustFT8](https://github.com/jl1nie/RustFT8) — Test WAV data source
- K1JT et al., "The FT4 and FT8 Communication Protocols", QEX, 2020
- S. Franke, B. Somerville, J. Taylor, "Work Weak Signals on HF with WSJT-X", QST, 2018

## License

GNU General Public License v3.0 (GPLv3)

WSJT-X (the reference implementation) is distributed under GPLv3, and this
project incorporates ported algorithms from WSJT-X. See [LICENSE](LICENSE).

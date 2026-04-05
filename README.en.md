# rs-ft8n — FT8 Sniper-Mode Decoder

**[日本語版](README.md)** | **[WASM Demo](https://jl1nie.github.io/rs-ft8n/)** | **[PWA Manual](docs/manual.en.md)**

Pure Rust FT8 decoder with **adaptive equalizer**, **A Priori decoding**, and **500 Hz hardware BPF** integration. Includes a browser-based WASM PWA with real-time waterfall and live audio decoding.

## Project Aim

### The 16-bit Quantization Wall

FT8 operates on a 3 kHz audio band shared by dozens of stations. When a +40 dB adjacent signal is present, a 16-bit ADC devotes nearly all its dynamic range to the strong station, burying the weak target in quantization noise.

### 500 Hz Hardware Filter + Software Breakthrough

```
[Antenna] → [500 Hz BPF (in transceiver)] → [ADC 16 bit] → rs-ft8n → decoded message
```

1. **Hardware filter** — passes only ±250 Hz around the target, removes strong out-of-band signals before the ADC.
2. **Adaptive equalizer** — corrects BPF edge amplitude/phase distortion using Costas pilot tones.
3. **Successive interference cancellation** — subtracts decoded in-band stations to reveal weaker signals.
4. **A Priori (AP) decoding** — locks 32 of 77 message bits when the target callsign is known.

## Key Differences from WSJT-X

| Feature | WSJT-X | rs-ft8n |
|---------|--------|---------|
| Band | Full 3 kHz | **500 Hz BPF sniper mode** |
| Equalizer | None | **Costas Wiener adaptive EQ** |
| AP decoding | Multi-stage by QSO state | **Target callsign lock (32 bits)** |
| Fine sync | Integer sample + fixed offset | **Parabolic interpolation in main sync** |
| Signal subtraction | 4-pass subtract-coupled | **3-pass + QSB gate** |
| OSD fallback | ndeep parameter | **sync_q adaptive** (≥18 → order-3) |
| OSD false positive | None | **Order-dependent hard_errors + callsign validation** |
| FFT cache | `save` variable (serial) | **Explicit cache + Rayon parallel sharing** |
| Parallelism | Serial candidate loop | **Rayon par_iter** |
| WASM | None | **Browser real-time decode** (306 KB) |

## WASM Demo

**[https://jl1nie.github.io/rs-ft8n/](https://jl1nie.github.io/rs-ft8n/)**

FT8 decoding in the browser. No installation required.

### Features

- **Waterfall display** — real-time spectrogram (200-2800 Hz) with decoded callsign overlay
- **Live audio input** — connect to transceiver via USB audio, auto-decode every 15 seconds
- **WAV file drop** — drag & drop 12 kHz / 16-bit mono WAV files
- **Snipe mode** — click/drag 500 Hz window on waterfall, decode with EQ
- **AP (A Priori)** — enter DX Call + confirm with AP button, target callsign highlighted green
- **Snipe and AP are independent** — 4 combinations available

| Snipe | AP | Behavior |
|-------|-----|----------|
| OFF | OFF | Full-band subtract |
| OFF | ON | Full-band + AP |
| ON | OFF | ±250 Hz + EQ |
| ON | ON | ±250 Hz + EQ + AP |

### Quick Start

1. Download test WAVs:
   - [sim_stress_bpf_edge_clean.wav](https://github.com/jl1nie/rs-ft8n/raw/main/ft8-bench/testdata/sim_stress_bpf_edge_clean.wav) — **signal WSJT-X cannot decode**
   - [sim_busy_band.wav](https://github.com/jl1nie/rs-ft8n/raw/main/ft8-bench/testdata/sim_busy_band.wav) — 15 stations + weak target
2. Open [WASM demo](https://jl1nie.github.io/rs-ft8n/), drop WAV → waterfall + decode results
3. Snipe button → click waterfall to place 500 Hz window
4. DX Call: `3Y0Z` → AP button → target highlighted green

### WSJT-X Comparison

Each WAV contains 15 crowd stations and a weak target **CQ 3Y0Z JD34**.

| WAV | Scenario | WSJT-X | rs-ft8n WASM (subtract) |
|-----|----------|--------|------------------------|
| `sim_busy_band.wav` | crowd +5 dB / target -12 dB / normalized | 7 stations | **16 (incl. 3Y0Z)** |
| `sim_stress_fullband.wav` | crowd +20 dB / target -18 dB / **AGC → ADC saturation** | 10 (no 3Y0Z) | **15 (no 3Y0Z)** |
| **`sim_stress_bpf_edge_clean.wav`** | target -18 dB / BPF edge -3 dB | **decode failure** | **CQ 3Y0Z JD34 (197 ms)** ※ |

> ※ rs-ft8n uses EQ + AP (target callsign pre-specified). WSJT-X was also tested with DX Call = 3Y0Z but did not decode. The adaptive equalizer's BPF edge correction is the contributing factor. EQ alone (no AP) achieves 30% decode rate.

## Experimental Results (Detail)

### BPF + EQ + AP Cumulative Effect (target @ -18 dB, BPF edge, 20 seeds)

| SNR | EQ OFF | EQ Adaptive | **EQ + AP** |
|-----|--------|-------------|-------------|
| -16 dB | 95% | 100% | 100% |
| **-18 dB** | **10%** | **30%** | **60%** |
| -20 dB | 0% | 0% | 5% |

### Stress Test

`sim_stress_bpf_edge_clean.wav`:

| Decoder | Result | Time |
|---------|--------|------|
| **WSJT-X** (DX Call=3Y0Z) | **decode failure** | — |
| **rs-ft8n Native** | **CQ 3Y0Z JD34** | ~22 ms |
| **rs-ft8n WASM** | **CQ 3Y0Z JD34** | 197 ms |

### Decoder Performance

Native: AMD Ryzen 9 9900X (12C/24T), 32 GB RAM, rustc 1.94.0, WSL2 Linux 5.15

| Mode | Decoded | 1 thread | 12 threads | Budget (2.4 s) |
|------|---------|----------|------------|----------------|
| decode_frame (single) | 82 | 147 ms | 19 ms | 0.8% |
| decode_frame_subtract (3-pass) | 89 | 440 ms | 119 ms | 5.0% |
| sniper + EQ (Adaptive) | 16 | 65 ms | 22 ms | 0.9% |

**Parallelism:** WSJT-X processes candidates serially. rs-ft8n uses **Rayon parallel candidate decoding** (up to 7.7×). Even single-threaded, 100 stations decode in 440 ms (within budget).

#### WASM vs Native

| WAV | Signals | Native 1T | WASM | Ratio |
|-----|---------|-----------|------|-------|
| sim_stress_bpf_edge_clean | 1 | 65 ms | 197 ms | 3.0x |
| sim_busy_band | 16 | 147 ms | 213 ms | 1.4x |

## Architecture

```
rs-ft8n/
├── ft8-core/          Pure Rust FT8 decode library (rayon feature-gated)
│   └── src/           decode, equalizer, message, subtract, wave_gen,
│                      downsample, sync, llr, params, ldpc/
├── ft8-bench/         Benchmark & scenario harness
│   └── src/           main, bpf, simulator, real_data, diag
├── ft8-web/           WASM PWA frontend
│   ├── src/lib.rs     wasm-bindgen API
│   └── www/           index.html, app.js, waterfall.js, audio-*.js, ft8-period.js
└── docs/              GitHub Pages deployment
```

52 unit tests. WASM binary 306 KB.

## Build

```bash
cargo build --release
cargo run -p ft8-bench --release   # all scenarios + benchmark

# WASM
cd ft8-web && wasm-pack build --target web --release
```

## References

- [WSJT-X](https://github.com/saitohirga/WSJT-X) — FT8 Fortran reference implementation
- [jl1nie/RustFT8](https://github.com/jl1nie/RustFT8) — Test WAV data
- K1JT et al., "The FT4 and FT8 Communication Protocols", QEX, 2020

## License

GNU General Public License v3.0 (GPLv3) — includes ported algorithms from WSJT-X. See [LICENSE](LICENSE).

# rs-ft8n — FT8 Sniper-Mode Decoder

**[Japanese version](README.md)** | **[Open PWA](https://jl1nie.github.io/rs-ft8n/)** | **[PWA Manual](docs/manual.en.md)**

Pure Rust FT8 decoder with **adaptive equalizer**, **A Priori decoding**, and **500 Hz hardware BPF** integration. The browser-based WASM PWA is a complete QSO station — waterfall, live decode, transmit, CAT control, and log management.

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
| WASM | None | **Complete QSO in the browser** (306 KB) |

## PWA — Full FT8 QSO in the Browser

**[https://jl1nie.github.io/rs-ft8n/](https://jl1nie.github.io/rs-ft8n/)**

No installation required. Works on Chrome, Edge, and Safari. See the **[PWA Manual](docs/manual.en.md)** for details.

### Two Operating Modes

**Scout mode** — chat-style UI for casual CQ operation. Tap received messages to call stations. Ideal for portable and mobile use.

**Snipe mode** — dedicated DX hunting. Toggle between Watch phase (full-band receive, target search, competitor list) and Call phase (narrow, target-only display).

### Key Features

- **Waterfall** — real-time spectrogram (200-2800 Hz), decoded message overlay, tap to set TX frequency
- **Live audio** — connect to transceiver via USB audio, auto-decode every 15 seconds
- **QSO state machine** — IDLE → CALLING → REPORT → FINAL → complete. Fully automatic in Auto mode, or manually select TX messages
- **CAT control** — Yaesu / Icom PTT via Web Serial API
- **Log management** — QSOs (complete + incomplete) and all RX decodes stored in localStorage. ZIP export (ADIF + RX CSV)
- **WAV analysis** — drag & drop WAV onto waterfall for offline analysis (auto-stops live audio)
- **Snipe + AP** — 500 Hz BPF window + target callsign lock. 4 combinations:

| Snipe | AP | Behavior |
|-------|-----|----------|
| OFF | OFF | Full-band subtract |
| OFF | ON | Full-band + AP |
| ON | OFF | ±250 Hz + EQ |
| ON | ON | ±250 Hz + EQ + AP |

### Quick Start

1. **[Open the PWA](https://jl1nie.github.io/rs-ft8n/)**
2. Enter My Callsign and My Grid in the settings panel (gear icon)
3. **Offline trial:** download a test WAV and drag & drop it onto the waterfall:
   - [sim_busy_band.wav](https://github.com/jl1nie/rs-ft8n/raw/main/ft8-bench/testdata/sim_busy_band.wav) — 15 stations + weak target
   - [sim_stress_bpf_edge_clean.wav](https://github.com/jl1nie/rs-ft8n/raw/main/ft8-bench/testdata/sim_stress_bpf_edge_clean.wav) — weak signal at BPF edge
4. **Live operation:** select Audio Input / Output → Start Audio → CQ to begin QSO

### WSJT-X Comparison

All WAVs generated with GFSK (BT=2.0, WSJT-X compatible modulation). Each WAV contains 15 crowd stations and a weak target **CQ 3Y0Z JD34**.

| WAV | Scenario | WSJT-X | rs-ft8n (subtract) |
|-----|----------|--------|-------------------|
| `sim_busy_band.wav` | crowd +5 dB / target -12 dB | 7 stations | **16 (incl. 3Y0Z)** |
| `sim_stress_fullband.wav` | crowd +20 dB / target -18 dB | 11 (3Y0Z: AP) | **15 (no 3Y0Z)** |
| `sim_busy_band_hard_mixed.wav` | crowd +40 dB / target -14 dB | 8 (3Y0Z: AP) | **15 (no 3Y0Z)** |
| `sim_stress_bpf_edge_clean.wav` | target -18 dB / BPF edge | 1 (AP) | **1 (sniper+EQ+AP)** |

> rs-ft8n decodes 2x more stations than WSJT-X in subtract mode without AP. WSJT-X recovers 3Y0Z via AP+Deep; rs-ft8n also recovers it in sniper+AP mode.

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

**Parallelism:** WSJT-X processes candidates serially. rs-ft8n uses **Rayon parallel candidate decoding** (up to 7.7x). Even single-threaded, 100 stations decode in 440 ms (within budget).

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
│   ├── src/lib.rs     wasm-bindgen API (decode/sniper/subtract/encode)
│   └── www/
│       ├── index.html      Scout/Snipe dual-mode UI
│       ├── app.js          Orchestrator (mode switch/decode/TX/log)
│       ├── qso.js          QSO state machine (IDLE→CALLING→REPORT→FINAL)
│       ├── waterfall.js    Canvas spectrogram (radix-2 FFT, DF line)
│       ├── qso-log.js      QSO + RX log, ZIP export (ADIF + CSV)
│       ├── cat.js          CAT control (Yaesu/Icom, Web Serial)
│       ├── audio-*.js      Capture, output, AudioWorklet decimation
│       └── ft8-period.js   FT8 15-second period manager + TX queue
└── docs/              GitHub Pages deployment (auto-synced from ft8-web/www/)
```

54 unit tests. WASM binary 306 KB.

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

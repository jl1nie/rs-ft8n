# WebFT8 — FT8 in Your Browser

**[日本語版](README.md)** | **[Open App](https://jl1nie.github.io/webft8/)** | **[Manual](docs/manual.en.md)**

> Pure Rust FT8 decoder running as a WASM PWA.
> No install, no Java — just open and operate.

## Features

- **Full FT8 QSO** — decode, encode, auto-sequence (IDLE → CALLING → REPORT → FINAL)
- **Sniper mode** — 500 Hz hardware BPF + adaptive equalizer for extreme weak-signal DX
- **Pipelined decode** — Phase 1 results shown instantly, Phase 2 adds subtract signals
- **CAT control** — Yaesu / Icom PTT via Web Serial API or Bluetooth LE
- **Works everywhere** — PC, tablet, smartphone. Chrome, Edge, Safari
- **Offline-capable PWA** — install to home screen, works without network
- **WAV analysis** — drag & drop any FT8 WAV for offline decode

## Quick Start

1. **[Open WebFT8](https://jl1nie.github.io/webft8/)**
2. Allow microphone access
3. Enter your callsign and grid in Settings (gear icon)
4. Select audio input/output → **Start Audio**
5. Connect radio via USB or BLE for CAT control (optional)

**Offline trial:** drag & drop a [test WAV](https://github.com/jl1nie/webft8/raw/main/ft8-bench/testdata/sim_busy_band.wav) onto the waterfall.

## Two Modes

| Mode | Purpose | Use case |
|------|---------|----------|
| **Scout** | Chat-style UI, tap to call | Casual CQ, portable, mobile |
| **Snipe** | DX hunting, target lock | DXpedition pileup, weak signal |

## Sniper Mode — The Differentiator

Standard FT8 apps (WSJT-X, JTDX) decode across a 3 kHz band. When a +40 dB station is present, the 16-bit ADC buries weak signals in quantization noise.

WebFT8's sniper mode uses the transceiver's **500 Hz hardware narrow filter** to physically remove strong interference *before* the ADC, then applies:

1. **Adaptive equalizer** — corrects BPF edge distortion using Costas pilot tones
2. **Successive interference cancellation** — 3-pass subtract with QSB gate
3. **A Priori decoding** — locks known callsign bits (up to 77-bit full lock)

| Snipe | AP | Behavior |
|-------|-----|----------|
| OFF | OFF | Full-band subtract |
| OFF | ON | Full-band + AP |
| ON | OFF | ±250 Hz + EQ |
| ON | ON | ±250 Hz + EQ + AP |

## vs WSJT-X

| Feature | WSJT-X | WebFT8 |
|---------|--------|--------|
| Platform | Desktop (Java/Fortran) | **Browser (Rust/WASM)** |
| BPF integration | None | **500 Hz sniper mode** |
| Equalizer | None | **Costas Wiener adaptive EQ** |
| Parallelism | Serial | **Rayon par_iter (7.7x)** |
| Subtract | 4-pass | **3-pass + QSB gate** |
| Binary size | ~120 MB | **572 KB (full PWA)** |

### Decode Comparison (15 crowd stations + weak target)

| Scenario | WSJT-X | WebFT8 |
|----------|--------|--------|
| crowd +5 dB, target -12 dB | 7 decoded | **16 decoded** |
| crowd +20 dB, target -18 dB | 11 (3Y0Z: AP) | **15** |
| target -18 dB, BPF edge | 1 (AP) | **1 (sniper+EQ+AP)** |

## For Developers

```
webft8/
├── ft8-core/      Pure Rust FT8 decoder/encoder library
├── ft8-bench/     Benchmark & simulation suite
├── ft8-web/       WASM bindings + PWA frontend
├── ft8-desktop/   Tauri native wrapper
└── docs/          GitHub Pages deployment
```

### Build

```bash
# Native
cargo build --release
cargo run -p ft8-bench --release    # benchmarks + simulation

# WASM
cd ft8-web && wasm-pack build --target web --release
```

63 unit tests. WASM binary 413 KB.

## References

- [WSJT-X](https://github.com/saitohirga/WSJT-X) — FT8 reference implementation
- K1JT et al., "The FT4 and FT8 Communication Protocols", QEX, 2020

## License

GPL-3.0-or-later — includes ported algorithms from WSJT-X.

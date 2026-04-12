# WebFT8 Decoder Benchmark Results

**ft8-core v0.3.0 — 2026-04-12**

Simulator-based evaluation of the WebFT8 decoder against reference conditions.
All results are reproducible: `cargo run -p ft8-bench --release`.

---

## Test Environment

| Item | Value |
|------|-------|
| Decoder | ft8-core v0.3.0 (Rust, native release) |
| Signal model | Pure-tone 8-GFSK + AWGN (12 000 Hz, i16) |
| BPF model | 4-pole Butterworth, 500 Hz passband |
| Seed count | 20–30 independent noise realisations per cell |
| Platform | x86-64 Windows 11, Rayon thread-pool |

### Decoder Modes

| Mode | Description |
|------|-------------|
| `full-band` | `decode_frame` — 200–2800 Hz, equivalent to WSJT-X |
| `subtract` | `decode_frame_subtract` — 3-pass subtract + QSB gate |
| `sniper` | `decode_sniper` — ±250 Hz around target freq |
| `sniper+EQ` | `decode_sniper_eq(Adaptive)` — sniper + Costas Wiener EQ |
| `sniper+AP` | `decode_sniper_ap` — sniper + EQ + A Priori callsign lock |
| `sniper-SIC` | `decode_sniper_sic` — sniper + EQ + in-band SIC |

---

## Scenario 1 — Single +40 dB Interferer (200 Hz offset)

Target: `CQ 3Y0Z JD34` @ 1000 Hz, SNR −5 dB  
Interferer: `CQ JQ1QSO PM95` @ 1200 Hz, SNR +35 dB  
Seed: 99

| Mode | Target | Interferer | Total decoded |
|------|--------|-----------|---------------|
| full-band | **missed** | DECODED | 1 |
| sniper (BPF removes interferer) | **DECODED** | — | 1 |

**Key result:** at −5 dB the target is decodable in isolation, but a single +40 dB station 200 Hz away completely masks it in full-band mode. The hardware 500 Hz BPF removes the interferer before the ADC — sniper mode recovers the target.

---

## Scenario 2 — Busy Band, Moderate Crowd

15 crowd stations @ **+5 dB**, target `CQ 3Y0Z JD34` @ 1000 Hz, **−12 dB**, seed 777

| Mode | Target | Total decoded |
|------|--------|---------------|
| full-band | **DECODED** | 16 / 16 |
| sniper | **DECODED** | 2 |

At a moderate crowd level the full-band decoder keeps up. The sniper still finds the target in a narrow window.

---

## Scenario 3 — Busy Band, Hard ADC Saturation

15 crowd stations @ **+40 dB**, target @ **−14 dB** (gap = 54 dB), seed 888

The AGC of a 16-bit ADC scales for the crowd; the −14 dB target occupies only a few LSBs.

| Mode | Target | Total decoded | Notes |
|------|--------|---------------|-------|
| no-BPF full-band | **missed** | 15 | ADC saturated by crowd |
| no-BPF sniper sw | **missed** | 0 | crowd distortion still present |
| **500 Hz BPF + sniper** | **DECODED 100%** | — | 20/20 seeds, SNR −17.3 dB reported |

30-seed statistical sweep (AGC-clipped i16 vs clean i16):

| Mode | Hit rate (30 seeds) |
|------|---------------------|
| AGC full-band | 0 / 30 (0%) |
| AGC sniper sw | 0 / 30 (0%) |
| clean full-band | 0 / 30 (0%) |
| clean sniper sw | 0 / 30 (0%) |
| **500 Hz HW BPF + sniper** | **20 / 20 (100%)** |

**Key result:** software-only techniques cannot recover the target when a 54 dB crowd fully occupies the ADC dynamic range. Only the hardware BPF — by removing the crowd *before* the ADC — achieves reliable decode.

---

## Scenario 4 — BPF Edge Distortion

Target only + AWGN, SNR **−18 dB**, 20 seeds, 4-pole Butterworth 500 Hz BPF.  
Three placements relative to the passband centre.

| Placement | BPF window (Hz) | Target attenuation | EQ OFF | EQ ON |
|-----------|-----------------|--------------------|--------|-------|
| center | 750 – 1250 | −0.0 dB | 12/20 (60%) | 14/20 (**70%**) |
| shoulder | 950 – 1450 | −0.5 dB | 6/20 (30%) | 10/20 (**50%**) |
| edge (−3 dB) | 1000 – 1500 | −3.0 dB | 4/20 (20%) | 9/20 (**45%**) |
| no-BPF (reference) | — | 0 dB | 8/20 (40%) | — |

Filter response (centre = 1000 Hz, 4-pole Butterworth):

| Freq (Hz) | Attenuation |
|-----------|-------------|
| 750 | −3.0 dB |
| 800 | −0.4 dB |
| 900 | −0.0 dB |
| 1000 | −0.0 dB |
| 1200 | −0.9 dB |
| 1250 | −3.0 dB |
| 1300 | −6.4 dB |
| 1500 | −20.2 dB |

**Key result:** the Costas Wiener adaptive equalizer recovers 1.5–2× more decodes at the BPF edge. At the shoulder it closes most of the gap to the no-BPF reference.

---

## Scenario 5 — BPF + In-Band Crowd (Signal Subtraction)

4 crowd stations **inside** the 500 Hz passband (850, 950, 1050, 1150 Hz), SNR **+8 dB** (fixed).  
Target `CQ 3Y0Z JD34` @ 1000 Hz.  
BPF: 750–1250 Hz, 4-pole Butterworth.

### Example decode (target −14 dB, seed 1234)

| Mode | Target | Total decoded |
|------|--------|---------------|
| single-pass sniper | **missed** | 4 (crowd only) |
| subtract (full-band) | **missed** | 4 (crowd only) |
| **sniper-SIC** | **DECODED ★** | 5 |

```
  +1.0 dB   950 Hz  pass=0  CQ JQ1QRM PM95
  +1.4 dB  1050 Hz  pass=0  CQ JQ1QRN PM96
  +1.5 dB   850 Hz  pass=0  CQ JQ1QSO PM95
  +1.6 dB  1150 Hz  pass=0  CQ JQ1QRP PM85
 -20.5 dB  1000 Hz  pass=1  CQ 3Y0Z JD34 ★
```

### Statistical sweep (20 seeds × target SNR)

AP = call2 `3Y0Z` known (実運用でターゲットをロック済みの状態)。

| Target SNR | Gap | single-pass | subtract | sniper-SIC | **sniper-SIC+AP** |
|------------|-----|-------------|----------|------------|-------------------|
| −10 dB | 18 dB | 20/20 (100%) | 20/20 (100%) | 20/20 (100%) | **20/20 (100%)** |
| −12 dB | 20 dB | 14/20 (70%) | 17/20 (85%) | 20/20 (100%) | **20/20 (100%)** |
| −14 dB | 22 dB | 1/20 (5%) | 1/20 (5%) | 13/20 (65%) | **13/20 (65%)** |
| −16 dB | 24 dB | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) |
| −18 dB | 26 dB | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) |
| −20 dB | 28 dB | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) |

**Key results:**
- −12 dB: subtract 85%、sniper-SIC+AP **100%**。AP あり/なしで差なし。
- −14 dB: single-pass/subtract が 5% に崩壊するのに対し、sniper-SIC(+AP) は **65%** を維持。
- −14 dB で AP が効かない理由: ボトルネックは crowd SIC の除去精度。crowd 除去後の残差 SNR が低すぎて、call2 ビットのロックでは LLR が改善されない。BPF edge シナリオ（歪み補正が主目的）とは異なる限界。
- −16 dB 以下: gap 24 dB で crowd が target を完全に埋める。

---

## Scenario 6 — SNR Sensitivity: BPF Edge

BPF edge placement (target at −3 dB point), 20 seeds per row.  
Target: `CQ 3Y0Z JD34`, target + AWGN only.

| SNR | EQ OFF | EQ | EQ + AP (CQ+call2) |
|-----|--------|----|--------------------|
| −16 dB | 19/20 (95%) | 20/20 (100%) | 20/20 (100%) |
| **−18 dB** | 4/20 (20%) | 9/20 (45%) | **20/20 (100%)** |
| −20 dB | 0/20 (0%) | 0/20 (0%) | 4/20 (20%) |
| −22 dB | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) |

AP = A Priori decoding with known callsign `3Y0Z` as call2 (61-bit lock, pass 7).

**Key result:** at the FT8 practical limit of −18 dB, A Priori decoding achieves 100% success where EQ alone gets only 45%. This is the DXpedition use case: once `3Y0Z` is calling, every received frame can have call2 locked.

---

## Scenario 7 — Full QSO: BPF Edge + AP

All QSO message types across a simulated `JA1ABC ↔ 3Y0Z` exchange.  
BPF edge (1000–1500 Hz, 4-pole), 20 seeds each.

| SNR | CQ (61-bit) | REPORT (61-bit) | RR73 (77-bit) |
|-----|-------------|-----------------|---------------|
| −18 dB | 19/20 (95%) | 18/20 (90%) | **20/20 (100%)** |
| −20 dB | 8/20 (40%) | 8/20 (40%) | 15/20 (75%) |
| −22 dB | 2/20 (10%) | 1/20 (5%) | 4/20 (20%) |
| −24 dB | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) |

RR73 and directed messages (77-bit AP, passes 9–11) consistently outperform the CQ case because the full 77-bit message is locked.

---

## Scenario 8 — Extreme Limit Sweep

### Hard-mixed: 15 crowd @ +40 dB, target SNR sweep (20 seeds)

Software-only decode at extreme ADC saturation.

| Target SNR | full-band subtract | sniper + AP |
|------------|-------------------|-------------|
| −14 dB | 0/20 (0%) | 0/20 (0%) |
| −16 dB | 0/20 (0%) | 0/20 (0%) |
| −18 dB | 0/20 (0%) | 0/20 (0%) |
| −20 dB | 0/20 (0%) | 0/20 (0%) |

At +40 dB crowd level, clipping distortion overwhelms the decoder entirely — regardless of algorithm. **Hardware BPF is mandatory** at this dynamic range.

### BPF edge: target SNR sweep (20 seeds, target+AWGN only)

| Target SNR | EQ OFF | EQ | CQ+call2 AP | full 77-bit AP |
|------------|--------|----|-------------|----------------|
| −18 dB | 12/20 (60%) | 14/20 (70%) | 19/20 (95%) | 14/20 (70%) |
| −20 dB | 0/20 (0%) | 0/20 (0%) | 8/20 (40%) | 0/20 (0%) |
| −22 dB | 0/20 (0%) | 0/20 (0%) | 2/20 (10%) | 0/20 (0%) |
| −24 dB | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) | 0/20 (0%) |

---

## Speed Benchmark

100 stations, 200–2800 Hz, SNR +5 dB, 10 runs after 3 warmup.  
Release build (`cargo run -p ft8-bench --release`), Windows 11 x86-64.

| Mode | Decoded | Mean | Min | Max | Budget |
|------|---------|------|-----|-----|--------|
| decode_frame (single-pass) | 58 | 159.7 ms | 156.9 ms | 162.9 ms | 2400 ms |
| decode_frame_subtract (3-pass) | 65 | 285.4 ms | 275.8 ms | 302.8 ms | 2400 ms |
| sniper+EQ (±250 Hz) | 11 | 25.2 ms | 23.6 ms | 27.1 ms | 2400 ms |

All three modes comfortably fit within the FT8 15-second period (2400 ms decode window).  
Sniper mode is **~7× faster** than full-band due to the narrow frequency window.

---

## WSJT-X Comparison

| Scenario | WSJT-X (est.) | WebFT8 |
|----------|---------------|--------|
| 15 crowd +5 dB, target −12 dB | 7 decoded¹ | **16 decoded** |
| 15 crowd +40 dB, target −14 dB | 0% | **0% (SW) / 100% (HW BPF)** |
| BPF edge −18 dB, no AP | N/A | **45%** |
| BPF edge −18 dB, EQ+AP | N/A | **100%** |

¹ WSJT-X value from prior manual comparison run; not re-measured in this run.

---

## WAV Files for External Verification

The benchmark writes synthetic WAV files to `ft8-bench/testdata/` for WSJT-X cross-testing:

| File | Scenario |
|------|----------|
| `sim_busy_band.wav` | 15 crowd +5 dB, target −12 dB |
| `sim_busy_band_hard_mixed.wav` | 15 crowd +40 dB, AGC clipped, target −14 dB |
| `sim_busy_band_hard_clean.wav` | Same but linear scale (no AGC clip) |
| `sim_busy_band_hard_bpf.wav` | BPF only: target −14 dB + AWGN |
| `sim_bpf_center.wav` | BPF center, target −18 dB |
| `sim_bpf_shoulder.wav` | BPF shoulder, target −18 dB |
| `sim_bpf_edge.wav` | BPF edge (−3 dB), target −18 dB |
| `sim_bpf_subtract.wav` | BPF + 4 in-band crowd, target −14 dB |
| `sim_stress_fullband.wav` | 15 crowd +20 dB + target −18 dB (WSJT-X stress) |
| `sim_stress_bpf_edge.wav` | Same, BPF filtered (sniper input) |
| `sim_stress_bpf_edge_clean.wav` | Target-only BPF edge (cleanest WSJT-X comparison) |
| `sim_extreme_hard.wav` | 15 crowd +40 dB, target −20 dB |
| `sim_extreme_edge.wav` | BPF edge, target −22 dB |
| `sim_extreme_edge_24.wav` | BPF edge, target −24 dB (beyond decoder limit) |

All WAVs are 12 000 Hz, 16-bit mono, ~14.6 s (FT8 frame).

---

## Reproducing Results

```bash
# Build and run all benchmarks (release required for speed numbers)
cargo run -p ft8-bench --release
```

Real-recording WAVs (`191111_110130.wav`, `191111_110200.wav`) are not included in the repo.
Download from `https://github.com/jl1nie/RustFT8/tree/main/data` and place in `ft8-bench/testdata/`.

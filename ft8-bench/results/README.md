# ft8-bench filter experiment results

## Setup

- Target: CQ 3Y0Z JD34 @ 1000 Hz
- Crowd: 15 JA fake calls @ +40 dB (ADC-saturating, no-BPF scenario)
- BPF: hardware filter modelled in software (crowd removed before ADC)
- EQ: Adaptive equalizer (Costas-pilot-based)
- AP: a-priori hint call2="3Y0Z"
- Seeds: 20 random noise seeds per data point
- fs: 12000 Hz

## Filter comparison summary (2026-04-12)

| SNR | no-BPF | BW-edge+EQ+AP | BW-center+EQ+AP | EL-edge+EQ+AP | EL-center+EQ+AP |
|-----|--------|---------------|-----------------|---------------|-----------------|
| -10 dB | 0% | 100% | 100% | 100% | 100% |
| -12 dB | 0% | 100% | 100% | 100% | 100% |
| -14 dB | 0% | 100% | 100% | 100% | 100% |
| -16 dB | 0% | 100% | 100% | 100% | 100% |
| -18 dB | 0% | 100% |  95% |  95% |  95% |
| -20 dB | 0% |  20% |  40% |  20% |  35% |
| -22 dB | 0% |   0% |  10% |   0% |  10% |

BW = Butterworth 4-pole (8th-order), EL = Elliptic 4-pole (8th-order), 500 Hz BW

## Key findings

- **BPF vs no-BPF**: どのフィルタでも -16 dB まで 100% デコード。no-BPF は全域で 0%。
- **BW vs EL (center)**: ほぼ同等。Elliptic のパスバンドリップルが -20 dB 以下で 5% 程度不利。
- **BW vs EL (edge)**: Elliptic のエッジ減衰が -8.2 dB (vs BW の -3.0 dB) のため、
  ターゲットがエッジに乗る配置では Butterworth が有利。EQ でも 5 dB 差は回収困難。
- **実運用への示唆**: IC-705 CW フィルタ (Elliptic 特性) でもターゲットを BPF センター
  付近に配置 (VFO を合わせる) すれば Butterworth と同等の性能が得られる。

## Files

| File | Description |
|------|-------------|
| `butterworth_4pole.txt` | Butterworth 単体の全シナリオ結果 |
| `elliptic_vs_butterworth_4pole.txt` | Butterworth vs Elliptic 比較 + フィルタ周波数特性 |

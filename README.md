# rs-ft8n — FT8 Sniper-Mode Decoder in Rust

A next-generation FT8 decoder that couples a **500 Hz hardware narrowband filter** with a software decoder to achieve decodes that WSJT-X cannot — even in environments with a strong adjacent QRM (+40 dB).

## コンセプト / Concept

通常の広帯域 ADC（16bit / 3kHz）では、+40dB 以上の隣接 QRM が存在すると、ターゲット信号が ADC の量子化ノイズに埋没する。本プロジェクトは量子化の**前段**に 500Hz 物理フィルタを置き、ADC の全ダイナミックレンジをターゲット信号に集中させる「スナイパー・モード」を実現する。

In a wideband (3 kHz) ADC, a +40 dB adjacent signal consumes nearly all 16-bit dynamic range, burying the target in quantization noise. By placing a **500 Hz hardware BPF before the ADC**, the full dynamic range is devoted to the target — this is the "Sniper Mode" concept.

```
[Antenna] → [500Hz BPF] → [ADC 16bit] → rs-ft8n → decoded FT8 message
             ↑ removes +40dB QRM before digitisation
```

## デコード性能 / Decode Performance

Verified against real recordings from [jl1nie/RustFT8](https://github.com/jl1nie/RustFT8):

**`191111_110200.wav`** — single-pass:

| Signal | SNR | WSJT-X | rs-ft8n | Method |
|--------|-----|--------|---------|--------|
| CQ R7IW LN35 | −8 dB | ✓ | ✓ | BP |
| CQ TA6CQ KN70 | −8 dB | ✓ | ✓ | BP |
| CQ DX R6WA LN32 | — | ✗ | ✓ | BP |
| OH3NIV ZS6S RR73 | **−14 dB** | ✓ | ✓ | **OSD ord-3** |
| CQ LZ1JZ KN22 | **−15 dB** | ✓ | ✓ | **OSD ord-2** |

**`191111_110130.wav`** — single-pass + subtract multi-pass:

| Signal | freq | single | subtract | Method |
|--------|------|--------|----------|--------|
| CQ DX R6WA LN32 | 2096.9 Hz | ✓ | — | BP |
| CQ R7IW LN35 | 1290.6 Hz | ✓ | — | BP |
| CQ TA6CQ KN70 | 681.2 Hz | ✓ | — | BP |
| OH3NIV ZS6S -3 | 990.6 Hz | ✓ | — | BP |
| TK4LS YC1MRF 73 | 2478.1 Hz | ✗ | ✓ | **OSD pass-3** (score 2.32, errors 29) |

強信号 4 局を除去した残余音声に対し OSD 閾値 2.0 で再スキャン。`TK4LS YC1MRF 73` (Corsica↔Indonesia) を回収。errors=29 は高いが CRC-14 通過。

## アーキテクチャ / Architecture

```
rs-ft8n/
├── ft8-core/          Pure Rust FT8 decode library (no_std ready)
│   └── src/
│       ├── params.rs       FT8 protocol constants
│       ├── downsample.rs   FFT-based 12kHz→200Hz complex baseband
│       ├── sync.rs         2-D Costas correlation + Double Sync + parabolic fine sync
│       ├── llr.rs          Soft-decision LLR (4 metric variants a/b/c/d)
│       ├── wave_gen.rs     FT8 waveform encoder (message77 → PCM)
│       ├── subtract.rs     Signal subtraction (IQ amplitude estimation)
│       ├── equalizer.rs    Adaptive channel equalizer (stub — Phase 3)
│       ├── decode.rs       End-to-end pipeline; single-pass + multi-pass subtract
│       └── ldpc/
│           ├── bp.rs       Log-domain Belief Propagation (30 iter)
│           ├── osd.rs      Ordered Statistics Decoding (order 1-3)
│           └── tables.rs   LDPC(174,91) parity-check matrix
└── ft8-bench/         Benchmark & evaluation harness
    └── src/
        ├── real_data.rs    Full-band WAV evaluation (single-pass + subtract comparison)
        ├── simulator.rs    Synthetic FT8 frame generator (AWGN + strong interferer)
        └── diag.rs         Per-signal pipeline trace
```

## デコードパイプライン / Decode Pipeline

```
PCM 16bit 12kHz
  │
  ▼ downsample (FFT, Hann window)
Complex baseband 200 Hz
  │
  ▼ coarse_sync (Costas correlation, 2-D grid)   ← 1パス (WSJT-X は subtract 連動の 4パス)
Candidate list (freq, dt, score)
  │
  ▼ refine_candidate (combined 3-array peak + parabolic interpolation)
  │   ※ fine_sync_power_split() で Array-1/2/3 個別パワーも取得可能
  │     → 将来の適応等化器 (Phase 3) の入力として使用予定
  │
  ▼ symbol_spectra (32-pt FFT × 79 symbols)
  │
  ▼ sync_quality (hard-decision Costas check, 0-21)
  │
  ▼ compute_llr (Gray-coded soft metrics, 4 variants)
  │
  ├─▶ BP decode (log-domain tanh, 30 iter, CRC-14)
  │     success → DecodeResult (pass=0..3)
  │
  └─▶ OSD fallback (when BP fails, sync_q≥12, score≥2.5)
        order-2 (~4,187 candidates) for sync_q < 18
        order-3 (~121,667 candidates) for sync_q ≥ 18
        success → DecodeResult (pass=4)

decode_frame_subtract: 3パス逐次干渉除去
  Pass 1 (sync×1.0, OSD≥2.5) → 強信号デコード → subtract_signal() で波形除去
  Pass 2 (sync×0.75, OSD≥2.5) → 残余音声から中強度信号
  Pass 3 (sync×0.5,  OSD≥2.0) → スプリアス候補も含めた弱信号
```

## ビルド / Build

```bash
cargo build --release
```

依存クレート: `rustfft`, `num-complex`, `crc`, `hound`

### multi-pass subtract

```rust
use ft8_core::decode::{decode_frame_subtract, DecodeDepth};

let messages = decode_frame_subtract(
    &samples,
    200.0, 2800.0,          // freq range
    1.5,                    // sync_min (pass 1 threshold)
    None,                   // freq_hint
    DecodeDepth::BpAllOsd,
    200,
);
// Pass 1 decoded signals are subtracted; passes 2 & 3 decode from residual
```

## 使い方 / Usage

### ベンチマーク実行 / Run Benchmark

```bash
# テストデータを配置 / Place test WAVs:
# ft8-bench/testdata/191111_110130.wav
# ft8-bench/testdata/191111_110200.wav
# (from https://github.com/jl1nie/RustFT8/tree/main/data)

cargo run -p ft8-bench --release
```

### ライブラリとして使う / Use as Library

```rust
use ft8_core::decode::{decode_frame, DecodeDepth};

let samples: Vec<i16> = /* 12000 Hz PCM */;
let messages = decode_frame(
    &samples,
    200.0,              // freq_min (Hz)
    2800.0,             // freq_max (Hz)
    1.5,                // sync_min threshold
    None,               // freq_hint
    DecodeDepth::BpAllOsd,  // BP + OSD fallback
    200,                // max candidates
);

for msg in &messages {
    println!("{:.1} Hz  dt={:+.2}s  errors={}  pass={}", 
             msg.freq_hz, msg.dt_sec, msg.hard_errors, msg.pass);
}
```

スナイパーモード（500Hz フィルタ後の信号に）:

```rust
use ft8_core::decode::{decode_sniper, DecodeDepth};

let messages = decode_sniper(&samples, 1850.0, DecodeDepth::BpAllOsd, 50);
```

## WSJT-X との相違点 / Differences from WSJT-X

rs-ft8n は WSJT-X のアルゴリズムを Rust へ移植した実装だが、以下の点で意図的に挙動が異なる。

### 同期 (Sync)

| 項目 | WSJT-X | rs-ft8n |
|------|--------|----------|
| 粗同期スキャン | 4 パス（subtract 連動、pass ごとに残余音声を再評価） | 1 パス（double-peak検出付き）＋ subtract 実装後は3パスに移行予定 |
| 候補重複除去 | 周波数 ±4 Hz 以内 | 周波数 ±4 Hz かつ時間 ±40 ms |
| 精密同期（広帯域） | sync8d.f90（±10サンプルスキャン） | ±10 ダウンサンプルサンプル + 放物線補完 |
| 精密同期（スナイパー） | — | **Double Sync**（下記） |
| 精密同期スコア単位 | 複素相関パワー（単位不定） | 同（正規化なし） |
| 探索帯域 | nfa〜nfb（デフォルト 200〜2800 Hz） | decode_frame: 指定範囲 / decode_sniper: center±250 Hz |

**放物線補完（rs-ft8n 独自）:** 精密同期でダウンサンプル軸のピーク前後 1 サンプルから放物線フィットし、サブサンプル精度の時間オフセットを推定する。WSJT-X は整数サンプルのみ。

**Double Sync（rs-ft8n 独自）:** `refine_candidate_double` は Costas Array 1（シンボル 0–6）と Array 3（シンボル 72–78）を**独立に**ピーク探索し、各配列のパワー `(score_a, score_b, score_c)` を個別に取得する。

現在の主な用途：
- DT_A・DT_C の平均で時間オフセットをより精密に推定
- 3 配列のパワー比をチャネル変動（QSB、500Hz フィルタエッジ歪み）の推定に利用（**Phase 3 適応等化器への入力として設計中**）

> **設計注記:** 当初実装していた `|drift_dt_sec| > 40ms` によるゴーストフィルタは、現代のトランシーバ・PC では実際のドリフトがほぼゼロであり効果が薄いため廃止予定。代わりに 3 配列のパワーを等化器に活用する方向で再設計中。

| 項目 | WSJT-X | rs-ft8n |
|------|--------|---------|
| 変換名 | `ft8b.f90` | `llr.rs::compute_llr` |
| 出力バリアント | llra/llrb/llrc/llrd | 同（4 バリアント） |
| nsym=2 のグルーピング | 2 シンボルずつ step=2 | 同 |
| 正規化 | normalizebmet（std dev） | 同 |
| スケール係数 | 2.83 | 2.83（同一） |
| AP (A Priori) パス | あり（pass 1-4） | なし（将来実装予定） |

### OSD フォールバック

| 項目 | WSJT-X | rs-ft8n |
|------|--------|---------|
| 適用条件 | ndeep≥1 かつ sync_q≥12 | score≥2.5 かつ sync_q≥12 |
| デプス選択 | コマンドライン引数 | sync_q≥18 → order-3、それ未満 → order-2 |
| 偽陽性フィルタ | hard_errors閾値なし | hard_errors≥56 を棄却 |
| 周波数重複チェック | なし | ±20 Hz 以内の既存デコードをスキップ |

**score≥2.5 フィルタ（rs-ft8n 独自）:** 実信号のコアース同期スコアは ≥3.0。スコアが 1.6〜2.3 程度の候補に order-3 OSD を適用すると CRC 衝突（偽陽性）が多発するため、このフィルタで排除する。

### ダウンサンプリング

| 項目 | WSJT-X | rs-ft8n |
|------|--------|---------|
| 変換 | `ft8_downsample.f90` | `downsample.rs` |
| FFT サイズ | 192000 pt（ゼロパディング） | 192000 pt（同一） |
| 周波数抽出帯域 | f0±(1.5〜8.5) baud | 同 |
| エッジテーパ | Hann窓 101 bin | 同 |
| 出力 | 3200 複素サンプル @ 200 Hz | 同 |
| キャッシュ | なし（毎回再計算） | 候補間で FFT 結果を再利用 |

**FFT キャッシュ（rs-ft8n 独自）:** 同一フレームの複数候補をデコードする際、192000 pt 前向き FFT 結果を再利用してダウンサンプリングの計算量を削減する。

---

## 技術詳細 / Technical Notes

### Belief Propagation (BP)
WSJT-X `bpdecode174_91.f90` から移植。log-domain tanh メッセージパッシング、最大 30 反復、早期停止付き。

### Ordered Statistics Decoding (OSD)
WSJT-X `osd174_91.f90` から移植。

1. |LLR| 降順でビットを整列
2. 系統的生成行列を置換・GF(2) ガウス消去 → 最信頼基底 (MRB) を特定
3. MRB の硬判定符号語（order-0）+ 1〜3 ビット反転候補を列挙
4. CRC-14 を通過した最小重み符号語を返す

SNR −15 dB の信号を order-2 で、−14 dB を order-3 で回収。

### LDPC(174, 91)
パリティ検査行列は WSJT-X `ldpc_174_91_c_parity.f90` から移植。生成行列は `ldpc_174_91_c_generator.f90` から移植。

## 合成シナリオ実験結果 / Synthetic Scenario Results

`cargo run -p ft8-bench --release` による合成実験（AWGN + 強信号混入）の結果：

| シナリオ | ターゲット (1000 Hz, −5 dB) | 妨害局 (1200 Hz, +35 dB) |
|----------|---------------------------|--------------------------|
| 広帯域（フィルタなし） | **missed** | DECODED |
| スナイパーモード（BPF 模倣） | **DECODED** | — (BPF 外) |

**解釈:** 同じ信号・同じ SNR でも、+40 dB 差の隣接妨害局が存在する広帯域環境ではデコード失敗する。500 Hz BPF で妨害局を物理的に遮断することでターゲットの回収に成功する。合成 WAV ファイルは `ft8-bench/testdata/sim_interference.wav` に書き出される（WSJT-X で検証可能）。

## ロードマップ / Roadmap

- [x] Phase 1: 基本デコードパイプライン (BP)
- [x] Phase 2: 実データ評価 + OSD フォールバック → WSJT-X 同等
- [x] Phase 2b: Double Sync（Array-1/3 独立ピーク + ゴーストフィルタ）
- [x] Phase 2c: 合成シナリオ生成器 (simulator.rs) + +40 dB 混入実証
- [ ] Phase 3: 適応型等化器 (500Hz フィルタエッジ補正)
- [ ] Phase 4: Signal subtract (2nd パス再デコード)
- [ ] Phase 5: WASM 化 (Web Audio API 対応)

## 参考 / References

- [WSJT-X](https://github.com/saitohirga/WSJT-X) — FT8 Fortran reference implementation
- [jl1nie/RustFT8](https://github.com/jl1nie/RustFT8) — test WAV data source
- K1JT et al., "FT8, a Weak-Signal Mode for HF DXing", QST, 2018

## ライセンス / License

GNU General Public License v3.0 (GPLv3)

WSJT-X (the reference implementation) is distributed under GPLv3, and this
project incorporates ported algorithms from WSJT-X.  See [LICENSE](LICENSE).

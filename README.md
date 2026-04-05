# rs-ft8n — FT8 スナイパーモード・デコーダ

**[English version](README.en.md)** | **[WASM Demo](https://jl1nie.github.io/rs-ft8n/)**

500 Hz ハードウェア・ナローフィルタと適応型等化器を統合した Pure Rust FT8 デコーダ。
WSJT-X がデコードできない信号の復調に成功 — 合成ワーストケースで実証済み。

## プロジェクトの狙い

### 16 bit 量子化の壁

FT8 は 3 kHz 幅の音声帯域を数十局が共有する。+40 dB の隣接局が存在すると、16 bit ADC のダイナミックレンジはほぼ強信号に消費され、微弱なターゲット信号は量子化ノイズに埋没する。WSJT-X は 3 kHz 全体を等しく処理するため、この状況でターゲットを回収できない。

### 500 Hz 物理フィルタ＋ソフトウェアの一点突破

rs-ft8n は無線機に内蔵された **500 Hz CW/SSB ナローフィルタ** を積極的に利用する。

```
[アンテナ] → [500 Hz BPF (無線機内蔵)] → [ADC 16 bit] → rs-ft8n → デコード
               ↑ 強信号を量子化の前段で物理的に除去
```

1. **物理フィルタで遮断** — ターゲット周波数を中心に ±250 Hz だけ通過させ、帯域外の強信号を ADC 到達前に除去。ADC の全ダイナミックレンジをターゲットに集中させる。
2. **適応型等化器で補正** — 急峻なフィルタ肩の振幅ロールオフと位相歪みを、Costas Array パイロットトーンから推定した H(f) の逆特性で補正。
3. **逐次干渉除去** — BPF 通過帯域内に残った他局を BP/OSD デコード後に波形減算し、さらに微弱な信号を浮上させる。
4. **A Priori (AP) デコード** — ターゲット局のコールサインが既知なら、77 bit メッセージのうち 32 bit を高信頼度でロックし、BP デコーダの実質的な閾値を数 dB 引き下げる。

この「ハードウェアで守り、ソフトウェアで磨く」アプローチにより、WSJT-X の限界を超える。

## WSJT-X との主な差分

| 機能 | WSJT-X | rs-ft8n |
|------|--------|---------|
| 帯域 | 3 kHz 全域を等しく処理 | **500 Hz BPF 前提のスナイパーモード** |
| 等化器 | なし | **Costas Wiener 適応型 EQ**（BPF 肩補正） |
| AP デコード | QSO 進行状態に応じた多段 AP | **ターゲット局コール既知で 32 bit ロック** |
| 精密同期 | 整数サンプル + 固定オフセット | **メイン sync で放物線補完**（サブサンプル精度） |
| 逐次干渉除去 | subtract 連動 4 パス | **3 パス + QSB ゲート**（Costas CV > 0.3 で減算ゲイン半減） |
| OSD フォールバック | ndeep 指定 | **sync_q 適応** (≥18 → order-3、それ未満 → order-2) |
| OSD 偽陽性対策 | なし | **hard_errors ≥ 56 棄却 + score ≥ 2.5 ゲート** |
| FFT キャッシュ | `save` 変数でシリアル再利用 | **明示的キャッシュ + Rayon 並列共有** |
| 並列化 | なし | **Rayon par_iter** による候補並列デコード |
| SNR 推定 | 内蔵 | **WSJT-X 互換方式** (`10log10(xsig/xnoi-1) - 27 dB`) |
| メッセージ | unpack のみ | **pack / unpack 双方向**（シミュレータ用） |

## 実験結果

### 実録音の WSJT-X 比較

[jl1nie/RustFT8](https://github.com/jl1nie/RustFT8) の WAV ファイルで検証
(`191111_110200.wav`、single-pass):

| 信号 | SNR | WSJT-X | rs-ft8n | 方式 |
|------|-----|--------|---------|------|
| CQ R7IW LN35 | -8 dB | ✓ | ✓ | BP |
| CQ DX R6WA LN32 | — | ✗ | ✓ | BP |
| CQ TA6CQ KN70 | -8 dB | ✓ | ✓ | BP |
| OH3NIV ZS6S RR73 | -17 dB | ✓ | ✓ | OSD-3 |
| CQ LZ1JZ KN22 | -17 dB | ✓ | ✓ | OSD-2 |

Signal subtract (`191111_110130.wav`):

| 信号 | 方式 | 備考 |
|------|------|------|
| TK4LS YC1MRF 73 | OSD pass-3 | 強信号 4 局を減算後に回収 |

### Busy-band ADC 飽和シナリオ (合成、15 crowd @ +40 dB、target @ -14 dB)

| デコードモード | ターゲット |
|----------------|-----------|
| Full-band（WSJT-X 相当） | **missed** — ADC が crowd で飽和 |
| Sniper（ソフトのみ、BPF なし） | missed — crowd 歪み |
| **500 Hz BPF + sniper** | **20/20 seeds (100%)** |

### BPF 肩特性 + 適応型等化器 (target @ -18 dB、4-pole Butterworth 500 Hz)

| 配置 | BPF 減衰 | EQ OFF | EQ Adaptive |
|------|----------|--------|-------------|
| Center | 0 dB | 40% | 40% |
| Shoulder | -0.5 dB | 30% | 40% |
| **Edge** | **-3.0 dB** | **10%** | **30%** |

フィルタ肩でのデコード率が 3 倍に改善。Center での劣化はゼロ。

### WSJT-X ストレステスト

`sim_stress_bpf_edge_clean.wav` — target -18 dB、BPF edge (-3 dB 減衰):

| デコーダ | 結果 |
|----------|------|
| **WSJT-X** | **デコード不能** |
| **rs-ft8n sniper + EQ** | **CQ 3Y0Z JD34 デコード成功** |

### BPF edge SNR sweep — BPF + EQ + AP の累積効果

BPF edge (-3 dB)、ターゲット局コール (3Y0Z) のみ既知、20 seeds:

| SNR | EQ OFF | EQ Adaptive | **EQ + AP** |
|-----|--------|-------------|-------------|
| -16 dB | 95% | 100% | 100% |
| **-18 dB** | **10%** | **30%** | **60%** |
| -20 dB | 0% | 0% | 5% |
| -22 dB | 0% | 0% | 0% |

-18 dB で WSJT-X: 0%、rs-ft8n EQ+AP: 60%。BPF → EQ → AP の各段で閾値が引き下がる。

### BPF 帯域内 crowd + signal subtraction

BPF 通過帯域内に crowd 4 局 (@ +8 dB)、target (@ -14 dB):

| モード | デコード数 | ターゲット |
|--------|-----------|-----------|
| Single-pass | 4（crowd のみ） | missed |
| **Subtract** | **5** | **CQ 3Y0Z JD34 ★** |

### デコーダ性能 (100 局、release build)

測定環境: AMD Ryzen 9 9900X (12C/24T)、32 GB RAM、rustc 1.94.0、WSL2 Linux 5.15

| モード | デコード数 | 1 thread | 12 threads | FT8 バジェット (2.4 s) |
|--------|-----------|----------|------------|----------------------|
| decode_frame (single) | 82 | 147 ms | 19 ms | 0.8% |
| decode_frame_subtract (3-pass) | 89 | 440 ms | 119 ms | 5.0% |
| sniper + EQ (Adaptive) | 16 | 65 ms | 22 ms | 0.9% |

**並列化について:** WSJT-X の FT8 デコーダは候補ループをシリアルに処理する。rs-ft8n は **Rayon で候補を並列デコード** し、12 コアで最大 7.7 倍の高速化を実現。シングルスレッドでも 100 局 440 ms（バジェット内）であり、並列化はマージン拡大のための最適化。

## 機能詳細

### デコードパイプライン

```
PCM 16-bit 12 kHz
  ↓ downsample (192k-pt FFT + Hann 窓 → 200 Hz 複素ベースバンド)
  ↓ coarse_sync (Costas 相関、2-D 時間-周波数グリッド)
  ↓ refine_candidate (3-array ピーク + 放物線補完)
  ↓ symbol_spectra (32-pt FFT × 79 シンボル)
  ↓ [equalizer] (Costas パイロットからの Wiener 補正)
  ↓ compute_llr (Gray 符号ソフトメトリック、4 バリアント a/b/c/d)
  ├→ BP decode (log-domain、30 反復、CRC-14)
  ├→ OSD fallback (order 2-3、BP 失敗 + sync_q ≥ 12 時)
  └→ [AP pass] (既知ビットをロックして BP 再試行、pass=5)
```

### 適応型等化器 (`equalizer.rs`)

Costas Array をパイロットトーンとして BPF の振幅/位相歪みを補正。

- **パイロット推定:** 3 Costas × 7 tone → トーンごとに平均。Tone 7（Costas 未使用）は tone 5-6 から線形外挿。
- **Wiener フィルタ:** `W[t] = pilot[t]* / (|pilot[t]|² + σ²_noise)`。低 SNR では自動的にパススルー、高 SNR では完全補正。
- **Adaptive モード:** EQ を先に試行し、失敗時に raw デコードへフォールバック。Center 劣化ゼロ、Edge 最大効果。

### A Priori (AP) デコード (`decode.rs`)

ターゲット局のコールサインが既知のとき、77 bit メッセージの一部を高信頼度 LLR でロックして BP デコーダに渡す。ロックされたビットは BP 反復中に更新されず（WSJT-X と同じ凍結機構）、未知ビット数が減ることでデコード閾値が下がる。

- **AP 値:** `apmag = max(|llr|) × 1.01`（チャネル LLR の最大絶対値より少し強い値）
- **ロック対象 (call2 のみ):** bits 29–57 (28 bit コール + 1 bit フラグ) + bits 74–76 (i3=1) = **32 bit**
- **残り未知:** 45 bit（call1 28 bit + フラグ + report 15 bit 等）
- **動作:** BP + OSD が失敗した後にのみ AP パスを試行（pass=5）

```rust
use ft8_core::decode::{decode_sniper_ap, DecodeDepth, EqMode, ApHint};

let ap = ApHint::new().with_call2("3Y0Z");
let results = decode_sniper_ap(
    &samples, 1000.0, DecodeDepth::BpAllOsd, 20,
    EqMode::Adaptive, Some(&ap),
);
```

### 逐次干渉除去 (`subtract.rs` + `decode.rs`)

3 パス SIC (Successive Interference Cancellation):

| パス | Sync 閾値 | OSD 閾値 | 目的 |
|------|----------|----------|------|
| 1 | 1.0× | 2.5 | 強信号 |
| 2 | 0.75× | 2.5 | 残余からの中強度信号 |
| 3 | 0.5× | 2.0 | クリーンアップ後の微弱信号 |

- IQ 最小二乗振幅推定（任意搬送波位相対応）
- QSB ゲート: Costas パワー CV > 0.3 で減算ゲインを 0.5 に低減

### Butterworth BPF シミュレーション (`bpf.rs`)

4-pole (8 次) IIR バンドパスフィルタ（ハードウェア CW フィルタの模擬）:

```
フィルタ応答 (500 Hz BW、center = 1000 Hz):
   750 Hz:  -3.0 dB    (通過帯域端)
   900 Hz:  -0.0 dB
  1000 Hz:  -0.0 dB    (中心)
  1250 Hz:  -3.0 dB    (通過帯域端)
  1500 Hz: -20.2 dB    (阻止帯域)
```

### メッセージコーデック (`message.rs`)

77 bit FT8 メッセージの双方向エンコード/デコード:

- **Unpack:** Type 0 (フリーテキスト、DXpedition)、Type 1/2 (標準)、Type 3 (RTTY)、Type 4 (非標準コール)
- **Pack:** `pack28` (コールサイン → 28 bit トークン)、`pack_grid4`、`pack77_type1` (CQ/コール/グリッド → 77 bits)

## アーキテクチャ

```
rs-ft8n/
├── ft8-core/          Pure Rust FT8 デコードライブラリ
│   └── src/
│       ├── params.rs       FT8 プロトコル定数
│       ├── downsample.rs   FFT ダウンサンプル (12 kHz → 200 Hz)
│       ├── sync.rs         Costas 相関 + 放物線精密同期
│       ├── llr.rs          ソフト判定 LLR (4 バリアント)
│       ├── equalizer.rs    適応型等化器 (Wiener パイロット)
│       ├── wave_gen.rs     FT8 波形エンコーダ
│       ├── subtract.rs     信号減算 (IQ 振幅推定)
│       ├── message.rs      77 bit メッセージ pack/unpack
│       ├── decode.rs       パイプライン統合 (single/subtract/sniper)
│       └── ldpc/
│           ├── bp.rs       Belief Propagation (30 反復)
│           ├── osd.rs      Ordered Statistics Decoding (order 1-3)
│           └── tables.rs   LDPC(174,91) パリティ検査行列
└── ft8-bench/         ベンチマーク・シナリオ実行
    └── src/
        ├── main.rs         全シナリオ + 速度ベンチマーク
        ├── bpf.rs          Butterworth BPF (4-pole IIR)
        ├── simulator.rs    合成 FT8 フレーム生成
        ├── real_data.rs    実 WAV 評価
        └── diag.rs         信号別パイプライントレース
```

47 ユニットテスト、全 pass。

## ビルド

```bash
cargo build --release
```

依存クレート: `rustfft`, `num-complex`, `hound`, `rayon`

### 全シナリオ + ベンチマーク実行

```bash
# テスト WAV を配置（任意、実データ評価用）:
#   ft8-bench/testdata/191111_110130.wav
#   ft8-bench/testdata/191111_110200.wav
#   (https://github.com/jl1nie/RustFT8/tree/main/data から取得)

cargo run -p ft8-bench --release
```

### ライブラリとして使用

```rust
use ft8_core::decode::{decode_frame, DecodeDepth};

let samples: Vec<i16> = /* 12000 Hz, 16-bit PCM */;
let results = decode_frame(
    &samples,
    200.0, 2800.0,        // 周波数範囲 (Hz)
    1.5,                   // sync_min 閾値
    None,                  // freq_hint
    DecodeDepth::BpAllOsd, // BP + OSD フォールバック
    200,                   // 最大候補数
);

for r in &results {
    let text = ft8_core::message::unpack77(&r.message77);
    println!("{:+.0} dB  {:.1} Hz  {}", r.snr_db, r.freq_hz,
             text.unwrap_or_default());
}
```

スナイパーモード（500 Hz フィルタ + EQ + AP）:

```rust
use ft8_core::decode::{decode_sniper_ap, DecodeDepth, EqMode, ApHint};

// ターゲット局のコールサインが既知の場合
let ap = ApHint::new().with_call2("3Y0Z");
let results = decode_sniper_ap(
    &samples,
    1000.0,                // ターゲット周波数 (Hz)
    DecodeDepth::BpAllOsd,
    20,                    // 最大候補数
    EqMode::Adaptive,      // 等化器モード
    Some(&ap),             // A Priori ヒント
);
```

## References

- [WSJT-X](https://github.com/saitohirga/WSJT-X) — FT8 Fortran リファレンス実装
- [jl1nie/RustFT8](https://github.com/jl1nie/RustFT8) — テスト WAV データ
- K1JT et al., "The FT4 and FT8 Communication Protocols", QEX, 2020
- S. Franke, B. Somerville, J. Taylor, "Work Weak Signals on HF with WSJT-X", QST, 2018

## License

GNU General Public License v3.0 (GPLv3)

WSJT-X はGPLv3 で配布されており、本プロジェクトは WSJT-X から移植したアルゴリズムを含む。[LICENSE](LICENSE) を参照。

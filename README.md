# rs-ft8n — FT8 スナイパーモード・デコーダ

**[English version](README.en.md)** | **[PWA を開く](https://jl1nie.github.io/rs-ft8n/)** | **[PWA マニュアル](docs/manual.md)**

500 Hz ハードウェア・ナローフィルタと適応型イコライザを統合した Pure Rust FT8 デコーダ。
ブラウザだけで QSO が完結する WASM PWA — ウォーターフォール、ライブデコード、送信、CAT 制御、ログ管理まで搭載。

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
2. **適応型イコライザで補正** — 急峻なフィルタ肩の振幅ロールオフと位相歪みを、Costas Array パイロットトーンから推定した H(f) の逆特性で補正。
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
| OSD 偽陽性対策 | なし | **order 別 hard_errors 閾値** + **コールサイン妥当性チェック** |
| FFT キャッシュ | `save` 変数でシリアル再利用 | **明示的キャッシュ + Rayon 並列共有** |
| 並列化 | なし | **Rayon par_iter** による候補並列デコード |
| WASM | なし | **ブラウザで QSO 完結** (WASM 306 KB) |

## PWA — ブラウザだけで FT8 QSO

**[https://jl1nie.github.io/rs-ft8n/](https://jl1nie.github.io/rs-ft8n/)**

インストール不要。Chrome / Edge / Safari で動作。詳細は **[PWA マニュアル](docs/manual.md)** を参照。

### 2 つの運用モード

**Scout モード** — チャット風 UI でゆるく CQ 運用。受信メッセージをタップして局を呼ぶ。移動運用・スマホに最適。

**Snipe モード** — DX ハンティング専用。Watch フェーズ（全帯域受信、ターゲット探索、競合局一覧）と Call フェーズ（ナロー、ターゲットだけ表示）を切り替えて運用。

### 主な機能

- **ウォーターフォール** — 200-2800 Hz リアルタイムスペクトログラム、デコード結果オーバーレイ、タップで TX 周波数設定
- **ライブオーディオ** — USB オーディオ経由でリグに接続、15 秒ごとの自動デコード
- **QSO ステートマシン** — IDLE → CALLING → REPORT → FINAL → 完了。Auto モードで全自動、手動モードで TX メッセージ選択
- **CAT 制御** — Web Serial API で Yaesu / Icom の PTT を制御
- **ログ管理** — QSO（完了＋途中終了）と全受信デコードを localStorage に蓄積。ZIP エクスポート（ADIF + RX CSV）
- **WAV 解析** — ウォーターフォールに WAV を D&D でオフライン解析（ライブ中でも自動停止して処理）
- **Snipe + AP** — 500 Hz BPF 窓 + ターゲット局コールロック。4 通りの組み合わせ:

| Snipe | AP | 動作 |
|-------|-----|------|
| OFF | OFF | Full-band subtract |
| OFF | ON | Full-band + AP（特定局を全帯域から探す） |
| ON | OFF | ±250 Hz + EQ（周波数を絞るが局は問わない） |
| ON | ON | ±250 Hz + EQ + AP（フル機能） |

### クイックスタート

1. **[PWA を開く](https://jl1nie.github.io/rs-ft8n/)**
2. 設定パネル（⚙）で My Callsign と My Grid を入力
3. **オフライン試用:** テスト WAV をダウンロードしてウォーターフォールに D&D:
   - [sim_busy_band.wav](https://github.com/jl1nie/rs-ft8n/raw/main/ft8-bench/testdata/sim_busy_band.wav) — 15 局 + 微弱ターゲット
   - [sim_stress_bpf_edge_clean.wav](https://github.com/jl1nie/rs-ft8n/raw/main/ft8-bench/testdata/sim_stress_bpf_edge_clean.wav) — **WSJT-X がデコードできない信号**
4. **ライブ運用:** Audio Input / Output を選択 → Start Audio → CQ ボタンで QSO 開始

### WSJT-X との比較

各 WAV には 15 局の crowd と、微弱なターゲット局 **CQ 3Y0Z JD34** が含まれる。

| WAV | シナリオ | WSJT-X | rs-ft8n WASM (subtract) |
|-----|---------|--------|------------------------|
| `sim_busy_band.wav` | crowd +5 dB / target -12 dB / 正規化量子化 | 7 局 | **16 局（3Y0Z 含む）** |
| `sim_stress_fullband.wav` | crowd +20 dB / target -18 dB / **AGC → ADC 飽和** | 10 局（3Y0Z なし） | **15 局（3Y0Z なし）** |
| **`sim_stress_bpf_edge_clean.wav`** | target -18 dB / BPF edge -3 dB | **デコード不能** | **CQ 3Y0Z JD34 (197 ms)** ※ |

> ※ rs-ft8n は EQ + AP（ターゲット局コール事前指定）を併用。WSJT-X でも DX Call に 3Y0Z を設定して AP を有効化したがデコードには至らなかった。EQ による BPF 肩補正が寄与していると考えられる。AP なし (EQ のみ) でも 30% のデコード率がある ([詳細](#bpf-edge-snr-sweep--bpf--eq--ap-の累積効果))。

### 全テスト WAV

リポジトリの [`ft8-bench/testdata/`](https://github.com/jl1nie/rs-ft8n/tree/main/ft8-bench/testdata) に 12 本の合成 WAV（各 352 KB、12 kHz / 16 bit mono）が含まれる。

## 実験結果（詳細）

### 実録音の WSJT-X 比較

[jl1nie/RustFT8](https://github.com/jl1nie/RustFT8) の WAV ファイルで検証 (`191111_110200.wav`、single-pass):

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

### BPF + EQ + AP 累積効果 (target @ -18 dB、BPF edge -3 dB、20 seeds)

| SNR | EQ OFF | EQ Adaptive | **EQ + AP** |
|-----|--------|-------------|-------------|
| -16 dB | 95% | 100% | 100% |
| **-18 dB** | **10%** | **30%** | **60%** |
| -20 dB | 0% | 0% | 5% |

### ストレステスト

`sim_stress_bpf_edge_clean.wav` — target -18 dB、BPF edge:

| デコーダ | 結果 | 時間 |
|----------|------|------|
| **WSJT-X** (DX Call=3Y0Z) | **デコード不能** | — |
| **rs-ft8n Native** | **CQ 3Y0Z JD34** | ~22 ms |
| **rs-ft8n WASM** | **CQ 3Y0Z JD34** | 197 ms |

### デコーダ性能

Native: AMD Ryzen 9 9900X (12C/24T)、32 GB RAM、rustc 1.94.0、WSL2 Linux 5.15
WASM: Chrome、同一 PC

#### Native (100 局、release build)

| モード | デコード数 | 1 thread | 12 threads | FT8 バジェット (2.4 s) |
|--------|-----------|----------|------------|----------------------|
| decode_frame (single) | 82 | 147 ms | 19 ms | 0.8% |
| decode_frame_subtract (3-pass) | 89 | 440 ms | 119 ms | 5.0% |
| sniper + EQ (Adaptive) | 16 | 65 ms | 22 ms | 0.9% |

**並列化:** WSJT-X の FT8 デコーダは候補ループをシリアルに処理する。rs-ft8n は **Rayon で候補を並列デコード** し、12 コアで最大 7.7 倍の高速化を実現。シングルスレッドでも 100 局 440 ms（バジェット内）であり、並列化はマージン拡大のための最適化。

#### WASM vs Native

| WAV | 信号数 | Native 1T | WASM | WASM / Native 1T |
|-----|--------|-----------|------|-------------------|
| sim_stress_bpf_edge_clean | 1 局 | 65 ms | 197 ms | 3.0x |
| sim_busy_band | 16 局 | 147 ms | 213 ms | 1.4x |

WASM はシングルスレッド実行だが Native 1T の 1.4-3.0 倍に収まり、FT8 バジェットに対して十分な余裕がある。

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
  ├→ OSD fallback (order-2: pass=4、order-3: pass=5、sync_q ≥ 12)
  ├→ [AP pass] (既知ビットをロックして BP 再試行、pass=6)
  └→ メッセージ妥当性チェック (コールサインフォーマット検証)
```

### 適応型イコライザ (`equalizer.rs`)

Costas Array をパイロットトーンとして BPF の振幅/位相歪みを補正。

- **パイロット推定:** 3 Costas × 7 tone → トーンごとに平均。Tone 7 は tone 5-6 から線形外挿。
- **Wiener フィルタ:** `W[t] = pilot[t]* / (|pilot[t]|² + σ²_noise)`。低 SNR で自動パススルー。
- **Adaptive モード:** EQ を先に試行し、失敗時に raw デコードへフォールバック。Center 劣化ゼロ、Edge 最大効果。

### A Priori (AP) デコード (`decode.rs`)

ターゲット局のコールサインが既知のとき、77 bit メッセージの一部を高信頼度 LLR でロック。ロックされたビットは BP 反復中に凍結（WSJT-X と同じ機構）。

- **AP 値:** `apmag = max(|llr|) × 1.01`
- **ロック対象:** call2 (29 bit) + i3 (3 bit) = **32 bit**
- **動作:** BP + OSD が失敗した後にのみ AP パスを試行 (pass=6)

### OSD 偽陽性フィルタ

二段構え:
1. **hard_errors 閾値** — order-2: <40、order-3: <30（CRC-14 衝突確率に基づく）
2. **コールサイン妥当性** — WSJT-X `stdCall` 正規表現を移植: `(prefix)(digit + 0-3 letters)(/R|/P)?`

### 逐次干渉除去 (`subtract.rs`)

3 パス SIC。IQ 最小二乗振幅推定 + QSB ゲート (Costas CV > 0.3 で減算ゲイン半減)。

### Butterworth BPF シミュレーション (`bpf.rs`)

4-pole (8 次) IIR。-3 dB at passband edges, -20 dB at ±500 Hz。

## アーキテクチャ

```
rs-ft8n/
├── ft8-core/          Pure Rust FT8 デコードライブラリ (rayon feature-gated)
│   └── src/
│       ├── decode.rs       パイプライン統合 (single/subtract/sniper/AP)
│       ├── equalizer.rs    適応型イコライザ (Wiener パイロット)
│       ├── message.rs      77 bit pack/unpack + コールサイン検証
│       ├── subtract.rs     信号減算 (IQ 振幅推定)
│       ├── wave_gen.rs     FT8 波形エンコーダ
│       ├── downsample.rs   FFT ダウンサンプル (12 kHz → 200 Hz)
│       ├── sync.rs         Costas 相関 + 放物線精密同期
│       ├── llr.rs          ソフト判定 LLR (4 バリアント) + SNR 算出
│       ├── params.rs       FT8 プロトコル定数
│       └── ldpc/           BP (30 反復) + OSD (order 1-3) + LDPC 表
├── ft8-bench/         ベンチマーク・シナリオ実行
│   └── src/
│       ├── main.rs         全シナリオ + 100 局速度ベンチマーク
│       ├── bpf.rs          Butterworth BPF (4-pole IIR)
│       ├── simulator.rs    合成 FT8 フレーム生成
│       ├── real_data.rs    実 WAV 評価
│       └── diag.rs         信号別パイプライントレース
├── ft8-web/           WASM PWA フロントエンド
│   ├── src/lib.rs          wasm-bindgen API (decode/sniper/subtract/encode)
│   └── www/
│       ├── index.html      Scout/Snipe デュアルモード UI
│       ├── app.js          オーケストレータ (モード切替/デコード/TX/ログ)
│       ├── qso.js          QSO ステートマシン (IDLE→CALLING→REPORT→FINAL)
│       ├── waterfall.js    Canvas スペクトログラム (radix-2 FFT, DF ライン)
│       ├── qso-log.js      QSO + RX ログ管理、ZIP エクスポート (ADIF + CSV)
│       ├── cat.js          CAT 制御 (Yaesu/Icom, Web Serial API)
│       ├── audio-capture.js    getUserMedia + AudioWorklet
│       ├── audio-output.js     TX 音声出力 (setSinkId 対応)
│       ├── audio-processor.js  AudioWorklet (48kHz→12kHz デシメーション)
│       └── ft8-period.js       FT8 15 秒ピリオド管理 + TX キュー
└── docs/              GitHub Pages デプロイ (ft8-web/www/ から自動同期)
```

54 ユニットテスト、全 pass。WASM バイナリ 306 KB。

## ビルド

```bash
cargo build --release          # Native (ft8-core + ft8-bench)
cargo run -p ft8-bench --release   # 全シナリオ + ベンチマーク
```

WASM ビルド:
```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
cd ft8-web && wasm-pack build --target web --release
```

依存クレート: `rustfft`, `num-complex`, `hound`, `rayon` (native), `wasm-bindgen` (wasm)

### ライブラリとして使用

```rust
use ft8_core::decode::{decode_frame, DecodeDepth};

let samples: Vec<i16> = /* 12000 Hz, 16-bit PCM */;
let results = decode_frame(
    &samples, 200.0, 2800.0, 1.5, None, DecodeDepth::BpAllOsd, 200,
);
```

スナイパーモード + AP:
```rust
use ft8_core::decode::{decode_sniper_ap, DecodeDepth, EqMode, ApHint};

let ap = ApHint::new().with_call2("3Y0Z");
let results = decode_sniper_ap(
    &samples, 1000.0, DecodeDepth::BpAllOsd, 20,
    EqMode::Adaptive, Some(&ap),
);
```

## References

- [WSJT-X](https://github.com/saitohirga/WSJT-X) — FT8 Fortran リファレンス実装
- [jl1nie/RustFT8](https://github.com/jl1nie/RustFT8) — テスト WAV データ
- K1JT et al., "The FT4 and FT8 Communication Protocols", QEX, 2020

## License

GNU General Public License v3.0 (GPLv3) — WSJT-X から移植したアルゴリズムを含む。[LICENSE](LICENSE) を参照。

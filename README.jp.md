# WebFT8 — ブラウザで動く FT8

**[English](README.md)** | **[アプリを開く](https://jl1nie.github.io/webft8/)** | **[マニュアル](docs/manual.md)**

> Pure Rust 製 FT8 デコーダを WASM PWA として動作。
> インストール不要・Java 不要 — 開くだけで運用できる。

## 機能

- **フル FT8 QSO** — デコード・エンコード・自動シーケンス（IDLE → CALLING → REPORT → FINAL）
- **スナイパーモード** — 500 Hz ハードウェア BPF + 適応型イコライザで超弱信号 DX に対応
- **パイプラインデコード** — Phase 1 結果を即時表示、Phase 2 で減算デコードを追加
- **CAT 制御** — Web Serial API または Bluetooth LE で八重洲・Icom の PTT 制御
- **マルチデバイス対応** — PC・タブレット・スマートフォン。Chrome・Edge・Safari
- **オフライン対応 PWA** — ホーム画面に追加、ネットワーク不要で動作
- **WAV 解析** — FT8 WAV ファイルをドラッグ＆ドロップでオフラインデコード

## クイックスタート

1. **[WebFT8 を開く](https://jl1nie.github.io/webft8/)**
2. マイクのアクセスを許可
3. 設定（歯車アイコン）でコールサインとグリッドを入力
4. 音声入出力を選択 → **Start Audio**
5. USB または BLE で無線機を接続して CAT 制御（任意）

**オフライン試用:** [テスト WAV](https://github.com/jl1nie/webft8/raw/main/ft8-bench/testdata/sim_busy_band.wav) をウォーターフォールにドラッグ＆ドロップ。

## 2 つのモード

| モード | 用途 | ユースケース |
|--------|------|-------------|
| **Scout** | チャット風 UI、タップで呼び出し | カジュアル CQ・ポータブル・移動運用 |
| **Snipe** | DX ハンティング、ターゲットロック | DXペディション・パイルアップ・弱信号 |

## スナイパーモード — 差別化ポイント

WSJT-X / JTDX などの標準 FT8 アプリは 3 kHz 帯域全体をデコードする。+40 dB の強信号が存在すると、16 bit ADC のダイナミックレンジが強信号に占有され、弱信号は量子化ノイズに埋もれてしまう。

WebFT8 のスナイパーモードは、トランシーバの **500 Hz ハードウェアナローフィルタ** で強い混信を ADC の**前段**で物理的に除去し、さらに以下を適用する：

1. **適応型イコライザ** — Costas パイロットトーンで BPF エッジ歪みを補正
2. **逐次干渉キャンセル（SIC）** — QSB ゲート付き 3 パス減算
3. **事前情報デコード（AP）** — 既知コールサインのビットをロック（最大 77 bit フルロック）

| Snipe | AP | 動作 |
|-------|-----|------|
| OFF | OFF | 全帯域減算 |
| OFF | ON | 全帯域 + AP |
| ON | OFF | ±250 Hz + EQ |
| ON | ON | ±250 Hz + EQ + AP |

## WSJT-X との比較

| 項目 | WSJT-X | WebFT8 |
|------|--------|--------|
| プラットフォーム | デスクトップ（Java/Fortran） | **ブラウザ（Rust/WASM）** |
| BPF 統合 | なし | **500 Hz スナイパーモード** |
| イコライザ | なし | **Costas Wiener 適応型 EQ** |
| 並列処理 | シリアル | **Rayon par_iter（7.7 倍）** |
| 減算デコード | 4 パス | **3 パス + QSB ゲート** |
| バイナリサイズ | 約 120 MB | **572 KB（フル PWA）** |

### デコード比較（合成シミュレーション、各 20 seed）

| シナリオ | WSJT-X | WebFT8 |
|----------|--------|--------|
| 混信 +5 dB、ターゲット −12 dB | 7 局 | **16 局** |
| 混信 +40 dB、ターゲット −14 dB（54 dB ギャップ） | 0% | **500 Hz HW BPF で 100%** |
| BPF エッジ −18 dB（EQ のみ） | — | **45%** |
| BPF エッジ −18 dB（EQ + AP） | — | **100%** |
| BPF 内混信 +8 dB、ターゲット −12 dB（SIC+AP） | — | **100%** |
| BPF 内混信 +8 dB、ターゲット −14 dB（SIC+AP） | — | **65%** |

全シナリオの詳細ベンチマーク（SNR スイープ・速度計測）: **[docs/bench.md](docs/bench.md)**

## 開発者向け

```
webft8/
├── ft8-core/      Pure Rust FT8 デコーダ/エンコーダライブラリ
├── ft8-bench/     ベンチマーク＆シミュレーションスイート
├── ft8-web/       WASM バインディング + PWA フロントエンド
├── ft8-desktop/   Tauri ネイティブラッパー
└── docs/          GitHub Pages デプロイ
```

### ビルド

```bash
# ネイティブ
cargo build --release
cargo run -p ft8-bench --release    # ベンチマーク＋シミュレーション

# WASM
cd ft8-web && wasm-pack build --target web --release
```

ユニットテスト 63 件。WASM バイナリ 413 KB。

## 参考文献

- [WSJT-X](https://github.com/saitohirga/WSJT-X) — FT8 リファレンス実装
- K1JT et al., "The FT4 and FT8 Communication Protocols", QEX, 2020

## ライセンス

GPL-3.0-or-later — WSJT-X から移植したアルゴリズムを含む。

# WebFT8 — ブラウザで動く FT8 / FT4

**[English version](README.en.md)** | **[アプリを開く](https://jl1nie.github.io/webft8/)** | **[マニュアル](docs/manual.md)** | **[ライブラリリファレンス](docs/LIBRARY.ja.md)**

> Pure Rust FT8 デコーダを WASM PWA として実装。
> インストール不要、Java 不要 — 開いてすぐ運用。

## 特徴

- **FT8 QSO 完結** — デコード、エンコード、オートシーケンス（IDLE → CALLING → REPORT → FINAL）
- **スナイパーモード** — 500 Hz ハードウェア BPF + 適応型イコライザで極限の微弱信号 DX
- **パイプラインデコード** — Phase 1 の結果を即座に表示、Phase 2 で減算信号を追加
- **CAT 制御** — Yaesu / Icom PTT（Web Serial API / Bluetooth LE）
- **どこでも動く** — PC、タブレット、スマートフォン。Chrome、Edge、Safari 対応
- **オフライン対応 PWA** — ホーム画面にインストール可能
- **WAV 解析** — FT8 WAV をドラッグ＆ドロップでオフラインデコード

## クイックスタート

1. **[WebFT8 を開く](https://jl1nie.github.io/webft8/)**
2. マイクへのアクセスを許可
3. 設定（歯車アイコン）でコールサインとグリッドを入力
4. オーディオ入出力を選択 → **Start Audio**
5. USB または BLE でリグを接続（CAT 制御、任意）

**オフライン試用:** [テスト WAV](https://github.com/jl1nie/webft8/raw/main/ft8-bench/testdata/sim_busy_band.wav) をウォーターフォールにドロップ。

## 2 つのモード

| モード | 用途 | ユースケース |
|--------|------|-------------|
| **Scout** | チャット風 UI、タップでコール | カジュアル CQ、移動運用 |
| **Snipe** | DX ハンティング、ターゲットロック | DX ペディション、微弱信号 |

## スナイパーモード — WebFT8 の差別化

汎用 FT8 アプリ（WSJT-X、JTDX）は 3 kHz 帯域全体をデコードする。+40 dB の強力局が存在すると、16 bit ADC のダイナミックレンジが奪われ、微弱なターゲット信号は量子化ノイズに埋もれる。

WebFT8 のスナイパーモードは、トランシーバの **500 Hz ハードウェアナローフィルタ** で ADC の前段で強信号を物理的に除去し、さらに：

1. **適応型イコライザ** — Costas パイロットトーンで BPF エッジの振幅/位相歪みを補正
2. **逐次干渉キャンセル** — 3 パス減算 + QSB ゲート
3. **A Priori デコード** — 既知コールサインのビットをロック（最大 77 bit フルロック）

## vs WSJT-X

| 機能 | WSJT-X | WebFT8 |
|------|--------|--------|
| プラットフォーム | デスクトップ (Java/Fortran) | **ブラウザ (Rust/WASM)** |
| BPF 統合 | なし | **500 Hz スナイパーモード** |
| イコライザ | なし | **Costas Wiener 適応型 EQ** |
| 並列処理 | 逐次 | **Rayon par_iter (7.7 倍)** |
| 減算 | 4 パス | **3 パス + QSB ゲート** |
| バイナリサイズ | ~120 MB | **572 KB（PWA 全体）** |

### デコード比較（15 クラウド局 + 弱ターゲット）

| シナリオ | WSJT-X | WebFT8 |
|----------|--------|--------|
| クラウド +5 dB、ターゲット -12 dB | 7 局 | **16 局** |
| クラウド +20 dB、ターゲット -18 dB | 11 (3Y0Z: AP) | **15** |
| ターゲット -18 dB、BPF エッジ | 1 (AP) | **1 (sniper+EQ+AP)** |

## 開発者向け

**[ライブラリリファレンス (日本語)](docs/LIBRARY.ja.md)** — Rust Generic を使ったモジュール設計から C ABI・Kotlin JNI・WASM まで、組み込み利用者向けの詳細ドキュメント。

```
rs-ft8n/
├── mfsk-core/     プロトコル汎用 trait + 共通 DSP / sync / LLR / pipeline
├── mfsk-fec/      LDPC(174,91) コーデック
├── mfsk-msg/      WSJT 77-bit メッセージ codec + AP hints
├── ft8-core/      FT8 固有ロジック + 後方互換 API
├── ft4-core/      FT4 実装
├── ft8-bench/     ベンチマーク＆シミュレーションスイート
├── ft8-web/       WASM バインディング + PWA フロントエンド
├── wsjt-ffi/      C ABI cdylib (C++/Kotlin/Android 向け)
├── ft8-desktop/   Tauri ネイティブラッパー
└── docs/          GitHub Pages + ライブラリドキュメント
```

### ビルド

```bash
# ネイティブ
cargo build --release
cargo run -p ft8-bench --release    # ベンチマーク + シミュレーション

# WASM
cd ft8-web && wasm-pack build --target web --release
```

63 ユニットテスト。WASM バイナリ 413 KB。

## 参考文献

- [WSJT-X](https://github.com/saitohirga/WSJT-X) — FT8 リファレンス実装
- K1JT et al., "The FT4 and FT8 Communication Protocols", QEX, 2020

## ライセンス

GPL-3.0-or-later — WSJT-X からのポートアルゴリズムを含む。

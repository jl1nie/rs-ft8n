# CLAUDE.md - Project `rs-ft8n`

## 1. プロジェクト・ビジョン
**`rs-ft8n`** は、アマチュア無線のデジタルモード **FT8** において、無線機の **500Hz 物理ナローフィルタ** とソフトウェアデコーダを密結合させる「スナイパー・モード」を実現する次世代 Rust デコーダである。

汎用機である WSJT-X/JTDX が 3kHz 帯域全体を等しく扱うのに対し、本プロジェクトは「特定のターゲット局を 500Hz の聖域に追い込み、計算資源とハードウェア性能を一点突破させる」ことを目的とする。

## 2. コア・コンセプト：なぜ「Sniper」なのか？

### 2.1. 16bit 量子化の壁の突破
強大な隣接 QRM（+40dB以上）が存在する広帯域環境では、ADC のゲインが強信号に引きずられ、微弱なターゲット信号（-20dB以下）は 16bit 量子化の最下位ビット付近に沈み、情報が消失する。
* **物理フィルタの介入:** 量子化の**前段**で 500Hz フィルタを適用し、強信号を物理的に遮断する。
* **分解能の回復:** ターゲット信号が ADC のダイナミックレンジをフルに活用できる状態を作り出し、理論上の $SNR$ 限界を実戦で引き出す。

### 2.2. 適応型等価器 (Adaptive Equalizer)
急峻な 500Hz フィルタの「肩（エッジ）」では振幅の傾斜や位相の回転（群遅延）が生じるが、FT8 の既知信号（Costas Array）をパイロット信号として利用し、デジタル領域で伝達関数の逆特性 $H^{-1}(f)$ を適用して補正する。

## 3. 技術的深度と実装仕様

### 3.1. 変調方式と耐干渉性：8-GFSK
* **変調:** 8値ガウス周波数偏移変調（8-GFSK）。
* **シンボル長:** $160 \text{ ms}$（$6.25 \text{ baud}$）。
* **特性:** ガウシアンフィルタによる滑らかな遷移により、シンボル間干渉（ISI）を自己抑制している。
* **設計判断:** $160 \text{ ms}$ という巨大な時間軸に対し、数 $\text{ ms}$ 程度の群遅延歪みは復調に致命的ではないが、エッジでの $SNR$ 最大化のために振幅補正を優先する。

### 3.2. 同期（Sync）の極限化
本家（4分割スキャン）を超える精度を追求する。
* **Time Sync:** 1シンボルを 16 分割（$10 \text{ ms}$ ステップ）以上でスライディング FFT。
* **Freq Sync:** $6.25 \text{ Hz}$ ビン間を放物線補完し、$0.1 \text{ Hz}$ 単位の $DF$ を特定。
* **Double Sync:** 開始・終了の Costas Array（72シンボル離隔）の相関をペアで評価し、偽ピークを排除する。

### 3.3. マルチサンプルレート対応
* **内部処理:** デコードパイプライン全体は 12 000 Hz を前提とする。
* **入力レート自由:** `ft8-core` の `resample` モジュールが任意のサンプルレート（44100, 48000 Hz 等）を 12 000 Hz に線形補間リサンプルする。WASM エントリポイント (`decode_wav`, `decode_sniper`, `decode_wav_subtract`) は `sample_rate: u32` を受け取り、12 000 Hz 以外の場合は自動でリサンプル後にデコードする。
* **ブラウザ側:** `AudioContext({ sampleRate: 12000 })` によりブラウザがネイティブレートから 12 kHz へのリサンプルを行うため、AudioWorklet での間引きは不要。

### 3.4. WASM エコシステムへの展開
* **計算基盤:** `rustfft`（WASM SIMD 128-bit 対応）を使用。
* **ポータビリティ:** ブラウザ上の `Web Audio API` (AudioWorklet) で動作。
* **最適化:** 500Hz に限定することで、ブラウザ環境でも本家以上の LDPC 反復回数を実行可能な計算負荷に抑える。

## 4. 開発フェーズと検証戦略

### Phase 1: `rs-ft8n-sim`（真実の瞬間）
「物理フィルタなし（3kHz/16bit）」vs「物理フィルタあり（500Hz/16bit）」のデコード成功率を、自作の強信号混入シミュレータで数値化する。WSJT-X がデコードに失敗する過酷な環境（強信号 +40dB 差など）を再現し、本プロジェクトの存在意義を証明する。

### Phase 2: `ft8-core` (Pure Rust Implementation)
* 本家 Fortran コード (`sync8.f90`, `decode8.f90`) のロジックを解析し、Rust でリインプリメント。
* 浮動小数点演算を維持したまま、ターゲットに特化した LLR (Log-Likelihood Ratio) 算出を最適化。

### Phase 3: `rs-ft8n-web` (Browser Interface)
* `wasm-pack` による WASM 化。
* リグの CAT 制御と連動し、500Hz フィルタのオンオフとデコードを同期させる UX の実現。

## 5. 主要な依存関係と技術スタック
* ** WSJT-X ** https://github.com/saitohirga/WSJT-X
* **Language:** Rust (Native & WASM)
* **FFT:** `rustfft` (Portable, SIMD supported)
* **I/O:** `hound` (WAV), `wasm-bindgen` (JS bridge)
* **Analysis:** Parabolic Interpolation, Costas Array Correlation, Soft-decision LDPC

---
**Engineering Ethos:**
"Don't just decode; hunt the signal. Let the hardware shield the ADC, and let Rust polish the bits."
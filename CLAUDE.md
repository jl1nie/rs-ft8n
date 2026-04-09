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

### 3.3. サンプルレート設計
* **内部処理:** デコードパイプライン全体は 12 000 Hz を前提とする。
* **オフライン (WAV ファイル):** `ft8-core` の `resample` モジュールが任意のサンプルレート（44100, 48000 Hz 等）を 12 000 Hz に線形補間リサンプルする。WASM エントリポイント (`decode_wav`, `decode_sniper`, `decode_wav_subtract`) は `sample_rate: u32` を受け取り、12 000 Hz 以外の場合は自動でリサンプル後にデコードする。
* **ライブ取り込み:** `AudioContext({ sampleRate: 12000 })` で **AudioContext を 12 kHz に強制**。Chrome がオフライン polyphase resampler でデバイスネイティブレート (典型 48 kHz) → 12 kHz に変換した後、ワークレットに渡す。Chrome のリサンプラはソース側のクロックジッタも吸収してくれる。経験的に **これが最も安定**で、AudioContext のネイティブレートで開いたり、ワークレット側でデシメートしたりする方向は逆効果だった。
* **ワークレット内 waterfall デシメート:** snapshot バッファは 12 kHz 生サンプルそのままだが、waterfall 経路はワークレット内でボックスカー 2:1 デシメート (12 kHz → 6 kHz) を通す。FT8 の表示帯域 100–3000 Hz は Nyquist 上 6 kHz で十分で、`Waterfall` は `fftSize=1024 / sampleRate=6000` で bin 幅 5.86 Hz（12 k/2048 と完全同一）を維持しつつ、メインスレッドの JS FFT 負荷を半分に下げる。

### 3.3.1. ウォーターフォール表示の解釈

`fftSize=2048` (または等価な `1024@6kHz`) は **積分窓 ~170 ms ≈ FT8 1 シンボル長 (160 ms)** に相当する。1 つの FT8 信号は per-symbol で異なるトーン (8 つのうちの 1 つ) を出すので、ウォーターフォール上では各シンボルでのトーン跳び移りが視覚化されて、信号は **滑らかに波打って動く 50 Hz 幅の帯**として見える。これは正常動作。

WSJT-X は **32768-point FFT (~2.7 秒 = ~17 シンボル平均)** を使うので、シンボル毎のトーン跳びが平均化されて **均一な 50 Hz 幅縦帯**に見える。per-symbol 構造を視覚的に隠している。

両者の違いは表示の積分窓長だけで、デコード品質には無関係。シミュレータが純粋にソフトウェア生成した FT8 WAV (`ft8-bench/testdata/sim_busy_band.wav`) を rs-ft8n の WAV ドロップで読み込んでも同じ波打ちが見えることで、これが artifact ではなく正常動作であることを 2026-04-10 に検証済み。

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
# rs-ft8n — ライブラリアーキテクチャ & ABI リファレンス

> **English:** [LIBRARY.md](LIBRARY.md)

rs-ft8n を組み込む開発者向けリファレンス。Rust クレートとして使う場合、
C/C++ から `libwsjt.so` をリンクする場合、Kotlin/Android で JNI 雛形を
使う場合すべて対象。

## 1. クレート構成

```
mfsk-core  ──┐
             │
mfsk-fec    ─┼─┐
             │ │
mfsk-msg    ─┼─┼─┬── ft8-core ──┐
             │ │ │               │
             │ │ └── ft4-core ──┼── ft8-web (WASM)
             │ │                 │
             │ │                 └── wsjt-ffi (C ABI cdylib)
             │ │                          │
             │ │                          └── examples/{cpp_smoke, kotlin_jni}
             │ └── (将来) rs codec, conv codec…
             └── (将来) 他プロトコル用の sync / llr / tx
```

| クレート     | 役割                                                                  |
|--------------|-----------------------------------------------------------------------|
| `mfsk-core`  | Protocol trait 群、DSP (resample / downsample / subtract / GFSK)、sync、LLR、equalize、pipeline |
| `mfsk-fec`   | LDPC(174, 91) の `FecCodec` 実装                                       |
| `mfsk-msg`   | WSJT 77-bit メッセージコーデック + AP hints + AP 対応パイプライン      |
| `ft8-core`   | `Ft8` ZST + FT8 専用デコード orchestration (AP / sniper / SIC)        |
| `ft4-core`   | `Ft4` ZST + FT4 専用 entry points                                     |
| `ft8-web`    | `wasm-bindgen` 層 — FT8 と FT4 を PWA 向けに公開                      |
| `wsjt-ffi`   | C ABI cdylib + cbindgen 生成 `include/wsjt.h`                         |

全クレート `[package.edition = "2024"]`。`mfsk-core` は原則 `no_std` 対応
可能 (rayon は `parallel` feature の裏にオプション)。

## 2. Protocol トレイト階層

対応するすべてのモードは、3 つの合成可能な trait を実装する
**Zero-Sized Type (ZST)** で記述される:

```rust
pub trait ModulationParams: Copy + Default + 'static {
    const NTONES: u32;
    const BITS_PER_SYMBOL: u32;
    const NSPS: u32;              // samples/symbol @ 12 kHz
    const SYMBOL_DT: f32;
    const TONE_SPACING_HZ: f32;
    const GRAY_MAP: &'static [u8];
    const GFSK_BT: f32;
    const GFSK_HMOD: f32;
    const NFFT_PER_SYMBOL_FACTOR: u32;
    const NSTEP_PER_SYMBOL: u32;
    const NDOWN: u32;
    const LLR_SCALE: f32 = 2.83;
}

pub trait FrameLayout: Copy + Default + 'static {
    const N_DATA: u32;
    const N_SYNC: u32;
    const N_SYMBOLS: u32;
    const N_RAMP: u32;
    const SYNC_BLOCKS: &'static [SyncBlock];
    const T_SLOT_S: f32;
    const TX_START_OFFSET_S: f32;
}

pub trait Protocol: ModulationParams + FrameLayout + 'static {
    type Fec: FecCodec;
    type Msg: MessageCodec;
    const ID: ProtocolId;
}
```

### Monomorphization とゼロコスト抽象

ホットパス (`sync::coarse_sync<P>`、`llr::compute_llr<P>`、
`pipeline::process_candidate_basic<P>`、…) はすべて `P: Protocol` を
**コンパイル時型パラメータ**として受け取る。rustc が具象プロトコルごとに
1 コピーずつ monomorphize し、LLVM は完全特殊化された関数として
trait 定数を即値にインライン化する。抽象化のコストはゼロ — 生成される
FT8 コードは本ライブラリが fork する前の FT8 専用ハンドコードと
バイト単位で同一で、FT4 は共通関数に加えたマイクロ最適化すべての
恩恵を自動的に受ける。

`dyn Trait` はコールドパス専用: FFI 境界、JS 側のプロトコル切替、
デコード後 1 回のみ実行される `MessageCodec::unpack` など。

### 新プロトコルの追加

FST4 / FT2 / 任意の LDPC 系モードを追加する手順:

1. `your-core/` クレートと `YourMode` ZST を作成
2. 3 つの trait を実装。`SYNC_BLOCKS` にプロトコルの Costas 配置、
   数値定数を埋める
3. FT8/FT4 と同じ LDPC ならば `type Fec = Ldpc174_91;`、別系なら
   `mfsk-fec` に新しい `FecCodec` 実装を追加してポイント
4. FT8/FT4/FT2/FST4 は 77-bit メッセージなので `type Msg = Wsjt77Message;`

デコード / エンコード machinery は汎用化済みなので、DSP コードを
書かずにパイプラインが動く。JT65 / JT9 / WSPR は新しい `FecCodec`
(Reed-Solomon または convolutional) と新しい `MessageCodec`
(72-bit / 50-bit) を提供するだけ。

## 3. 共有プリミティブ (`mfsk-core`)

### DSP (`mfsk_core::dsp`)

| モジュール      | 役割                                                        |
|-----------------|-------------------------------------------------------------|
| `resample`      | 12 kHz への線形リサンプラ                                   |
| `downsample`    | FFT ベース複素デシメーション (`DownsampleCfg`)              |
| `gfsk`          | GFSK トーン→PCM 波形合成 (`GfskCfg`)                        |
| `subtract`      | 位相連続最小二乗 SIC (`SubtractCfg`)                        |

いずれもランタイム `*Cfg` 構造体を引数に取る (`<P>` ではない) のは、
FFT サイズなどチューニングが trait 定数だけから単純派生できない
ためで、プロトコルクレートが `const *_CFG` を公開している:
`ft8-core::downsample::FT8_CFG`、`ft4-core::decode::FT4_DOWNSAMPLE` など。

### Sync (`mfsk_core::sync`)

* `coarse_sync::<P>(audio, freq_min, freq_max, …)` — UTC 整列 2D
  ピーク探索、`P::SYNC_BLOCKS` を走査
* `refine_candidate::<P>(cd0, cand, search_steps)` — 整数サンプル
  スキャン + 放物線サブサンプル補間
* `make_costas_ref(pattern, ds_spb)` / `score_costas_block(...)` —
  診断・カスタムパイプライン用の生相関ヘルパー

### LLR (`mfsk_core::llr`)

* `symbol_spectra::<P>(cd0, i_start)` — シンボル単位 FFT bin
* `compute_llr::<P>(cs)` — WSJT 式 4 バリアント LLR (a/b/c/d)
* `sync_quality::<P>(cs)` — 硬判定 sync シンボル一致数

### Equalise (`mfsk_core::equalize`)

* `equalize_local::<P>(cs)` — `P::SYNC_BLOCKS` pilot 観測から
  トーン毎 Wiener equalizer を推定、Costas が訪問しないトーンは
  線形外挿でカバー

### Pipeline (`mfsk_core::pipeline`)

* `decode_frame::<P>(...)` — coarse sync → 並列 process_candidate → dedupe
* `decode_frame_subtract::<P>(...)` — 3-pass SIC ドライバ
* `process_candidate_basic::<P>(...)` — 候補単体の BP+OSD

AP 対応版は `mfsk_msg::pipeline_ap` に配置 (AP hint 構築が
77-bit 形式に依存するため)。

## 4. Feature flags

| クレート   | フィーチャー   | デフォルト | 効果                                                         |
|------------|----------------|------------|--------------------------------------------------------------|
| `mfsk-core`| `parallel`     | on         | パイプラインで rayon `par_iter` (WASM は無効化)              |
| `mfsk-msg` | `osd-deep`     | off        | AP ≥55 bit ロック時に OSD-3 フォールバック追加              |
| `mfsk-msg` | `eq-fallback`  | off        | `EqMode::Adaptive` が EQ 失敗時に非 EQ にフォールバック      |
| `ft8-core` | `parallel`     | on         | 同上、利便のため再エクスポート                              |

`osd-deep` + `eq-fallback` は重い: FT4 −18 dB 成功率を 5/10 → 6/10 に
引き上げる代償としてデコード時間が約 10× 増える。WASM の 7.5 s スロット
予算内に収まるよう **既定 off**、CPU 余裕のあるデスクトップでのみ
有効化する想定。

## 5. Rust から利用する

```toml
[dependencies]
ft4-core = { path = "../rs-ft8n/ft4-core" }
mfsk-msg = { path = "../rs-ft8n/mfsk-msg" }
```

```rust
use ft4_core::decode::{decode_frame, decode_sniper_ap, ApHint};
use mfsk_core::equalize::EqMode;

let audio: Vec<i16> = /* 12 kHz PCM, 7.5 s */;

// 全帯域デコード
for r in decode_frame(&audio, 300.0, 2700.0, 1.2, 50) {
    println!("{:4.0} Hz  {:+.2} s  SNR {:+.0} dB", r.freq_hz, r.dt_sec, r.snr_db);
}

// 狭帯域 sniper + AP hint
let ap = ApHint::new().with_call1("CQ").with_call2("JA1ABC");
for r in decode_sniper_ap(&audio, 1000.0, 15, EqMode::Adaptive, Some(&ap)) {
    // …
}
```

## 6. C / C++ — `wsjt-ffi`

### 生成物

`cargo build -p wsjt-ffi --release` で:

* `target/release/libwsjt.so`  (Linux / Android 共有オブジェクト)
* `target/release/libwsjt.a`   (static、組み込み向け)
* `wsjt-ffi/include/wsjt.h`    (cbindgen 生成、コミット済)

### API

正確な宣言は `wsjt-ffi/include/wsjt.h` 参照。サマリ:

```c
enum WsjtProtocol { WSJT_PROTOCOL_FT8 = 0, WSJT_PROTOCOL_FT4 = 1 };

uint32_t          wsjt_version(void);            // major<<16 | minor<<8 | patch
WsjtDecoder*      wsjt_decoder_new(WsjtProtocol protocol);
void              wsjt_decoder_free(WsjtDecoder* dec);

WsjtStatus        wsjt_decode_i16(WsjtDecoder*, const int16_t* samples,
                                  size_t n, uint32_t sample_rate,
                                  WsjtMessageList* out);
WsjtStatus        wsjt_decode_f32(WsjtDecoder*, const float*,  size_t,
                                  uint32_t, WsjtMessageList* out);

void              wsjt_message_list_free(WsjtMessageList* list);
const char*       wsjt_last_error(void);
```

`WsjtMessageList` は呼び出し元が確保するストレージで、デコードが
中身を埋める。text フィールドは UTF-8 NUL 終端 `char*`、list が所有し
`wsjt_message_list_free` で解放される。

最小 E2E デモは `wsjt-ffi/examples/cpp_smoke/` 参照。

### メモリルール

1. **ハンドル**: `wsjt_decoder_new` で確保、`wsjt_decoder_free` で解放。
   スレッドあたり 1 ハンドル。NULL に対する free は no-op。
2. **メッセージリスト**: `WsjtMessageList` をスタック上でゼロ初期化、
   そのアドレスを decode に渡し、読み終わったら
   `wsjt_message_list_free` で解放。個別 `text` ポインタを手動で
   free してはいけない。
3. **エラー**: `WsjtStatus` が非ゼロの場合、**同じスレッド** で
   `wsjt_last_error` を呼ぶと診断メッセージが得られる。返される
   ポインタは次の fallible 呼び出しまで有効。

### スレッド安全性

* `WsjtDecoder` は `!Sync`: 並行スレッドごとに 1 ハンドル
* デコーダはキャッシュとエラー報告にスレッドローカルを使うので、
  複数スレッドそれぞれが自分のハンドルを持つコストは小さい

## 7. Kotlin / Android

`wsjt-ffi/examples/kotlin_jni/` にそのまま使える雛形:

```kotlin
package io.github.rsft8n

Wsjt.open(Wsjt.Protocol.FT4).use { dec ->
    val pcm: ShortArray = /* 取得した音声 */
    for (m in dec.decode(pcm, sampleRate = 12_000)) {
        Log.i("ft4", "${m.freqHz} Hz  ${m.snrDb} dB  ${m.text}")
    }
}
```

* `libwsjt.so` は `cargo build --target aarch64-linux-android` で生成
* `libwsjt_jni.so` は約 115 行の C shim、`ShortArray` ↔
  `WsjtMessageList` を変換
* `Wsjt.kt` は `AutoCloseable` な Kotlin クラス。`.use { }` で確実
  に解放

詳細は `wsjt-ffi/examples/kotlin_jni/README.md` 参照。

## 8. WASM / JS — `ft8-web`

```ts
import init, {
    decode_wav,         // FT8
    decode_ft4_wav,     // FT4
    decode_sniper,
    decode_ft4_sniper,
} from './ft8_web.js';

await init();
const messages = decode_wav(int16Samples, /* strictness */ 1, /* sampleRate */ 48_000);
```

`docs/` の PWA が E2E の例。FT8 ではスレッドローカル FFT キャッシュを
共有する Phase 1 / Phase 2 パイプライン (`decode_phase1` +
`decode_phase2`) も利用。

## 9. プロトコル対応状況

| プロトコル | スロット | トーン | シンボル | トーン Δf  | FEC          | Msg   | 状態     |
|------------|----------|--------|----------|------------|--------------|-------|----------|
| FT8        | 15 s     | 8      | 79       | 6.25 Hz    | LDPC(174,91) | 77 b  | 出荷済 |
| FT4        | 7.5 s    | 4      | 103      | 20.833 Hz  | LDPC(174,91) | 77 b  | 出荷済 |
| FT2        | ~4.5 s   | 4      | ~100     | 83 Hz      | LDPC(174,91) | 77 b  | TODO     |
| FST4       | 可変     | 4      | 可変     | 可変       | LDPC(174,91) | 77 b  | TODO     |
| JT65       | 60 s     | 65     | 126      | ~2.7 Hz    | RS(63,12)    | 72 b  | TODO     |
| JT9        | 60 s     | 9      | 85       | 1.736 Hz   | conv + Fano  | 72 b  | TODO     |
| WSPR       | 110 s    | 4      | 162      | 1.465 Hz   | conv + Fano  | 50 b  | TODO     |

## 10. 関連ドキュメント

* `CLAUDE.md` — プロジェクトビジョン、sniper mode 設計思想
* `README.md` / `README.en.md` — PWA エンドユーザ向けガイド
* `wsjt-ffi/examples/cpp_smoke/` — 最小 C++ デモ
* `wsjt-ffi/examples/kotlin_jni/` — Kotlin ラッパー + JNI shim

## ライセンス

ライブラリコードは GPL-3.0-or-later。WSJT-X のリファレンス
アルゴリズム由来。

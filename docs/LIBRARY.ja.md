# rs-ft8n — ライブラリアーキテクチャ & ABI リファレンス

> **English:** [LIBRARY.md](LIBRARY.md)

rs-ft8n を組み込む開発者向けリファレンス。Rust クレートとして使う場合、
C/C++ から `libwsjt.so` をリンクする場合、Kotlin/Android で JNI 雛形を
使う場合すべて対象。

## 0. なぜこの構成か

WSJT-X は FT8 / FT4 / FST4 / WSPR 系のリファレンス実装だが、20 年以上
蓄積された C++ + Fortran のデスクトップバイナリで、ブラウザ PWA や
Android アプリ、他アプリへの埋め込みライブラリとして動かすには
プラットフォームごとに相当量の書き直しが必要になる。そして
書き直すたびに本家から乖離していく。

**rs-ft8n はデコードパイプラインをゼロコスト抽象の trait 階層で再構成
することでこの問題を解く。** アルゴリズム (DSP、sync 相関、LLR、
equalizer、LDPC BP/OSD、convolutional + Fano) はすべて共通クレート
(`mfsk-core`、`mfsk-fec`、`mfsk-msg`) に集約され、各プロトコルは
固有定数と採用する FEC / メッセージコーデックを宣言する
~100–300 行の ZST (Zero-Sized Type) だけで済む。あとは
`decode_frame::<P>()` で統一パイプラインが走る。`P` はコンパイル時
型パラメータなので、monomorphize 後のコードは手書き専用デコーダと
バイト単位で同一 — 抽象化のコストはゼロ。

### この構成から得られるもの

| メリット                            | 具体例                                                                                 |
|-------------------------------------|----------------------------------------------------------------------------------------|
| **1 コードベース → 4 プラットフォーム** | 同じクレートが Native Rust / WASM (PWA) / Android ARM64 (JNI) / C・C++ (cbindgen) に対応 |
| **最適化が全プロトコルに波及**      | `mfsk-fec::ldpc::bp_decode` に SIMD 最適化を入れると FT8 / FT4 / FST4 が同時に速くなる   |
| **新プロトコル追加が安い**          | FT4 = FT8 スタック上 ~150 行、FST4-60A = ~90 行 + LDPC テーブル、WSPR は独自 FEC 系統でもパイプライン土台を再利用 |
| **クリーンな ABI 面**                | `wsjt-ffi` の C ABI は `match protocol_id` 1 段で分岐、特殊化コードは既に monomorphize 済み |
| **アルゴリズム正当性を単体でテスト** | 118 ワークスペーステストがコーデック / メッセージ / sync / LLR を統合前に検証 |

### 今デコード・エンコードできるもの

- **FT8** (15 s スロット、8-GFSK、LDPC(174, 91) + CRC-14、77-bit メッセージ)
- **FT4** (7.5 s スロット、4-GFSK、LDPC(174, 91) + CRC-14、77-bit メッセージ)
- **FST4-60A** (60 s スロット、4-GFSK、LDPC(240, 101) + CRC-24、77-bit メッセージ)
- **WSPR** (120 s スロット、4-FSK、convolutional r=1/2 K=32 + Fano、50-bit メッセージ)

JT65 (Reed–Solomon、72-bit) と JT9 (convolutional、72-bit) も同じ
抽象にきれいに収まる — 新しい `FecCodec` と `MessageCodec` を
1 つずつ追加するだけ。

### 抽象が名目ではなく実体を持つ証拠

WSPR はストレステスト。FT 系と違い WSPR は:

1. 異なる FEC 系統 (convolutional + Fano 逐次復号、LDPC ではない)
2. 異なるメッセージ長 (50 bit、77 bit ではない)
3. 異なる sync 構造 (シンボル毎の LSB に埋め込まれた sync vector、
   ブロック Costas ではない)

これらはそれぞれ trait 面の別の軸に圧力をかけた — `FecCodec` は
`ConvFano` を受け入れる必要があり、`MessageCodec::Unpacked` は
FT8 の `String` から WSPR の `WsprMessage` (enum) に一般化された、
`FrameLayout::SYNC_MODE` には `Interleaved` バリアントが追加された。
それでも FT8 / FT4 / FST4 のコード経路は**変更されていない** —
従来どおり `SyncMode::Block` を使い、従来と同じビットを出力する。
マルチクレート化は WSPR 実装時に回収された — 「FT8 専用前提を
剥がす」崖は存在しなかった。

## 1. クレート構成

```
mfsk-core  ──┐
             │
mfsk-fec    ─┼─┐    (LDPC 174/91、LDPC 240/101、ConvFano r=1/2 K=32)
             │ │
mfsk-msg    ─┼─┼─┬── ft8-core   ──┐
             │ │ │                 │
             │ │ ├── ft4-core   ──┤
             │ │ │                 ├── ft8-web (WASM / PWA)
             │ │ ├── fst4-core  ──┤
             │ │ │                 │
             │ │ └── wspr-core  ──┼── wsjt-ffi (C ABI cdylib)
             │ │                   │         │
             │ │                   │         └── examples/{cpp_smoke, kotlin_jni}
             │ └── (将来) rs codec (JT65)
             └── (将来) jt72 メッセージコーデック (JT9 / JT65)
```

| クレート      | 役割                                                                  |
|---------------|-----------------------------------------------------------------------|
| `mfsk-core`   | Protocol trait 群、DSP (resample / downsample / subtract / GFSK)、sync、LLR、equalize、pipeline |
| `mfsk-fec`    | `FecCodec` 実装: `Ldpc174_91`、`Ldpc240_101`、`ConvFano`               |
| `mfsk-msg`    | 77-bit (`Wsjt77Message`) + 50-bit (`Wspr50Message`) メッセージコーデック、AP hints |
| `ft8-core`    | `Ft8` ZST + FT8 専用デコード orchestration (AP / sniper / SIC)        |
| `ft4-core`    | `Ft4` ZST + FT4 専用 entry points                                     |
| `fst4-core`   | `Fst4s60` ZST — 60 s サブモード、LDPC(240, 101)                       |
| `wspr-core`   | `Wspr` ZST + WSPR TX 合成 / RX 復調 / spectrogram coarse search      |
| `ft8-web`     | `wasm-bindgen` 層 — FT8 / FT4 / WSPR を PWA 向けに公開                |
| `wsjt-ffi`    | C ABI cdylib + cbindgen 生成 `include/wsjt.h`                         |

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
    const SYNC_MODE: SyncMode;  // Block(&[SyncBlock]) または Interleaved { .. }
    const T_SLOT_S: f32;
    const TX_START_OFFSET_S: f32;
}

pub enum SyncMode {
    /// ブロック型 Costas / pilot 配列が固定シンボル位置に置かれる。
    /// FT8 / FT4 / FST4 が利用。
    Block(&'static [SyncBlock]),
    /// シンボル毎ビット埋込型: 既知の sync vector の 1 ビットが
    /// 各チャネルシンボルのトーン index の `sync_bit_pos` に埋め込まれる。
    /// WSPR が利用 (symbol = 2·data + sync_bit)。
    Interleaved {
        sync_bit_pos: u8,
        vector: &'static [u8],
    },
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

既存資産をどこまで共有できるかで 3 ティア:

1. **同じ FEC + 同じメッセージ (例: FT2 / FST4 の他サブモード)** —
   ZST を 1 つ、~20–100 行。数値定数 (`NTONES`、`NSPS`、
   `TONE_SPACING_HZ`、`SYNC_MODE`) だけ変える。`Fec` と `Msg` は
   既存実装へのエイリアス。`decode_frame::<P>()` パイプライン全体が
   そのまま動く。

2. **新 FEC、同じメッセージ (例: 別サイズ LDPC)** — `mfsk-fec` に
   コーデックモジュールを追加し `FecCodec` を実装。BP / OSD /
   systematic encode の*アルゴリズム*は LDPC サイズ間で自然に一般化する
   ので、変わるのはパリティ検査・生成行列と `N`/`K` 定数のみ。
   パターンは `mfsk_fec::ldpc240_101` を参照。

3. **新 FEC *かつ* 新メッセージ (例: WSPR)** — コーデック追加、
   `mfsk-msg` にメッセージコーデック追加、sync 構造が根本的に違えば
   `SyncMode` バリアントを追加。WSPR がたどった経路はまさにこれ:
   `ConvFano` + `Wspr50Message` + `SyncMode::Interleaved`。それでも
   パイプライン土台 — coarse search、spectrogram、候補重複除去、
   CRC / メッセージ unpack — は依然として使える。

JT65 (Reed–Solomon) と JT9 (convolutional 72-bit) はティア 3:
それぞれ新しい `FecCodec` と `MessageCodec` を 1 つずつ追加するだけ。
`SyncMode` trait は必要なバリアントを既に持っている。

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
  ピーク探索、`P::SYNC_MODE.blocks()` を走査
* `refine_candidate::<P>(cd0, cand, search_steps)` — 整数サンプル
  スキャン + 放物線サブサンプル補間
* `make_costas_ref(pattern, ds_spb)` / `score_costas_block(...)` —
  診断・カスタムパイプライン用の生相関ヘルパー

### LLR (`mfsk_core::llr`)

* `symbol_spectra::<P>(cd0, i_start)` — シンボル単位 FFT bin
* `compute_llr::<P>(cs)` — WSJT 式 4 バリアント LLR (a/b/c/d)
* `sync_quality::<P>(cs)` — 硬判定 sync シンボル一致数

### Equalise (`mfsk_core::equalize`)

* `equalize_local::<P>(cs)` — `P::SYNC_MODE.blocks()` pilot 観測から
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
    decode_wspr_wav,    // WSPR (120 s スロット、coarse search は内部で実施)
    decode_sniper,
    decode_ft4_sniper,
    encode_ft8,
    encode_ft4,
    encode_wspr,        // Type-1 WSPR: (callsign, grid, dBm, freq) → f32 PCM
} from './ft8_web.js';

await init();
const ft8Msgs  = decode_wav(int16Samples,      /* strictness */ 1, /* sampleRate */ 48_000);
const wsprMsgs = decode_wspr_wav(int16Samples, /* sampleRate */ 48_000);
```

`docs/` の PWA が E2E の例。FT8 はスレッドローカル FFT キャッシュを
共有する Phase 1 / Phase 2 パイプライン (`decode_phase1` +
`decode_phase2`)、Cog 内のプロトコルセレクタで FT8 (15 s) / FT4 (7.5 s) /
WSPR (120 s) のスロット切替にも対応。

## 9. プロトコル対応状況

| プロトコル       | スロット   | トーン | シンボル | トーン Δf  | FEC                   | Msg   | Sync          | 状態 |
|------------------|------------|--------|----------|------------|-----------------------|-------|---------------|------|
| FT8              | 15 s       | 8      | 79       | 6.25 Hz    | LDPC(174, 91)         | 77 b  | 3×Costas-7    | 出荷済 |
| FT4              | 7.5 s      | 4      | 103      | 20.833 Hz  | LDPC(174, 91)         | 77 b  | 4×Costas-4    | 出荷済 |
| FST4-60A         | 60 s       | 4      | 160      | 3.125 Hz   | LDPC(240, 101)        | 77 b  | 5×Costas-8    | 出荷済 |
| FST4 他サブモード | 15–1800 s  | 4      | 可変     | 可変       | LDPC(240, 101)        | 77 b  | 5×Costas-8    | ZST 1 つ/サブモード |
| WSPR             | 120 s      | 4      | 162      | 1.465 Hz   | conv r=½ K=32 + Fano  | 50 b  | シンボル毎 LSB (npr3) | 出荷済 |
| JT65             | 60 s       | 65     | 126      | ~2.7 Hz    | RS(63, 12)            | 72 b  | 擬似乱数      | TODO |
| JT9              | 60 s       | 9      | 85       | 1.736 Hz   | conv r=½ + Fano       | 72 b  | ブロック      | TODO |

FST4 は FT8 の LDPC(174, 91) を共有**しない** — LDPC(240, 101) +
24-bit CRC を `mfsk_fec::ldpc240_101` で実装。BP / OSD アルゴリズムは
LDPC サイズ間で構造的に同じ、変わるのはパリティ検査・生成行列と
符号寸法だけ。FST4-60A は E2E 出荷済。他サブモード (-15 / -30 /
-120 / -300 / -900 / -1800) は `NSPS` / `SYMBOL_DT` /
`TONE_SPACING_HZ` が違うだけで、各々 ~20 行の ZST で同じ FEC + sync +
DSP を再利用すれば済む。

WSPR は構造的に異なるメンバー: LDPC ではなく convolutional FEC
(`mfsk_fec::conv::ConvFano`、WSJT-X `lib/wsprd/fano.c` の移植)、
50-bit メッセージ (`mfsk_msg::wspr::Wspr50Message` で Type 1 / 2 / 3 対応)、
ブロック Costas ではなくシンボル毎 interleaved sync
(`SyncMode::Interleaved`)。`wspr-core` クレート自身が TX 合成・RX 復調・
1/4 シンボル spectrogram を持ち、120 s スロット全体の coarse search を
約 40× 高速化している。

## 10. 関連ドキュメント

* `CLAUDE.md` — プロジェクトビジョン、sniper mode 設計思想
* `README.md` / `README.en.md` — PWA エンドユーザ向けガイド
* `wsjt-ffi/examples/cpp_smoke/` — 最小 C++ デモ
* `wsjt-ffi/examples/kotlin_jni/` — Kotlin ラッパー + JNI shim

## ライセンス

ライブラリコードは GPL-3.0-or-later。WSJT-X のリファレンス
アルゴリズム由来。

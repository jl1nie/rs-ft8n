//! C ABI for the rs-ft8n decoder suite.
//!
//! # Overview
//!
//! Exposes FT8 / FT4 / WSPR / JT9 / JT65 decoders and synthesisers
//! behind a small opaque-handle C API that C++ and Kotlin consumers
//! (Android JNI via a thin shim) can link against. cbindgen generates
//! `include/wsjt.h` on every build; see `examples/cpp_smoke` for a
//! round-trip demo that exercises every protocol through the ABI.
//!
//! # Memory ownership
//!
//! - [`wsjt_decoder_new`] / [`wsjt_decoder_free`]: opaque handle pair.
//! - [`wsjt_decode_f32`] / [`wsjt_decode_i16`]: populate a caller-supplied
//!   zero-initialised [`WsjtMessageList`]. The callee owns the returned
//!   buffer until [`wsjt_message_list_free`] is invoked.
//! - [`wsjt_encode_*`]: populate a caller-supplied
//!   zero-initialised [`WsjtSamples`] with the synthesised f32 PCM.
//!   Free with [`wsjt_samples_free`].
//! - All strings are UTF-8, NUL-terminated, and owned by the
//!   [`WsjtMessageList`] they appear in.
//!
//! # Thread safety
//!
//! A [`WsjtDecoder`] handle is **not** `Sync`. Each thread should own
//! its own handle. Calls do not allocate thread-local state beyond the
//! `wsjt_last_error` slot (which uses `thread_local!`).

use std::ffi::{c_char, c_int, CStr, CString};
use std::os::raw::c_void;
use std::ptr;
use std::slice;

use ft4_core::decode as ft4;
use ft8_core::decode as ft8;

// ──────────────────────────────────────────────────────────────────────────
// Public C types
// ──────────────────────────────────────────────────────────────────────────

/// Opaque decoder handle. Construct with [`wsjt_decoder_new`], release
/// with [`wsjt_decoder_free`].
#[repr(C)]
pub struct WsjtDecoder {
    _priv: [u8; 0],
    _marker: core::marker::PhantomData<*mut ()>,
}

/// Protocol tag selecting which decoder / synth family this handle
/// (or encode call) drives.
#[repr(C)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum WsjtProtocol {
    Ft8 = 0,
    Ft4 = 1,
    Wspr = 2,
    Jt9 = 3,
    Jt65 = 4,
}

/// Status / error code returned by every fallible `wsjt_*` call.
///
/// Zero is success. Negative values indicate errors; use
/// [`wsjt_last_error`] for a human-readable description.
#[repr(C)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum WsjtStatus {
    Ok = 0,
    InvalidArg = -1,
    UnknownProtocol = -2,
    DecodeFailed = -3,
    Internal = -4,
}

/// One successfully decoded message.
#[repr(C)]
#[derive(Debug, Clone)]
pub struct WsjtMessage {
    /// Carrier (tone-0) frequency in Hz.
    pub freq_hz: f32,
    /// Time offset in seconds from the protocol's nominal frame start.
    pub dt_sec: f32,
    /// WSJT-X compatible SNR in dB (2500 Hz reference bandwidth).
    pub snr_db: f32,
    /// Hard-decision errors corrected by the FEC.
    pub hard_errors: u32,
    /// Decode pass identifier (matches the Rust `DecodeResult::pass`).
    pub pass: u8,
    /// UTF-8, NUL-terminated message text. Owned by the parent
    /// [`WsjtMessageList`]; do not free individually.
    pub text: *mut c_char,
}

/// List of decoded messages returned from a decode call. Caller should
/// zero-initialise before the call; callee fills `items` / `len`.
#[repr(C)]
#[derive(Debug)]
pub struct WsjtMessageList {
    /// Array of `len` `WsjtMessage` values.
    pub items: *mut WsjtMessage,
    /// Number of entries in `items`.
    pub len: usize,
    /// Internal: total allocation (reserved for future growth).
    pub _cap: usize,
}

/// A buffer of synthesised f32 PCM samples returned by `wsjt_encode_*`.
/// Caller should zero-initialise before the call and free with
/// [`wsjt_samples_free`] when done reading.
#[repr(C)]
#[derive(Debug)]
pub struct WsjtSamples {
    pub samples: *mut f32,
    pub len: usize,
    pub _cap: usize,
}

// ──────────────────────────────────────────────────────────────────────────
// Error handling (thread-local last message)
// ──────────────────────────────────────────────────────────────────────────

std::thread_local! {
    static LAST_ERROR: std::cell::RefCell<Option<CString>> = const { std::cell::RefCell::new(None) };
}

fn set_error(msg: impl Into<String>) {
    let s = msg.into();
    LAST_ERROR.with(|e| {
        *e.borrow_mut() = CString::new(s).ok();
    });
}

/// Returns a pointer to the thread-local last-error string, or NULL if
/// no error has been recorded on this thread. The pointer is valid until
/// the next fallible call on this thread.
#[unsafe(no_mangle)]
pub extern "C" fn wsjt_last_error() -> *const c_char {
    LAST_ERROR.with(|e| {
        e.borrow()
            .as_ref()
            .map(|s| s.as_ptr())
            .unwrap_or(ptr::null())
    })
}

// ──────────────────────────────────────────────────────────────────────────
// Handle lifecycle
// ──────────────────────────────────────────────────────────────────────────

struct DecoderInner {
    protocol: WsjtProtocol,
}

/// Construct a new decoder handle bound to `protocol`. Returns NULL on
/// failure (see [`wsjt_last_error`]).
#[unsafe(no_mangle)]
pub extern "C" fn wsjt_decoder_new(protocol: WsjtProtocol) -> *mut WsjtDecoder {
    let inner = Box::new(DecoderInner { protocol });
    Box::into_raw(inner) as *mut WsjtDecoder
}

/// Destroy a decoder handle previously returned by [`wsjt_decoder_new`].
/// Passing NULL is a no-op.
///
/// # Safety
///
/// `dec` must be a pointer previously returned by [`wsjt_decoder_new`],
/// or NULL. After this call the pointer is dangling.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_decoder_free(dec: *mut WsjtDecoder) {
    if !dec.is_null() {
        unsafe {
            drop(Box::from_raw(dec as *mut DecoderInner));
        }
    }
}

/// Free a [`WsjtMessageList`] populated by a decode call. Passing NULL
/// or an already-freed list is safe.
///
/// # Safety
///
/// `list` must point to a [`WsjtMessageList`] written by one of the
/// `wsjt_decode_*` functions, or be NULL. After this call, `items` is
/// NULL and `len` is 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_message_list_free(list: *mut WsjtMessageList) {
    if list.is_null() {
        return;
    }
    unsafe {
        let list = &mut *list;
        if list.items.is_null() {
            list.len = 0;
            list._cap = 0;
            return;
        }
        let slice = slice::from_raw_parts_mut(list.items, list.len);
        for msg in slice.iter_mut() {
            if !msg.text.is_null() {
                drop(CString::from_raw(msg.text));
                msg.text = ptr::null_mut();
            }
        }
        let vec = Vec::from_raw_parts(list.items, list.len, list._cap);
        drop(vec);
        list.items = ptr::null_mut();
        list.len = 0;
        list._cap = 0;
    }
}

/// Free a [`WsjtSamples`] buffer populated by a `wsjt_encode_*` call.
/// Passing NULL or an already-freed buffer is safe.
///
/// # Safety
///
/// `s` must point to a [`WsjtSamples`] written by one of the
/// `wsjt_encode_*` functions, or be NULL. After this call, `samples`
/// is NULL and `len` is 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_samples_free(s: *mut WsjtSamples) {
    if s.is_null() {
        return;
    }
    unsafe {
        let s = &mut *s;
        if !s.samples.is_null() {
            let _ = Vec::from_raw_parts(s.samples, s.len, s._cap);
        }
        s.samples = ptr::null_mut();
        s.len = 0;
        s._cap = 0;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Decode entry points
// ──────────────────────────────────────────────────────────────────────────

fn inner(dec: *const WsjtDecoder) -> Option<&'static DecoderInner> {
    unsafe { (dec as *const DecoderInner).as_ref() }
}

/// Shared message pusher for the 77-bit family (FT8, FT4).
fn push_wsjt77(
    r: &ft8::DecodeResult,
    ht: &mfsk_msg::CallsignHashTable,
    vec: &mut Vec<WsjtMessage>,
) {
    let text = mfsk_msg::wsjt77::unpack77_with_hash(&r.message77, ht).unwrap_or_default();
    vec.push(WsjtMessage {
        freq_hz: r.freq_hz,
        dt_sec: r.dt_sec,
        snr_db: r.snr_db,
        hard_errors: r.hard_errors,
        pass: r.pass,
        text: CString::new(text).unwrap_or_default().into_raw(),
    });
}

fn push_ft4(r: &ft4::DecodeResult, vec: &mut Vec<WsjtMessage>) {
    use mfsk_core::MessageCodec;
    let codec = mfsk_msg::Wsjt77Message::default();
    let ctx = mfsk_core::DecodeContext::default();
    let text = codec.unpack(&r.message77, &ctx).unwrap_or_default();
    vec.push(WsjtMessage {
        freq_hz: r.freq_hz,
        dt_sec: r.dt_sec,
        snr_db: r.snr_db,
        hard_errors: r.hard_errors,
        pass: r.pass,
        text: CString::new(text).unwrap_or_default().into_raw(),
    });
}

fn push_simple(
    freq_hz: f32,
    dt_sec: f32,
    text: String,
    vec: &mut Vec<WsjtMessage>,
) {
    vec.push(WsjtMessage {
        freq_hz,
        dt_sec,
        snr_db: 0.0,
        hard_errors: 0,
        pass: 0,
        text: CString::new(text).unwrap_or_default().into_raw(),
    });
}

fn finalise(vec: Vec<WsjtMessage>, out: &mut WsjtMessageList) {
    let mut vec = vec;
    let len = vec.len();
    let cap = vec.capacity();
    let items = vec.as_mut_ptr();
    std::mem::forget(vec);
    out.items = items;
    out.len = len;
    out._cap = cap;
}

/// Decode one slot of f32 PCM audio at `sample_rate` Hz (non-12 kHz
/// input is resampled internally). Writes zero-or-more messages into
/// `out`. Dispatches to the right backend by protocol tag.
///
/// # Safety
///
/// - `dec` must be a live [`WsjtDecoder`] handle.
/// - `samples` must point to `n_samples` valid `f32` values.
/// - `out` must point to a writable [`WsjtMessageList`]; caller must
///   pair with [`wsjt_message_list_free`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_decode_f32(
    dec: *const WsjtDecoder,
    samples: *const f32,
    n_samples: usize,
    sample_rate: u32,
    out: *mut WsjtMessageList,
) -> WsjtStatus {
    let Some(inner_ref) = inner(dec) else {
        set_error("wsjt_decode_f32: null decoder handle");
        return WsjtStatus::InvalidArg;
    };
    if samples.is_null() || out.is_null() {
        set_error("wsjt_decode_f32: null buffer pointer");
        return WsjtStatus::InvalidArg;
    }
    let slice_f32 = unsafe { slice::from_raw_parts(samples, n_samples) };
    let out = unsafe { &mut *out };

    match inner_ref.protocol {
        WsjtProtocol::Ft8 | WsjtProtocol::Ft4 => {
            // Reuse the existing i16-based pipeline.
            let audio: Vec<i16> = if sample_rate == 12_000 {
                slice_f32
                    .iter()
                    .map(|&s| (s * 32767.0).clamp(-32_768.0, 32_767.0) as i16)
                    .collect()
            } else {
                mfsk_core::dsp::resample::resample_f32_to_12k(slice_f32, sample_rate)
            };
            decode_i16_wsjt77(inner_ref.protocol, &audio, out)
        }
        WsjtProtocol::Wspr => {
            let audio = mfsk_core::dsp::resample::resample_f32_to_12k_f32(slice_f32, sample_rate);
            decode_wspr(&audio, out)
        }
        WsjtProtocol::Jt9 => {
            let audio = mfsk_core::dsp::resample::resample_f32_to_12k_f32(slice_f32, sample_rate);
            decode_jt9_aligned(&audio, out)
        }
        WsjtProtocol::Jt65 => {
            let audio = mfsk_core::dsp::resample::resample_f32_to_12k_f32(slice_f32, sample_rate);
            decode_jt65_aligned(&audio, out)
        }
    }
}

/// Decode one slot of 16-bit PCM audio at `sample_rate` Hz.
///
/// # Safety
///
/// See [`wsjt_decode_f32`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_decode_i16(
    dec: *const WsjtDecoder,
    samples: *const i16,
    n_samples: usize,
    sample_rate: u32,
    out: *mut WsjtMessageList,
) -> WsjtStatus {
    let Some(inner_ref) = inner(dec) else {
        set_error("wsjt_decode_i16: null decoder handle");
        return WsjtStatus::InvalidArg;
    };
    if samples.is_null() || out.is_null() {
        set_error("wsjt_decode_i16: null buffer pointer");
        return WsjtStatus::InvalidArg;
    }
    let slice_i16 = unsafe { slice::from_raw_parts(samples, n_samples) };
    let out = unsafe { &mut *out };

    match inner_ref.protocol {
        WsjtProtocol::Ft8 | WsjtProtocol::Ft4 => {
            let audio: Vec<i16> = if sample_rate == 12_000 {
                slice_i16.to_vec()
            } else {
                mfsk_core::dsp::resample::resample_to_12k(slice_i16, sample_rate)
            };
            decode_i16_wsjt77(inner_ref.protocol, &audio, out)
        }
        WsjtProtocol::Wspr | WsjtProtocol::Jt9 | WsjtProtocol::Jt65 => {
            // These backends consume f32 natively; convert.
            let audio: Vec<f32> = if sample_rate == 12_000 {
                slice_i16.iter().map(|&s| s as f32 / 32768.0).collect()
            } else {
                mfsk_core::dsp::resample::resample_i16_to_12k_f32(slice_i16, sample_rate)
            };
            match inner_ref.protocol {
                WsjtProtocol::Wspr => decode_wspr(&audio, out),
                WsjtProtocol::Jt9 => decode_jt9_aligned(&audio, out),
                WsjtProtocol::Jt65 => decode_jt65_aligned(&audio, out),
                _ => unreachable!(),
            }
        }
    }
}

fn decode_i16_wsjt77(
    protocol: WsjtProtocol,
    audio: &[i16],
    out: &mut WsjtMessageList,
) -> WsjtStatus {
    let mut vec: Vec<WsjtMessage> = Vec::new();
    match protocol {
        WsjtProtocol::Ft8 => {
            let ht = mfsk_msg::CallsignHashTable::new();
            for r in ft8::decode_frame(
                audio,
                200.0,
                3_000.0,
                2.0,
                None,
                ft8::DecodeDepth::BpAllOsd,
                50,
            ) {
                push_wsjt77(&r, &ht, &mut vec);
            }
        }
        WsjtProtocol::Ft4 => {
            for r in ft4::decode_frame(audio, 200.0, 3_000.0, 1.2, 50) {
                push_ft4(&r, &mut vec);
            }
        }
        _ => unreachable!(),
    }
    finalise(vec, out);
    WsjtStatus::Ok
}

fn decode_wspr(audio: &[f32], out: &mut WsjtMessageList) -> WsjtStatus {
    let mut vec: Vec<WsjtMessage> = Vec::new();
    for d in wspr_core::decode::decode_scan_default(audio, 12_000) {
        push_simple(
            d.freq_hz,
            d.start_sample as f32 / 12_000.0,
            d.message.to_string(),
            &mut vec,
        );
    }
    finalise(vec, out);
    WsjtStatus::Ok
}

/// JT9 decode at the canonical 1500 Hz carrier, slot-aligned at sample 0.
/// Callers that want (freq × time) search should build that on top of
/// `jt9_core::decode_at` directly — the FFI takes the fixed-alignment
/// path because it's the one the roundtrip test needs.
fn decode_jt9_aligned(audio: &[f32], out: &mut WsjtMessageList) -> WsjtStatus {
    let mut vec: Vec<WsjtMessage> = Vec::new();
    if let Some(msg) = jt9_core::decode_at(audio, 12_000, 0, 1500.0) {
        push_simple(1500.0, 0.0, msg.to_string(), &mut vec);
    }
    finalise(vec, out);
    WsjtStatus::Ok
}

fn decode_jt65_aligned(audio: &[f32], out: &mut WsjtMessageList) -> WsjtStatus {
    let mut vec: Vec<WsjtMessage> = Vec::new();
    if let Some(msg) = jt65_core::decode_at(audio, 12_000, 0, 1270.0) {
        push_simple(1270.0, 0.0, msg.to_string(), &mut vec);
    }
    finalise(vec, out);
    WsjtStatus::Ok
}

// ──────────────────────────────────────────────────────────────────────────
// Encode entry points
// ──────────────────────────────────────────────────────────────────────────

fn cstr_to_str<'a>(p: *const c_char) -> Result<&'a str, WsjtStatus> {
    if p.is_null() {
        set_error("null C string");
        return Err(WsjtStatus::InvalidArg);
    }
    unsafe {
        CStr::from_ptr(p).to_str().map_err(|e| {
            set_error(format!("invalid UTF-8 in C string: {e}"));
            WsjtStatus::InvalidArg
        })
    }
}

fn finalise_samples(mut v: Vec<f32>, out: &mut WsjtSamples) {
    let len = v.len();
    let cap = v.capacity();
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    out.samples = ptr;
    out.len = len;
    out._cap = cap;
}

/// Synthesise a standard FT8 message ("CALL1 CALL2 REPORT") at `freq_hz`
/// carrier. Writes 12 kHz f32 PCM into `out`.
///
/// # Safety
///
/// `call1`/`call2`/`report` must be NUL-terminated UTF-8 strings.
/// `out` must be a writable `WsjtSamples` (zero-initialise).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_encode_ft8(
    call1: *const c_char,
    call2: *const c_char,
    report: *const c_char,
    freq_hz: f32,
    out: *mut WsjtSamples,
) -> WsjtStatus {
    let Ok(c1) = cstr_to_str(call1) else { return WsjtStatus::InvalidArg };
    let Ok(c2) = cstr_to_str(call2) else { return WsjtStatus::InvalidArg };
    let Ok(rep) = cstr_to_str(report) else { return WsjtStatus::InvalidArg };
    if out.is_null() {
        set_error("wsjt_encode_ft8: null out");
        return WsjtStatus::InvalidArg;
    }
    let Some(msg77) = mfsk_msg::wsjt77::pack77(c1, c2, rep) else {
        set_error("FT8 pack77 failed");
        return WsjtStatus::InvalidArg;
    };
    let tones = ft8_core::wave_gen::message_to_tones(&msg77);
    let pcm = ft8_core::wave_gen::tones_to_f32(&tones, freq_hz, 1.0);
    finalise_samples(pcm, unsafe { &mut *out });
    WsjtStatus::Ok
}

/// Synthesise a standard FT4 message at `freq_hz`. 12 kHz f32 PCM.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_encode_ft4(
    call1: *const c_char,
    call2: *const c_char,
    report: *const c_char,
    freq_hz: f32,
    out: *mut WsjtSamples,
) -> WsjtStatus {
    let Ok(c1) = cstr_to_str(call1) else { return WsjtStatus::InvalidArg };
    let Ok(c2) = cstr_to_str(call2) else { return WsjtStatus::InvalidArg };
    let Ok(rep) = cstr_to_str(report) else { return WsjtStatus::InvalidArg };
    if out.is_null() {
        set_error("wsjt_encode_ft4: null out");
        return WsjtStatus::InvalidArg;
    }
    let Some(msg77) = mfsk_msg::wsjt77::pack77(c1, c2, rep) else {
        set_error("FT4 pack77 failed");
        return WsjtStatus::InvalidArg;
    };
    let tones = ft4_core::encode::message_to_tones(&msg77);
    let pcm = ft4_core::encode::tones_to_f32(&tones, freq_hz, 1.0);
    finalise_samples(pcm, unsafe { &mut *out });
    WsjtStatus::Ok
}

/// Synthesise a Type-1 WSPR message (`call grid power_dbm`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_encode_wspr(
    call: *const c_char,
    grid: *const c_char,
    power_dbm: i32,
    freq_hz: f32,
    out: *mut WsjtSamples,
) -> WsjtStatus {
    let Ok(c1) = cstr_to_str(call) else { return WsjtStatus::InvalidArg };
    let Ok(g) = cstr_to_str(grid) else { return WsjtStatus::InvalidArg };
    if out.is_null() {
        set_error("wsjt_encode_wspr: null out");
        return WsjtStatus::InvalidArg;
    }
    let Some(pcm) = wspr_core::synthesize_type1(c1, g, power_dbm, 12_000, freq_hz, 0.3) else {
        set_error("WSPR synth failed (bad call/grid/power)");
        return WsjtStatus::InvalidArg;
    };
    finalise_samples(pcm, unsafe { &mut *out });
    WsjtStatus::Ok
}

/// Synthesise a standard JT9 message at `freq_hz`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_encode_jt9(
    call1: *const c_char,
    call2: *const c_char,
    grid_or_report: *const c_char,
    freq_hz: f32,
    out: *mut WsjtSamples,
) -> WsjtStatus {
    let Ok(c1) = cstr_to_str(call1) else { return WsjtStatus::InvalidArg };
    let Ok(c2) = cstr_to_str(call2) else { return WsjtStatus::InvalidArg };
    let Ok(gr) = cstr_to_str(grid_or_report) else { return WsjtStatus::InvalidArg };
    if out.is_null() {
        set_error("wsjt_encode_jt9: null out");
        return WsjtStatus::InvalidArg;
    }
    let Some(pcm) = jt9_core::synthesize_standard(c1, c2, gr, 12_000, freq_hz, 0.3) else {
        set_error("JT9 synth failed (bad pack)");
        return WsjtStatus::InvalidArg;
    };
    finalise_samples(pcm, unsafe { &mut *out });
    WsjtStatus::Ok
}

/// Synthesise a standard JT65 message at `freq_hz`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_encode_jt65(
    call1: *const c_char,
    call2: *const c_char,
    grid_or_report: *const c_char,
    freq_hz: f32,
    out: *mut WsjtSamples,
) -> WsjtStatus {
    let Ok(c1) = cstr_to_str(call1) else { return WsjtStatus::InvalidArg };
    let Ok(c2) = cstr_to_str(call2) else { return WsjtStatus::InvalidArg };
    let Ok(gr) = cstr_to_str(grid_or_report) else { return WsjtStatus::InvalidArg };
    if out.is_null() {
        set_error("wsjt_encode_jt65: null out");
        return WsjtStatus::InvalidArg;
    }
    let Some(pcm) = jt65_core::synthesize_standard(c1, c2, gr, 12_000, freq_hz, 0.3) else {
        set_error("JT65 synth failed (bad pack)");
        return WsjtStatus::InvalidArg;
    };
    finalise_samples(pcm, unsafe { &mut *out });
    WsjtStatus::Ok
}

/// Library version, major.minor.patch packed into a 32-bit integer (8
/// bits per field). Useful for the consumer to sanity-check ABI
/// compatibility.
#[unsafe(no_mangle)]
pub extern "C" fn wsjt_version() -> u32 {
    let v: &str = env!("CARGO_PKG_VERSION");
    let mut parts = v.split('.').map(|s| s.parse::<u32>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    (major << 16) | (minor << 8) | patch
}

// Keep cbindgen-visible types discoverable.
const _: fn() -> (c_int, *mut c_void) = || (0, ptr::null_mut());

//! C ABI for the rs-ft8n decoder suite.
//!
//! # Overview
//!
//! Exposes the FT8 and FT4 decoders behind a small opaque-handle C API that
//! C++ and Kotlin consumers (Android JNI via a thin shim) can link
//! against. cbindgen generates the `include/wsjt.h` header on every
//! build; see `examples/cpp_smoke` for a minimal usage demo.
//!
//! # Memory ownership
//!
//! - [`wsjt_decoder_new`] / [`wsjt_decoder_free`]: opaque handle pair.
//! - [`wsjt_decode_f32`] / [`wsjt_decode_i16`]: populate a caller-provided
//!   zero-initialised [`WsjtMessageList`]. The callee owns the returned
//!   buffer until [`wsjt_message_list_free`] is invoked.
//! - All strings are UTF-8, NUL-terminated, and owned by the
//!   [`WsjtMessageList`] they appear in.
//!
//! # Thread safety
//!
//! A [`WsjtDecoder`] handle is **not** `Sync`. Each thread should own its
//! own handle. Calls do not allocate thread-local state beyond the
//! `wsjt_last_error` slot (which uses `thread_local!`).

use std::ffi::{CString, c_char, c_int};
use std::os::raw::c_void;
use std::ptr;
use std::slice;

use ft4_core::decode as ft4;
use ft8_core::decode as ft8;

// ──────────────────────────────────────────────────────────────────────────
// Public C types
// ──────────────────────────────────────────────────────────────────────────

/// Opaque decoder handle. Construct with [`wsjt_decoder_new`], release with
/// [`wsjt_decoder_free`].
#[repr(C)]
pub struct WsjtDecoder {
    _priv: [u8; 0],
    _marker: core::marker::PhantomData<*mut ()>,
}

/// Protocol tag selecting which decoder family this handle drives.
#[repr(C)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum WsjtProtocol {
    Ft8 = 0,
    Ft4 = 1,
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
    /// Hard-decision errors corrected by BP/OSD.
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

/// Returns a pointer to the thread-local last-error string, or NULL if no
/// error has been recorded on this thread. The pointer is valid until the
/// next fallible call on this thread.
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
/// `dec` must be a pointer previously returned by [`wsjt_decoder_new`], or
/// NULL. After this call the pointer is dangling.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_decoder_free(dec: *mut WsjtDecoder) {
    if !dec.is_null() {
        unsafe {
            drop(Box::from_raw(dec as *mut DecoderInner));
        }
    }
}

/// Free a [`WsjtMessageList`] populated by a decode call. The caller must
/// pass the same list (by pointer) they supplied to the decode call.
/// Passing NULL or an already-freed list is safe.
///
/// # Safety
///
/// `list` must point to a [`WsjtMessageList`] written by one of the
/// `wsjt_decode_*` functions, or be NULL. After this call, `items` is NULL
/// and `len` is 0.
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
        // Reclaim every text buffer then the Vec itself.
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

// ──────────────────────────────────────────────────────────────────────────
// Decode entry points
// ──────────────────────────────────────────────────────────────────────────

fn inner(dec: *const WsjtDecoder) -> Option<&'static DecoderInner> {
    // SAFETY: the caller owns the pointer; lifetime-tying to 'static is
    // valid because we hold an immutable borrow only for the duration of
    // the enclosing FFI call (C ABI has no lifetimes).
    unsafe { (dec as *const DecoderInner).as_ref() }
}

fn build_list(results_ft8: Option<Vec<ft8::DecodeResult>>, results_ft4: Option<Vec<ft4::DecodeResult>>, out: &mut WsjtMessageList) {
    let mut vec: Vec<WsjtMessage> = Vec::new();
    if let Some(results) = results_ft8 {
        let ht = mfsk_msg::CallsignHashTable::new();
        for r in results {
            let text = mfsk_msg::wsjt77::unpack77_with_hash(&r.message77, &ht)
                .unwrap_or_default();
            vec.push(WsjtMessage {
                freq_hz: r.freq_hz,
                dt_sec: r.dt_sec,
                snr_db: r.snr_db,
                hard_errors: r.hard_errors,
                pass: r.pass,
                text: CString::new(text).unwrap_or_default().into_raw(),
            });
        }
    }
    if let Some(results) = results_ft4 {
        let codec = mfsk_msg::Wsjt77Message::default();
        let ctx = mfsk_core::DecodeContext::default();
        for r in results {
            let text = {
                use mfsk_core::MessageCodec;
                codec.unpack(&r.message77, &ctx).unwrap_or_default()
            };
            vec.push(WsjtMessage {
                freq_hz: r.freq_hz,
                dt_sec: r.dt_sec,
                snr_db: r.snr_db,
                hard_errors: r.hard_errors,
                pass: r.pass,
                text: CString::new(text).unwrap_or_default().into_raw(),
            });
        }
    }
    let len = vec.len();
    let cap = vec.capacity();
    let items = vec.as_mut_ptr();
    std::mem::forget(vec);
    out.items = items;
    out.len = len;
    out._cap = cap;
}

/// Decode one slot of f32 PCM audio at `sample_rate` Hz (non-12 kHz input
/// is resampled internally). Writes zero-or-more messages into `out`.
///
/// # Safety
///
/// - `dec` must be a live [`WsjtDecoder`] handle.
/// - `samples` must point to `n_samples` valid `f32` values.
/// - `out` must point to a writable [`WsjtMessageList`]; caller must pair
///   with [`wsjt_message_list_free`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsjt_decode_f32(
    dec: *const WsjtDecoder,
    samples: *const f32,
    n_samples: usize,
    sample_rate: u32,
    out: *mut WsjtMessageList,
) -> WsjtStatus {
    let Some(inner) = inner(dec) else {
        set_error("wsjt_decode_f32: null decoder handle");
        return WsjtStatus::InvalidArg;
    };
    if samples.is_null() || out.is_null() {
        set_error("wsjt_decode_f32: null buffer pointer");
        return WsjtStatus::InvalidArg;
    }
    let slice = unsafe { slice::from_raw_parts(samples, n_samples) };
    let audio: Vec<i16> = if sample_rate == 12_000 {
        slice.iter().map(|&s| (s * 32767.0).clamp(-32_768.0, 32_767.0) as i16).collect()
    } else {
        mfsk_core::dsp::resample::resample_f32_to_12k(slice, sample_rate)
    };
    decode_i16_inner(inner, &audio, unsafe { &mut *out })
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
    let Some(inner) = inner(dec) else {
        set_error("wsjt_decode_i16: null decoder handle");
        return WsjtStatus::InvalidArg;
    };
    if samples.is_null() || out.is_null() {
        set_error("wsjt_decode_i16: null buffer pointer");
        return WsjtStatus::InvalidArg;
    }
    let slice = unsafe { slice::from_raw_parts(samples, n_samples) };
    let audio: Vec<i16> = if sample_rate == 12_000 {
        slice.to_vec()
    } else {
        mfsk_core::dsp::resample::resample_to_12k(slice, sample_rate)
    };
    decode_i16_inner(inner, &audio, unsafe { &mut *out })
}

fn decode_i16_inner(inner: &DecoderInner, audio: &[i16], out: &mut WsjtMessageList) -> WsjtStatus {
    match inner.protocol {
        WsjtProtocol::Ft8 => {
            let results = ft8::decode_frame(
                audio,
                200.0,
                3_000.0,
                2.0,
                None,
                ft8::DecodeDepth::BpAllOsd,
                50,
            );
            build_list(Some(results), None, out);
            WsjtStatus::Ok
        }
        WsjtProtocol::Ft4 => {
            let results = ft4::decode_frame(audio, 200.0, 3_000.0, 1.2, 50);
            build_list(None, Some(results), out);
            WsjtStatus::Ok
        }
    }
}

/// Library version, major.minor.patch packed into a 32-bit integer (8 bits
/// per field). Useful for the consumer to sanity-check ABI compatibility.
#[unsafe(no_mangle)]
pub extern "C" fn wsjt_version() -> u32 {
    let v: &str = env!("CARGO_PKG_VERSION");
    let mut parts = v.split('.').map(|s| s.parse::<u32>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    (major << 16) | (minor << 8) | patch
}

// Suppress unused-import on c_int / c_void; kept for cbindgen discovery.
const _: fn() -> (c_int, *mut c_void) = || (0, ptr::null_mut());

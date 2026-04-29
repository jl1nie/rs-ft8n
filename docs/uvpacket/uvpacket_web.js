/* @ts-self-types="./uvpacket_web.d.ts" */

export class AdvInput {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AdvInputFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_advinput_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.advinput_new();
        this.__wbg_ptr = ret >>> 0;
        AdvInputFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {string} v
     */
    set_address(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.advinput_set_address(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_bio(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.advinput_set_bio(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_fr(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.advinput_set_fr(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_name(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.advinput_set_name(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) AdvInput.prototype[Symbol.dispose] = AdvInput.prototype.free;

export class DecodedSignedFrame {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(DecodedSignedFrame.prototype);
        obj.__wbg_ptr = ptr;
        DecodedSignedFrameFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecodedSignedFrameFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decodedsignedframe_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get addr_m() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.decodedsignedframe_addr_m(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get addr_mona1() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.decodedsignedframe_addr_mona1(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get addr_p() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.decodedsignedframe_addr_p(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get app_type() {
        const ret = wasm.decodedsignedframe_app_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * Detected audio centre frequency (Hz). For the single-station FM
     * decode path this matches the input centre; for the multichannel
     * SSB path it is the centre picked by the coarse-grid scan.
     * @returns {number}
     */
    get audio_centre_hz() {
        const ret = wasm.decodedsignedframe_audio_centre_hz(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get block_count() {
        const ret = wasm.decodedsignedframe_block_count(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get card_kind() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.decodedsignedframe_card_kind(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.decodedsignedframe_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get mode_code() {
        const ret = wasm.decodedsignedframe_mode_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get sequence() {
        const ret = wasm.decodedsignedframe_sequence(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get sig_b64() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.decodedsignedframe_sig_b64(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {boolean}
     */
    get verified() {
        const ret = wasm.decodedsignedframe_verified(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) DecodedSignedFrame.prototype[Symbol.dispose] = DecodedSignedFrame.prototype.free;

export class KeyInfo {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(KeyInfo.prototype);
        obj.__wbg_ptr = ptr;
        KeyInfoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        KeyInfoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_keyinfo_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get addr_m() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.keyinfo_addr_m(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get addr_mona1() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.keyinfo_addr_mona1(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get addr_p() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.keyinfo_addr_p(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get pubkey_hex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.keyinfo_pubkey_hex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get secret_hex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.keyinfo_secret_hex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) KeyInfo.prototype[Symbol.dispose] = KeyInfo.prototype.free;

export class QslInput {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        QslInputFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_qslinput_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.qslinput_new();
        this.__wbg_ptr = ret >>> 0;
        QslInputFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {string} v
     */
    set_date(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.qslinput_set_date(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_fr(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.qslinput_set_fr(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_freq(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.qslinput_set_freq(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_mode(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.qslinput_set_mode(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_qth(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.qslinput_set_qth(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_rs(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.qslinput_set_rs(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_time(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.qslinput_set_time(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} v
     */
    set_to(v) {
        const ptr0 = passStringToWasm0(v, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.qslinput_set_to(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) QslInput.prototype[Symbol.dispose] = QslInput.prototype.free;

/**
 * Single-station decode at a known audio centre. Suitable for **NFM**
 * receive (one station per RF channel, audio centre fixed at e.g.
 * 1500 Hz). Internally calls `mfsk_core::uvpacket::rx::decode`.
 * @param {Float32Array} samples
 * @param {number} audio_centre_hz
 * @returns {DecodedSignedFrame[]}
 */
export function decode_uvpacket(samples, audio_centre_hz) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_uvpacket(ptr0, len0, audio_centre_hz);
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Multi-station decode by sweeping the SSB audio passband. Suitable
 * for **SSB** receive on a private group sharing one RF channel
 * (e.g., 430.090 MHz USB) where every TX picks an audio slot inside
 * the passband. Internally calls
 * `mfsk_core::uvpacket::rx::decode_multichannel`.
 *
 * `band_lo_hz` / `band_hi_hz` define the search window
 * (typical 300–2700 Hz). `coarse_step_hz` defaults to 25 Hz when 0.
 * Returns one entry per detected frame; the detected audio centre is
 * available via `DecodedSignedFrame.audio_centre_hz`.
 * @param {Float32Array} samples
 * @param {number} band_lo_hz
 * @param {number} band_hi_hz
 * @param {number} coarse_step_hz
 * @param {number} peak_rel_threshold
 * @param {Uint8Array} mode_codes
 * @param {Uint8Array} n_blocks
 * @returns {DecodedSignedFrame[]}
 */
export function decode_uvpacket_multichannel(samples, band_lo_hz, band_hi_hz, coarse_step_hz, peak_rel_threshold, mode_codes, n_blocks) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(mode_codes, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(n_blocks, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.decode_uvpacket_multichannel(ptr0, len0, band_lo_hz, band_hi_hz, coarse_step_hz, peak_rel_threshold, ptr1, len1, ptr2, len2);
    var v4 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * Single-station decode constrained to a caller-supplied list of
 * (mode_code, n_blocks) layouts. Bounds worst-case LDPC sweep to
 * `len(layouts)` per peak, regardless of how many peaks pass the
 * sync gate.
 *
 * `mode_codes`/`n_blocks` are paired by index (must be the same
 * length). `mode_code` is `Mode::header_code()` — `0=Robust,
 * 1=Standard, 2=Fast, 3=Express`. n_blocks must be `1..=32`.
 *
 * For the QSL signed-card use case, pass the layouts that the
 * application's TX path actually emits (typically Standard with
 * `n_blocks ≈ ceil((payload_bytes + 4) / 12)`). This caps worst-case
 * decode work at a known bound — important for browsers because
 * the unconstrained 128-layout sweep can take 15 s in WASM and time
 * out the worker.
 * @param {Float32Array} samples
 * @param {number} audio_centre_hz
 * @param {Uint8Array} mode_codes
 * @param {Uint8Array} n_blocks
 * @returns {DecodedSignedFrame[]}
 */
export function decode_uvpacket_with_layouts(samples, audio_centre_hz, mode_codes, n_blocks) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(mode_codes, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(n_blocks, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.decode_uvpacket_with_layouts(ptr0, len0, audio_centre_hz, ptr1, len1, ptr2, len2);
    var v4 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * Diagnostic: returns `[global_max, median, ratio, n_scores]` for the
 * preamble-correlation distribution that mfsk-core's auto-detect
 * decoder computes internally. `ratio = global_max / median` is the
 * quantity the sync gate compares to its 20× threshold. Values around
 * 16 indicate pure-noise input; ≥ 20 trips the gate and the LDPC
 * sweep runs; ≥ 56 is a real signal at +1 dB Robust threshold.
 * @param {Float32Array} samples
 * @param {number} audio_centre_hz
 * @returns {Float32Array}
 */
export function diag_sync_stats(samples, audio_centre_hz) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.diag_sync_stats(ptr0, len0, audio_centre_hz);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Pre-AFC vs post-AFC sync stats + estimated delta_f, packed as
 * `[pre_max, pre_median, pre_ratio, delta_f,
 *   post_max, post_median, post_ratio]`.
 *
 * Empty vector if the buffer is too short for a sync evaluation.
 * @param {Float32Array} samples
 * @param {number} audio_centre_hz
 * @returns {Float32Array}
 */
export function diag_sync_with_afc(samples, audio_centre_hz) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.diag_sync_with_afc(ptr0, len0, audio_centre_hz);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * @param {AdvInput} card
 * @param {string} secret_hex
 * @param {number} audio_centre_hz
 * @param {number} mode_code
 * @param {number} sequence
 * @returns {Float32Array}
 */
export function encode_adv_v1(card, secret_hex, audio_centre_hz, mode_code, sequence) {
    _assertClass(card, AdvInput);
    const ptr0 = passStringToWasm0(secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_adv_v1(card.__wbg_ptr, ptr0, len0, audio_centre_hz, mode_code, sequence);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * @param {QslInput} card
 * @param {string} secret_hex
 * @param {number} audio_centre_hz
 * @param {number} mode_code
 * @param {number} sequence
 * @returns {Float32Array}
 */
export function encode_qsl_v1(card, secret_hex, audio_centre_hz, mode_code, sequence) {
    _assertClass(card, QslInput);
    const ptr0 = passStringToWasm0(secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_qsl_v1(card.__wbg_ptr, ptr0, len0, audio_centre_hz, mode_code, sequence);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Encode a pre-built signed payload (`<JSON><sig_b64>`). Useful when
 * the JS side wants to round-trip a pico_tnc-format payload pasted by
 * the user (e.g. via the `sign recovery` TTY command output).
 * @param {string} payload
 * @param {number} app_type
 * @param {number} audio_centre_hz
 * @param {number} mode_code
 * @param {number} sequence
 * @returns {Float32Array}
 */
export function encode_signed_raw(payload, app_type, audio_centre_hz, mode_code, sequence) {
    const ptr0 = passStringToWasm0(payload, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_signed_raw(ptr0, len0, app_type, audio_centre_hz, mode_code, sequence);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * @returns {KeyInfo}
 */
export function generate_key() {
    const ret = wasm.generate_key();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return KeyInfo.__wrap(ret[0]);
}

/**
 * @param {string} secret_hex
 * @returns {KeyInfo}
 */
export function keyinfo_from_secret_hex(secret_hex) {
    const ptr0 = passStringToWasm0(secret_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.keyinfo_from_secret_hex(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return KeyInfo.__wrap(ret[0]);
}

/**
 * Per-slot energy survey. Used by the SSB TX path before transmitting:
 * inspect the audio passband, find a slot with low matched-filter
 * energy, transmit there. Internally calls
 * `mfsk_core::uvpacket::rx::measure_slot_energies`.
 *
 * `slot_spacing_hz` defines the slot grid (typical 1200 Hz so a 2.4 kHz
 * SSB passband fits 2 slots at 800/2000 Hz). Returns alternating
 * `[centre_hz, magnitude, centre_hz, magnitude, …]` pairs in a single
 * `Float32Array` for efficient JS interop.
 * @param {Float32Array} samples
 * @param {number} band_lo_hz
 * @param {number} band_hi_hz
 * @param {number} slot_spacing_hz
 * @returns {Float32Array}
 */
export function measure_slots(samples, band_lo_hz, band_hi_hz, slot_spacing_hz) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.measure_slots(ptr0, len0, band_lo_hz, band_hi_hz, slot_spacing_hz);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Returns "uvpacket-web <ver> / mfsk-core <ver>" so the JS side can
 * confirm which mfsk-core actually got linked into the deployed wasm
 * (avoids the [patch.crates-io] cache-miss class of bug).
 * @returns {string}
 */
export function version_info() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version_info();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_49868bde5eb1e745: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_40c5a80572e8f9d3: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_b29b5c5a8065ba1a: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_81fc77679af83bc6: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_d578befcc3145dee: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_decodedsignedframe_new: function(arg0) {
            const ret = DecodedSignedFrame.__wrap(arg0);
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_0c32cb8543c8e4c8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_with_length_9cedd08484b73942: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_3e05eb9545565046: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_24f78b6d23f286ea: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_59fd959c540fe405: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_0f98d3fb634508ad: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./uvpacket_web_bg.js": import0,
    };
}

const AdvInputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_advinput_free(ptr >>> 0, 1));
const DecodedSignedFrameFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decodedsignedframe_free(ptr >>> 0, 1));
const KeyInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_keyinfo_free(ptr >>> 0, 1));
const QslInputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_qslinput_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('uvpacket_web_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

/* @ts-self-types="./ft8_web.d.ts" */

export class DecodedMessage {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(DecodedMessage.prototype);
        obj.__wbg_ptr = ptr;
        DecodedMessageFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecodedMessageFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decodedmessage_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get message() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.decodedmessage_message(this.__wbg_ptr);
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
    get dt_sec() {
        const ret = wasm.__wbg_get_decodedmessage_dt_sec(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get freq_hz() {
        const ret = wasm.__wbg_get_decodedmessage_freq_hz(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get hard_errors() {
        const ret = wasm.__wbg_get_decodedmessage_hard_errors(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get pass() {
        const ret = wasm.__wbg_get_decodedmessage_pass(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get snr_db() {
        const ret = wasm.__wbg_get_decodedmessage_snr_db(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set dt_sec(arg0) {
        wasm.__wbg_set_decodedmessage_dt_sec(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set freq_hz(arg0) {
        wasm.__wbg_set_decodedmessage_freq_hz(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set hard_errors(arg0) {
        wasm.__wbg_set_decodedmessage_hard_errors(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set pass(arg0) {
        wasm.__wbg_set_decodedmessage_pass(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set snr_db(arg0) {
        wasm.__wbg_set_decodedmessage_snr_db(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) DecodedMessage.prototype[Symbol.dispose] = DecodedMessage.prototype.free;

/**
 * Phase 1 decode (i16): fast single-pass decode.
 *
 * Caches the resampled audio and FFT for a subsequent `decode_phase2` call.
 * @param {Int16Array} samples
 * @param {number} sample_rate
 * @returns {DecodedMessage[]}
 */
export function decode_phase1(samples, sample_rate) {
    const ptr0 = passArray16ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_phase1(ptr0, len0, sample_rate);
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Phase 1 decode (f32): fast single-pass decode for live AudioWorklet path.
 *
 * Caches the resampled audio and FFT for a subsequent `decode_phase2_f32` call.
 * @param {Float32Array} samples
 * @param {number} sample_rate
 * @returns {DecodedMessage[]}
 */
export function decode_phase1_f32(samples, sample_rate) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_phase1_f32(ptr0, len0, sample_rate);
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Phase 2 decode (i16): 3-pass subtract using cached Phase 1 state.
 *
 * Panics if `decode_phase1` was not called first.
 * @param {number} strictness
 * @returns {DecodedMessage[]}
 */
export function decode_phase2(strictness) {
    const ret = wasm.decode_phase2(strictness);
    var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Phase 2 decode (f32): 3-pass subtract using cached Phase 1 state.
 *
 * Panics if `decode_phase1_f32` was not called first.
 * @param {number} strictness
 * @returns {DecodedMessage[]}
 */
export function decode_phase2_f32(strictness) {
    const ret = wasm.decode_phase2_f32(strictness);
    var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Sniper-mode decode with multi-pass AP (single WASM call).
 *
 * AP passes are handled internally by ft8-core (pass 6-11).
 * The deepest applicable pass is tried first based on available info:
 *   mycall + dxcall + RRR/RR73/73 → 77-bit lock (passes 9-11)
 *   CQ + dxcall → 61-bit lock (pass 7)
 *   mycall + dxcall → 61-bit lock (pass 8)
 *   dxcall only → 33-bit lock (pass 6)
 * @param {Int16Array} samples
 * @param {number} target_freq
 * @param {string} callsign
 * @param {string} mycall
 * @param {boolean} eq_on
 * @param {number} sample_rate
 * @returns {DecodedMessage[]}
 */
export function decode_sniper(samples, target_freq, callsign, mycall, eq_on, sample_rate) {
    const ptr0 = passArray16ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(callsign, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(mycall, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.decode_sniper(ptr0, len0, target_freq, ptr1, len1, ptr2, len2, eq_on, sample_rate);
    var v4 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * f32 variant of `decode_sniper`. See `decode_sniper` for parameters.
 * @param {Float32Array} samples
 * @param {number} target_freq
 * @param {string} callsign
 * @param {string} mycall
 * @param {boolean} eq_on
 * @param {number} sample_rate
 * @returns {DecodedMessage[]}
 */
export function decode_sniper_f32(samples, target_freq, callsign, mycall, eq_on, sample_rate) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(callsign, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(mycall, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.decode_sniper_f32(ptr0, len0, target_freq, ptr1, len1, ptr2, len2, eq_on, sample_rate);
    var v4 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * Decode a 15-second FT8 audio frame (wide-band scan).
 *
 * `sample_rate` — input PCM sample rate in Hz (e.g. 12000, 44100, 48000).
 * Non-12 000 Hz input is automatically resampled before decoding.
 * @param {Int16Array} samples
 * @param {number} strictness
 * @param {number} sample_rate
 * @returns {DecodedMessage[]}
 */
export function decode_wav(samples, strictness, sample_rate) {
    const ptr0 = passArray16ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_wav(ptr0, len0, strictness, sample_rate);
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * f32 variant of `decode_wav`. See `decode_wav` for parameters.
 * @param {Float32Array} samples
 * @param {number} strictness
 * @param {number} sample_rate
 * @returns {DecodedMessage[]}
 */
export function decode_wav_f32(samples, strictness, sample_rate) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_wav_f32(ptr0, len0, strictness, sample_rate);
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Decode with iterative signal subtraction.
 *
 * `sample_rate` — input PCM sample rate in Hz. Non-12 000 Hz input is
 * automatically resampled before decoding.
 * @param {Int16Array} samples
 * @param {number} strictness
 * @param {number} sample_rate
 * @returns {DecodedMessage[]}
 */
export function decode_wav_subtract(samples, strictness, sample_rate) {
    const ptr0 = passArray16ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_wav_subtract(ptr0, len0, strictness, sample_rate);
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * f32 variant of `decode_wav_subtract`. See `decode_wav_subtract` for parameters.
 * @param {Float32Array} samples
 * @param {number} strictness
 * @param {number} sample_rate
 * @returns {DecodedMessage[]}
 */
export function decode_wav_subtract_f32(samples, strictness, sample_rate) {
    const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_wav_subtract_f32(ptr0, len0, strictness, sample_rate);
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Encode a free-text FT8 message (Type 0, n3=0) as audio samples.
 *
 * `text` — up to 13 characters from the FT8 free-text alphabet.
 * @param {string} text
 * @param {number} freq_hz
 * @returns {Float32Array}
 */
export function encode_free_text(text, freq_hz) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_free_text(ptr0, len0, freq_hz);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * @param {string} call1
 * @param {string} call2
 * @param {string} report
 * @param {number} freq_hz
 * @returns {Float32Array}
 */
export function encode_ft8(call1, call2, report, freq_hz) {
    const ptr0 = passStringToWasm0(call1, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(call2, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(report, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.encode_ft8(ptr0, len0, ptr1, len1, ptr2, len2, freq_hz);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_6b64449b9b9ed33c: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_decodedmessage_new: function(arg0) {
            const ret = DecodedMessage.__wrap(arg0);
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
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
        "./ft8_web_bg.js": import0,
    };
}

const DecodedMessageFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decodedmessage_free(ptr >>> 0, 1));

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

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
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
    cachedUint16ArrayMemory0 = null;
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
        module_or_path = new URL('ft8_web_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

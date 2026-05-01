// Web Worker for FT8 decode.
//
// Runs the WASM decoder off the main thread so the waterfall keeps scrolling
// (and the UI stays responsive) while a 200-400 ms decode call is in flight.
// The worker has its own WASM instance — duplicates ~400 KB of memory but
// avoids the SharedArrayBuffer / COOP / COEP requirements GitHub Pages
// doesn't set.
//
// Message protocol (main → worker):
//   { id, fn, args }    — fn is one of FN_MAP keys; args is positional
//
// Replies (worker → main):
//   { type: 'ready' }                    — once after init() completes
//   { id, ok: true, results }            — decoded messages as plain objects
//   { id, ok: false, error }             — decode threw

import init, {
  // FT8
  decode_wav, decode_wav_subtract, decode_sniper,
  decode_wav_f32, decode_wav_subtract_f32, decode_sniper_f32,
  decode_phase1, decode_phase1_f32,
  decode_phase2, decode_phase2_f32,
  // FT4
  decode_ft4_wav, decode_ft4_wav_f32,
  decode_ft4_wav_subtract, decode_ft4_wav_subtract_f32,
  decode_ft4_sniper, decode_ft4_sniper_f32,
  // WSPR
  decode_wspr_wav, decode_wspr_wav_f32,
  // Q65 — basic BP scan + fast-fading metric. (sub-mode passed as u8)
  decode_q65_wav, decode_q65_wav_f32,
  decode_q65_wav_fading, decode_q65_wav_fading_f32,
} from '../pkg/ft8_web.js';

const FN_MAP = {
  decode_wav, decode_wav_subtract, decode_sniper,
  decode_wav_f32, decode_wav_subtract_f32, decode_sniper_f32,
  decode_phase1, decode_phase1_f32,
  decode_phase2, decode_phase2_f32,
  decode_ft4_wav, decode_ft4_wav_f32,
  decode_ft4_wav_subtract, decode_ft4_wav_subtract_f32,
  decode_ft4_sniper, decode_ft4_sniper_f32,
  decode_wspr_wav, decode_wspr_wav_f32,
  decode_q65_wav, decode_q65_wav_f32,
  decode_q65_wav_fading, decode_q65_wav_fading_f32,
};

const initPromise = init().then(() => {
  self.postMessage({ type: 'ready' });
});

// Convert WASM-side DecodedMessage instances to plain JS objects so we can
// postMessage them back. The DecodedMessage struct holds WASM-side memory,
// so we read its fields and free it before crossing the worker boundary.
function toPlain(results) {
  const plain = new Array(results.length);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    plain[i] = {
      message: r.message,
      freq_hz: r.freq_hz,
      dt_sec: r.dt_sec,
      snr_db: r.snr_db,
      hard_errors: r.hard_errors,
      pass: r.pass,
    };
    r.free();
  }
  return plain;
}

self.onmessage = async (e) => {
  await initPromise;
  const { id, fn, args } = e.data;
  try {
    const f = FN_MAP[fn];
    if (!f) throw new Error(`unknown decode fn: ${fn}`);
    const results = f(...args);
    self.postMessage({ id, ok: true, results: toPlain(results) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

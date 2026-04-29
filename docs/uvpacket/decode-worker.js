// SPDX-License-Identifier: GPL-3.0-or-later
// Web Worker hosting the WASM uvpacket decoder. Keeps the decode passes
// (matched-filter sweep + LDPC BP/OSD) off the main thread so the UI
// stays responsive even on slow phones.
//
// Protocol (postMessage):
//   { type: 'init' }                                            → { type: 'ready' }
//   { type: 'decode-fm',  samples, audio_centre_hz }            → { type: 'decoded', frames }
//   { type: 'decode-ssb', samples, band_lo, band_hi, step }     → { type: 'decoded', frames }
//   { type: 'measure-slots', samples, band_lo, band_hi, slot }  → { type: 'slots', pairs }

import init, {
  decode_uvpacket,
  decode_uvpacket_with_layouts,
  decode_uvpacket_multichannel,
  measure_slots,
  version_info,
  diag_sync_stats,
  diag_sync_with_afc,
} from './uvpacket_web.js';

let ready = false;

function frameToObj(f) {
  return {
    app_type: f.app_type,
    sequence: f.sequence,
    mode_code: f.mode_code,
    block_count: f.block_count,
    audio_centre_hz: f.audio_centre_hz,
    json: f.json,
    sig_b64: f.sig_b64,
    verified: f.verified,
    addr_mona1: f.addr_mona1,
    addr_m: f.addr_m,
    addr_p: f.addr_p,
    card_kind: f.card_kind,
  };
}

self.onerror = (e) => {
  self.postMessage({ type: 'error', error: 'worker top-level: ' + (e.message || String(e)) });
};

self.onmessage = async (e) => {
  const msg = e.data;
  // Every request from main thread carries a `req_id`; we echo it back
  // on every reply so the main thread can route to the matching handler
  // even when multiple decodes are in flight (e.g. periodic acoustic-RX
  // pass overlapping with a Loopback button click).
  const id = msg.req_id;

  if (msg.type === 'init') {
    try {
      if (!ready) {
        await init();
        ready = true;
      }
      self.postMessage({ type: 'ready', version: version_info(), req_id: id });
    } catch (err) {
      self.postMessage({ type: 'error', error: 'init: ' + String(err), req_id: id });
    }
    return;
  }
  if (!ready) {
    self.postMessage({ type: 'error', error: 'decoder not initialised', req_id: id });
    return;
  }
  try {
    if (msg.type === 'diag-sync') {
      // Use the AFC-aware variant — gives us pre/post coherence and
      // the estimated delta_f for the strongest peak. Same compute as
      // the basic diag-sync plus one matched-filter pass for AFC and
      // one for post-AFC stats — still ≪ a full LDPC sweep.
      const arr = diag_sync_with_afc(msg.samples, msg.audio_centre_hz);
      self.postMessage({ type: 'sync-stats', stats: Array.from(arr), req_id: id });
      return;
    }
    if (msg.type === 'decode-fm') {
      const frames = msg.layouts && msg.layouts.length
        ? decode_uvpacket_with_layouts(
            msg.samples,
            msg.audio_centre_hz,
            new Uint8Array(msg.layouts.map((l) => l[0])),
            new Uint8Array(msg.layouts.map((l) => l[1])),
          )
        : decode_uvpacket(msg.samples, msg.audio_centre_hz);
      self.postMessage({ type: 'decoded', frames: frames.map(frameToObj), req_id: id });
    } else if (msg.type === 'decode-ssb') {
      const lay = msg.layouts || [];
      const frames = decode_uvpacket_multichannel(
        msg.samples,
        msg.band_lo,
        msg.band_hi,
        msg.step || 0,
        msg.peak_rel || 0,
        new Uint8Array(lay.map((l) => l[0])),
        new Uint8Array(lay.map((l) => l[1])),
      );
      self.postMessage({ type: 'decoded', frames: frames.map(frameToObj), req_id: id });
    } else if (msg.type === 'measure-slots') {
      const pairs = measure_slots(msg.samples, msg.band_lo, msg.band_hi, msg.slot);
      const out = [];
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        out.push({ centre_hz: pairs[i], magnitude: pairs[i + 1] });
      }
      self.postMessage({ type: 'slots', slots: out, req_id: id });
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err), req_id: id });
  }
};

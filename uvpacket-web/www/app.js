// SPDX-License-Identifier: GPL-3.0-or-later
// Main app glue for uvpacket-web. Orchestrates:
//  - WASM init (main thread for sign/encode; worker for decode)
//  - Audio capture / output
//  - TX form
//  - RX log
//  - Mode toggle (FM single-station vs SSB multi-channel)
//  - Settings dialog (mycall, key generation/import, address type)
//  - Inline waterfall

import init, {
  encode_qsl_v1,
  encode_adv_v1,
  generate_key,
  keyinfo_from_secret_hex,
  QslInput,
  AdvInput,
} from './uvpacket_web.js';
import { UvAudioCapture } from './audio-capture.js';
import { UvAudioOutput } from './audio-output.js';
import { loadActive, saveActive } from './keystore.js';

const APP_VERSION = '__VERSION__';

const $ = (id) => document.getElementById(id);

const state = {
  mode: 'fm', // 'fm' | 'ssb'
  cardType: 'qsl', // 'qsl' | 'adv'
  listening: false,
  key: null, // { secret_hex, pubkey_hex, addr_m, addr_p, addr_mona1 }
  mycall: '',
  addrType: 'm',
};

// ───────────────────────────── WASM init ──────────────────────────────

const decoder = new Worker('decode-worker.js', { type: 'module' });

// ID-routed reply dispatch. Each call to `decoderRequest(payload)` gets
// its own unique req_id; the worker echoes it back on every reply so we
// can match. Without this, overlapping decode passes (periodic RX +
// loopback button + slot survey) collide on `addEventListener('message')`
// and one handler steals another's reply.
let _nextReqId = 1;
const _pending = new Map();
decoder.addEventListener('message', (e) => {
  const id = e.data?.req_id;
  console.log('[uvpacket-web] worker reply', e.data?.type, 'req_id=', id);
  if (id == null) return;
  const entry = _pending.get(id);
  if (!entry) return;
  _pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(e.data);
});

function decoderRequest(payload, transfer, timeoutMs = 15000) {
  const req_id = _nextReqId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (_pending.has(req_id)) {
        _pending.delete(req_id);
        console.warn(`[uvpacket-web] decoder request ${req_id} (${payload.type}) timed out after ${timeoutMs} ms`);
        resolve({ type: 'error', error: 'timeout', req_id });
      }
    }, timeoutMs);
    _pending.set(req_id, { resolve, timer });
    decoder.postMessage({ ...payload, req_id }, transfer || []);
  });
}

let decoderReady = decoderRequest({ type: 'init' });

async function bootWasm() {
  await init();
  decoder.addEventListener('error', (e) => {
    console.error('[uvpacket-web] worker error event:', e);
    setStatus('Worker error — see console.');
  });
  decoder.addEventListener('messageerror', (e) => {
    console.error('[uvpacket-web] worker messageerror:', e);
  });
  const ready = await decoderReady;
  if (ready?.version) {
    console.log('[uvpacket-web] worker reports', ready.version);
    setStatus('Decoder ready: ' + ready.version);
  } else {
    setStatus('Decoder ready.');
  }
}

// ───────────────────────────── Mode toggle ─────────────────────────────

function setMode(m) {
  state.mode = m;
  $('mode-fm').classList.toggle('active', m === 'fm');
  $('mode-ssb').classList.toggle('active', m === 'ssb');
  $('slot-survey-row').style.display = m === 'ssb' ? 'flex' : 'none';
  if (m === 'fm') {
    $('f-centre').value = '1500';
  }
  redrawSlotMarkers();
}
$('mode-fm').onclick = () => setMode('fm');
$('mode-ssb').onclick = () => setMode('ssb');

// ───────────────────────────── Card type toggle ────────────────────────

$('card-type').onchange = (e) => {
  state.cardType = e.target.value;
  $('card-kind').textContent = state.cardType === 'adv' ? 'ADV' : 'QSL';
  $('qsl-fields').style.display = state.cardType === 'qsl' ? '' : 'none';
  $('adv-fields').style.display = state.cardType === 'adv' ? '' : 'none';
};

// ───────────────────────────── Key management ──────────────────────────

const dlg = $('settings');
$('gear-btn').onclick = () => dlg.showModal();
$('set-close').onclick = () => dlg.close();

function applyKey(k, mycall, addrType) {
  state.key = k;
  state.mycall = mycall || state.mycall;
  state.addrType = addrType || state.addrType;
  if (k) {
    const addr =
      addrType === 'mona1' ? k.addr_mona1 : addrType === 'p' ? k.addr_p : k.addr_m;
    $('key-status').textContent = 'Key loaded.';
    $('key-pubkey-line').textContent = `pubkey: ${k.pubkey_hex}`;
    $('key-addr-line').textContent = `addr: ${addr}`;
  } else {
    $('key-status').textContent = 'No key loaded.';
    $('key-pubkey-line').textContent = '';
    $('key-addr-line').textContent = '';
  }
  $('my-id').textContent = state.mycall ? `— ${state.mycall}` : '— set callsign in ⚙';
}

$('set-mycall').oninput = (e) => {
  state.mycall = e.target.value.trim().toUpperCase();
  $('my-id').textContent = state.mycall ? `— ${state.mycall}` : '— set callsign in ⚙';
};

$('set-addr-type').onchange = (e) => {
  state.addrType = e.target.value;
  if (state.key) applyKey(state.key, state.mycall, state.addrType);
};

$('key-gen').onclick = async () => {
  const k = generate_key();
  const slot = {
    secret_hex: k.secret_hex,
    pubkey_hex: k.pubkey_hex,
    addr_m: k.addr_m,
    addr_p: k.addr_p,
    addr_mona1: k.addr_mona1,
  };
  applyKey(slot, state.mycall, state.addrType);
  await persistSlot();
};

$('key-import').onclick = async () => {
  const hex = prompt('Paste 64-char hex secret:');
  if (!hex) return;
  try {
    const k = keyinfo_from_secret_hex(hex.trim());
    const slot = {
      secret_hex: k.secret_hex,
      pubkey_hex: k.pubkey_hex,
      addr_m: k.addr_m,
      addr_p: k.addr_p,
      addr_mona1: k.addr_mona1,
    };
    applyKey(slot, state.mycall, state.addrType);
    await persistSlot();
  } catch (e) {
    alert('Invalid secret: ' + e);
  }
};

$('key-export').onclick = () => {
  if (!state.key) {
    alert('No key loaded.');
    return;
  }
  if (!confirm('Reveal secret on screen?')) return;
  alert('Secret hex:\n\n' + state.key.secret_hex);
};

async function persistSlot() {
  if (!state.key) return;
  await saveActive({
    secret_hex: state.key.secret_hex,
    pubkey_hex: state.key.pubkey_hex,
    addr_m: state.key.addr_m,
    addr_p: state.key.addr_p,
    addr_mona1: state.key.addr_mona1,
    mycall: state.mycall,
    active_addr_type: state.addrType,
  });
}

// ───────────────────────────── TX form ─────────────────────────────────

const audioOut = new UvAudioOutput();

function buildQslInput() {
  const q = new QslInput();
  q.set_fr(state.mycall);
  q.set_to($('f-to').value.trim().toUpperCase());
  q.set_rs($('f-rs').value.trim());
  q.set_date($('f-date').value.trim());
  q.set_time($('f-time').value.trim());
  q.set_freq($('f-freq').value.trim());
  q.set_mode($('f-mode').value.trim());
  q.set_qth($('f-qth').value.trim());
  return q;
}

function buildAdvInput() {
  const a = new AdvInput();
  a.set_fr(state.mycall);
  a.set_name($('f-name').value.trim());
  a.set_bio($('f-bio').value.trim());
  const addr =
    state.addrType === 'mona1'
      ? state.key?.addr_mona1
      : state.addrType === 'p'
      ? state.key?.addr_p
      : state.key?.addr_m;
  a.set_address(addr || '');
  return a;
}

$('preview-btn').onclick = () => {
  if (!state.key || !state.mycall) {
    $('preview-out').textContent = 'Set callsign + key first.';
    return;
  }
  const json =
    state.cardType === 'qsl'
      ? buildQslJsonString()
      : buildAdvJsonString();
  $('preview-out').textContent = json;
};

// Lightweight JSON build mirroring the Rust builder, used only for the
// preview button (the actual TX path goes through the WASM signer which
// produces bit-identical bytes).
function escapeJson(s) {
  let out = '';
  for (const ch of s || '') {
    const c = ch.charCodeAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else out += '\\u' + c.toString(16).padStart(4, '0');
  }
  return out;
}
function buildQslJsonString() {
  return (
    '{"FR":"' + escapeJson(state.mycall) +
    '","QSL":{"C":"' + escapeJson($('f-to').value.trim().toUpperCase()) +
    '","S":"' + escapeJson($('f-rs').value.trim()) +
    '","D":"' + escapeJson($('f-date').value.trim()) +
    '","T":"' + escapeJson($('f-time').value.trim()) +
    '","F":"' + escapeJson($('f-freq').value.trim()) +
    '","M":"' + escapeJson($('f-mode').value.trim()) +
    '","P":"' + escapeJson($('f-qth').value.trim()) +
    '"}}'
  );
}
function buildAdvJsonString() {
  const addr =
    state.addrType === 'mona1' ? state.key?.addr_mona1 :
    state.addrType === 'p' ? state.key?.addr_p :
    state.key?.addr_m;
  return (
    '{"FR":"' + escapeJson(state.mycall) +
    '","ADV":{"N":"' + escapeJson($('f-name').value.trim()) +
    '","B":"' + escapeJson($('f-bio').value.trim()) +
    '","A":"' + escapeJson(addr || '') +
    '"}}'
  );
}

function buildEncoded() {
  if (!state.key) throw new Error('No key loaded — generate or import in ⚙');
  if (!state.mycall) throw new Error('Set callsign in ⚙');
  const submode = parseInt($('f-submode').value, 10);
  const centre = parseFloat($('f-centre').value) || 1500;
  const seq = Math.floor(Math.random() * 32);
  let samples;
  if (state.cardType === 'qsl') {
    samples = encode_qsl_v1(buildQslInput(), state.key.secret_hex, centre, submode, seq);
  } else {
    samples = encode_adv_v1(buildAdvInput(), state.key.secret_hex, centre, submode, seq);
  }
  return { samples, centre, submode, seq };
}

function setStatus(msg) {
  $('status-line').textContent = msg;
  console.log('[uvpacket-web]', msg);
}

$('tx-btn').onclick = async () => {
  let r;
  try {
    r = buildEncoded();
  } catch (e) {
    alert(e.message || String(e));
    return;
  }
  setStatus(`TX: ${r.samples.length} samples (${(r.samples.length / 12000).toFixed(2)} s) at ${r.centre} Hz`);
  $('tx-btn').disabled = true;
  $('tx-btn').textContent = 'Transmitting…';
  try {
    const outDev = localStorage.getItem('uvpacket-audio-out') || '';
    await audioOut.play(r.samples, outDev);
    // Trigger decode passes on the post-TX snapshot. Two staggered passes
    // because (1) speaker→mic round-trip is 100–300 ms so the burst tail
    // may still be flushing into the ring buffer when play() resolves;
    // (2) browsers often apply AEC to the first ~500 ms of mic input
    // after a speaker burst, so a delayed snapshot picks up cleaner
    // captured audio. If the first pass already lit up, the second is
    // skipped via decodeInFlight.
    if (state.listening) {
      setStatus('TX done — running post-TX decode.');
      // `force` bypasses the silent-skip energy gate so the post-TX
      // path always runs even if AEC suppressed the captured echo.
      setTimeout(() => runDecode('post-tx-1-force'), 200);
      setTimeout(() => runDecode('post-tx-2-force'), 1200);
    } else {
      setStatus('TX done.');
    }
  } finally {
    $('tx-btn').disabled = false;
    $('tx-btn').textContent = 'Sign & Transmit';
  }
};

// Loopback test: encode → feed straight to the decoder worker, no audio
// I/O. Validates the WASM TX/RX chain end-to-end without depending on
// the speaker→mic acoustic path or radio.
let loopbackInFlight = false;
$('loopback-btn').onclick = async () => {
  if (loopbackInFlight) {
    console.log('[uvpacket-web] loopback already in flight; ignoring click');
    return;
  }
  let r;
  try {
    r = buildEncoded();
  } catch (e) {
    alert(e.message || String(e));
    return;
  }
  loopbackInFlight = true;
  $('loopback-btn').disabled = true;
  setStatus(`Loopback: ${r.samples.length} samples to decoder…`);
  console.log('[uvpacket-web] loopback start, mode=', state.mode, 'centre=', r.centre);
  const samplesCopy = new Float32Array(r.samples);
  const payload = state.mode === 'fm'
    ? {
        type: 'decode-fm',
        samples: samplesCopy,
        audio_centre_hz: r.centre,
        // QSL_LAYOUTS bounds the sweep at ~20 attempts, well under
        // the timeout. The exact (mode, n_blocks) the loopback just
        // encoded is in there.
        layouts: QSL_LAYOUTS,
      }
    : { type: 'decode-ssb', samples: samplesCopy, band_lo: 300, band_hi: 2700, step: 50, peak_rel: 0.7 };
  try {
    const reply = await decoderRequest(payload, [samplesCopy.buffer]);
    console.log('[uvpacket-web] loopback reply', reply);
    if (reply.type === 'decoded') {
      setStatus(`Loopback: ${reply.frames.length} frame(s) decoded.`);
      for (const f of reply.frames) appendDecoded(f, { force: true });
    } else if (reply.type === 'error') {
      setStatus('Loopback decoder error: ' + reply.error);
    }
  } finally {
    loopbackInFlight = false;
    $('loopback-btn').disabled = false;
  }
};

// ───────────────────────────── RX path ─────────────────────────────────

// Captured audio sample rate. We *request* 12 kHz from AudioContext but
// some browsers/devices ignore the request and fall back to the device's
// native rate (typically 48 kHz). The worklet posts its actual rate up
// at construction; we use it to (a) drive the waterfall Hz axis and
// (b) resample snapshot samples to 12 kHz before handing them to the
// WASM uvpacket decoder, which is hardwired to 12 kHz.
let captureRate = 12000;

const cap = new UvAudioCapture({
  onWaterfall: (chunk) => pushWaterfall(chunk),
  onPeak: (p) => {
    $('vu-bar').style.width = Math.min(100, p * 100) + '%';
  },
  // Waterfall path's actual sample rate (worklet decimates 12 k → 6 k
  // by default; this is the rate the FFT in the Waterfall class sees).
  onSampleRate: (rate) => {
    setupWaterfall(rate);
  },
  // Snapshot path's actual rate. mfsk-core's uvpacket decoder is
  // hardcoded to 12 kHz; if the AudioContext didn't honour our
  // requested rate, we resample before sending to the decoder.
  onSnapshotRate: (rate) => {
    captureRate = rate;
    if (rate !== 12000) {
      setStatus(`Note: capture is ${rate} Hz, not 12000 — auto-resampling for decoder.`);
    }
  },
});

// Linear-interpolation resampler. Cheap; fine for destination 12 kHz
// since the source is already bandlimited by the device's analog/ADC
// chain to well below 6 kHz of interest.
function resampleTo12k(input, srcRate) {
  if (srcRate === 12000) return input;
  const ratio = srcRate / 12000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = i * ratio;
    const i0 = Math.floor(s);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = s - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

let decodeTimer = null;

$('listen-btn').onclick = async () => {
  if (state.listening) {
    state.listening = false;
    $('listen-btn').textContent = '▶ Listen';
    $('listen-btn').classList.remove('on');
    await cap.stop();
    if (decodeTimer) clearInterval(decodeTimer);
    decodeTimer = null;
    return;
  }
  const inDev = localStorage.getItem('uvpacket-audio-in') || '';
  if (!inDev) {
    setStatus('Pick an audio input device in ⚙ first.');
    dlg.showModal();
    return;
  }
  try {
    await cap.start(inDev);
    state.listening = true;
    $('listen-btn').textContent = '■ Stop';
    $('listen-btn').classList.add('on');
    setStatus(`Listening on input ${inDev.slice(0, 8)}…`);
    // 2.5 s — combined with the audio energy gate, idle CPU stays near
    // zero. Active decode passes still complete inside one interval
    // (~500 ms even for SSB sweep).
    decodeTimer = setInterval(runDecode, 2500);
  } catch (e) {
    alert('Mic access failed: ' + e);
  }
};

let decodeInFlight = false;
let decodePassCount = 0;
// Layout subset for FM single-station decode. mode_code: 0=Robust,
// 1=Standard, 2=Fast, 3=Express. Order = priority (first success
// wins). Standard with `n_blocks ≈ 19` is the typical signed-QSL
// frame; widen to 16-26 to cover variations.
const QSL_LAYOUTS = (() => {
  const layouts = [];
  for (const nb of [19, 22, 16, 24, 18, 20, 26, 21, 17, 23, 25, 15]) {
    layouts.push([1, nb]); // Standard
  }
  for (const nb of [19, 22, 16, 24, 18, 20, 26]) {
    layouts.push([0, nb]); // Robust fallback
  }
  return layouts;
})();

// Permissive amplitude floor — anything quieter than this is almost
// certainly DC-only / fully muted input, no point invoking the worker.
// The real CPU defence is in mfsk-core 0.3.4's `rx::decode` sync
// outlier check (rejects pure-noise buffers in ~330 µs); this is just
// a "do nothing on a flat-zero buffer" early exit so the worker doesn't
// spin up a structuredClone of 84 000 zeros on idle.
const ENERGY_GATE = 0.0005;

async function runDecode(label = '') {
  if (decodeInFlight) return;
  decodeInFlight = true;
  let samples = await cap.snapshot(7);
  if (samples.length < 12000) {
    decodeInFlight = false;
    return;
  }
  // Force the decoder input to 12 kHz regardless of what the
  // AudioContext actually negotiated.
  const rawLen = samples.length;
  if (captureRate !== 12000) samples = resampleTo12k(samples, captureRate);
  // Extra detail in the console about every snapshot: rate, length
  // (post-resample), and peak amplitude. Lets the user diagnose
  // whether the mic is picking up the burst at all without having to
  // open the WF in another tool.
  console.log(
    `[uvpacket-web] snapshot raw=${rawLen}@${captureRate}Hz → decoder=${samples.length}@12000Hz`,
  );
  // Snapshot peak — used both as a CPU gate and as a diagnostic on
  // success / miss. If the post-TX peak is < 0.01 the mic basically
  // didn't hear the speaker; if it's saturated near 1.0 the AGC may
  // have compressed the burst.
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i];
    if (a > peak) peak = a;
  }
  if (peak < ENERGY_GATE && !label.includes('force')) {
    decodeInFlight = false;
    return;
  }
  console.log(`[uvpacket-web] decoding label=${label || 'idle'} peak=${peak.toFixed(4)}`);
  const pass = ++decodePassCount;
  const t0 = performance.now();
  const tag = label ? ` [${label}]` : '';

  // Pre-decode sync diagnostic for FM — cheap (~100 µs) and tells us
  // why the mfsk-core gate is or isn't firing on real-world audio.
  // ratio < 20 → gate rejects (decode should return ~0 ms);
  // ratio ≥ 20 → LDPC sweep runs (potentially seconds on noise).
  if (state.mode === 'fm') {
    const centreHz = parseFloat($('f-centre').value) || 1500;
    const diagSamples = new Float32Array(samples);
    const diag = await decoderRequest(
      { type: 'diag-sync', samples: diagSamples, audio_centre_hz: centreHz },
      [diagSamples.buffer],
      3000,
    );
    if (diag.type === 'sync-stats') {
      const [mx, med, ratio, n] = diag.stats;
      console.log(
        `[uvpacket-web] sync centre=${centreHz} max=${mx.toExponential(2)} median=${med.toExponential(2)} ratio=${ratio.toFixed(1)} (gate=20) n=${n}`,
      );
    }
  }

  const payload = state.mode === 'fm'
    ? {
        type: 'decode-fm',
        samples,
        audio_centre_hz: parseFloat($('f-centre').value) || 1500,
        // Constrain to layouts uvpacket-web's signed-QSL use case
        // actually produces. Mode codes: 0=Robust, 1=Standard, 2=Fast,
        // 3=Express. QSL JSON+sig payload is ~210-300 bytes, so
        // n_blocks ≈ 18-26 covers everything plausible. Caps worst-
        // case decode work at ~22 LDPC attempts per peak in WASM
        // (≈ 1 s) instead of the full 128-attempt sweep that timed
        // out the worker on partially-coherent acoustic-loopback
        // signals.
        layouts: QSL_LAYOUTS,
      }
    // 50 Hz coarse step (default mfsk-core is 25 Hz) and stricter
    // peak threshold 0.7 (default 0.5) — both halve the per-pass
    // worst-case decode work and, more importantly, reject the dozens
    // of weak false peaks that an idle-noise snapshot produces and
    // each of which would otherwise eat a 4 mode × 32 n_blocks LDPC
    // BP+OSD-2 sweep before being rejected.
    : { type: 'decode-ssb', samples, band_lo: 300, band_hi: 2700, step: 50, peak_rel: 0.7 };
  const reply = await decoderRequest(payload, [samples.buffer]);
  decodeInFlight = false;
  const ms = Math.round(performance.now() - t0);
  if (reply.type === 'decoded') {
    const n = reply.frames.length;
    if (n > 0) {
      setStatus(`RX${tag} pass ${pass}: ${n} frame(s) in ${ms} ms (peak ${peak.toFixed(3)})`);
      for (const f of reply.frames) appendDecoded(f);
    } else {
      console.log(
        `[uvpacket-web] RX${tag} pass ${pass}: 0 frames (${ms} ms, peak ${peak.toFixed(3)})`,
      );
    }
  } else if (reply.type === 'error') {
    setStatus('Decoder error: ' + reply.error);
    console.error('[uvpacket-web] decoder error:', reply.error);
  }
}

const seenSigs = new Set();
function appendDecoded(f, opts = {}) {
  if (!f.sig_b64) return;
  // k256 produces deterministic ECDSA signatures (RFC 6979), so same
  // key + same JSON = identical sig_b64. The dedup avoids spamming the
  // log with the same acoustic burst captured across multiple
  // overlapping snapshots — but it must be skipped for explicit
  // loopback clicks, otherwise pressing 🔁 N times only shows one card.
  const key = f.json + f.sig_b64;
  if (!opts.force && seenSigs.has(key)) return;
  seenSigs.add(key);

  const card = document.createElement('div');
  card.className = 'card ' + (f.verified ? 'verified' : 'invalid');
  const head = document.createElement('div');
  head.className = 'head';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = f.verified ? `✓ ${f.card_kind || 'frame'}` : '⚠ unverified';
  head.appendChild(badge);
  const fr = parseFr(f.json);
  const headLine = document.createElement('span');
  headLine.textContent = headlineFor(f, fr);
  head.appendChild(headLine);
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  head.appendChild(time);
  card.appendChild(head);

  const row2 = document.createElement('div');
  row2.className = 'row2';
  row2.textContent = summaryFor(f);
  card.appendChild(row2);

  if (f.verified) {
    const row3 = document.createElement('div');
    row3.className = 'row3';
    row3.innerHTML =
      `<span style="color:var(--accent)">M:</span> ${f.addr_m}<br>` +
      `<span style="color:var(--accent)">mona1:</span> ${f.addr_mona1}<br>` +
      `<span style="color:var(--accent)">centre:</span> ${f.audio_centre_hz.toFixed(1)} Hz`;
    card.appendChild(row3);
  }

  card.onclick = () => {
    const open = card.dataset.open === '1';
    if (open) {
      card.dataset.open = '0';
      card.querySelector('.json-dump')?.remove();
    } else {
      card.dataset.open = '1';
      const dump = document.createElement('div');
      dump.className = 'row3 json-dump';
      dump.style.marginTop = 'var(--sp-sm)';
      dump.innerHTML =
        `<b>JSON</b><br>${escapeHtml(f.json)}<br><br>` +
        `<b>Signature</b><br>${f.sig_b64}`;
      card.appendChild(dump);
    }
  };

  $('log').prepend(card);
}

function escapeHtml(s) {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}

function parseFr(json) {
  const m = json.match(/"FR":"([^"]+)"/);
  return m ? m[1] : '?';
}

function headlineFor(f, fr) {
  if (f.card_kind === 'QSL') {
    const to = (f.json.match(/"C":"([^"]*)"/) || [, '?'])[1];
    return ` ${fr} → ${to}`;
  } else if (f.card_kind === 'ADV') {
    const name = (f.json.match(/"N":"([^"]*)"/) || [, ''])[1];
    return ` ${fr}  ${name}`;
  }
  return ` ${fr}`;
}

function summaryFor(f) {
  if (f.card_kind === 'QSL') {
    const rs = (f.json.match(/"S":"([^"]*)"/) || [, ''])[1];
    const qth = (f.json.match(/"P":"([^"]*)"/) || [, ''])[1];
    const freq = (f.json.match(/"F":"([^"]*)"/) || [, ''])[1];
    return `RS ${rs} · ${freq} MHz · ${qth}`;
  } else if (f.card_kind === 'ADV') {
    const bio = (f.json.match(/"B":"([^"]*)"/) || [, ''])[1];
    return bio;
  }
  return '';
}

// ───────────────────────────── Slot survey (SSB TX) ────────────────────

$('scan-slots-btn').onclick = async () => {
  if (!state.listening) {
    alert('Start ▶ Listen first to capture audio for the slot survey.');
    return;
  }
  let samples = await cap.snapshot(2);
  if (samples.length < 12000) return;
  if (captureRate !== 12000) samples = resampleTo12k(samples, captureRate);
  const reply = await decoderRequest(
    { type: 'measure-slots', samples, band_lo: 300, band_hi: 2700, slot: 1200 },
    [samples.buffer],
  );
  if (reply.type === 'slots') renderSlots(reply.slots);
};

function renderSlots(slots) {
  const wrap = $('slot-survey');
  wrap.innerHTML = '';
  if (slots.length === 0) return;
  const minMag = Math.min(...slots.map((s) => s.magnitude));
  for (const s of slots) {
    const free = s.magnitude < minMag * 5; // heuristic
    const el = document.createElement('div');
    el.className = 'slot-bar ' + (free ? 'free' : 'busy');
    el.innerHTML = `${s.centre_hz.toFixed(0)} Hz<br>${free ? 'free' : 'busy'}`;
    el.onclick = () => {
      $('f-centre').value = s.centre_hz.toFixed(0);
    };
    wrap.appendChild(el);
  }
  wrap.style.display = 'flex';
}

// ───────────────────────────── Waterfall (ft8-web class) ──────────────

import { Waterfall } from './waterfall.js';

const wfCanvas = $('wf');
let waterfall = null; // initialised once we know the worklet's
                     // waterfall sample rate (defaults 6 kHz).

function setupWaterfall(sampleRate) {
  // Match canvas backing-store size to its CSS size × DPR.
  const dpr = window.devicePixelRatio || 1;
  const rect = wfCanvas.getBoundingClientRect();
  wfCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  wfCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  if (!waterfall) {
    waterfall = new Waterfall(wfCanvas, {
      sampleRate: sampleRate || 6000,
      fftSize: 1024,
      freqMin: 100,
      freqMax: 3000,
    });
  } else {
    waterfall.setSampleRate(sampleRate || 6000);
  }
  redrawCentreMarker();
}
window.addEventListener('resize', () => setupWaterfall());

function pushWaterfall(chunk) {
  if (!waterfall) setupWaterfall();
  waterfall.pushSamples(chunk);
  redrawCentreMarker();
}

// We want a TX/RX centre marker (FM) or 1200 Hz slot markers (SSB) on
// top of the waterfall. ft8-web's Waterfall class draws its own
// non-scrolling overlay canvas via `targetLine` / `dfLine`; we reuse
// `targetLine` for the FM centre and emulate slot markers by drawing
// directly into our own `wf-overlay` canvas (which sits above ft8-web's
// overlay because of DOM order).
function redrawCentreMarker() {
  if (!waterfall) return;
  if (state.mode === 'ssb') {
    waterfall.targetLine = null; // hide FM marker
  } else {
    const centre = parseFloat($('f-centre').value) || 1500;
    waterfall.targetLine = centre;
  }
  // Force an axis/overlay refresh.
  waterfall.drawFreqAxis?.();
}
$('f-centre').addEventListener('input', redrawCentreMarker);

// ───────────────────────────── Audio device pickers ───────────────────

async function populateAudioDevices() {
  const inSel = $('set-audio-in');
  const outSel = $('set-audio-out');
  if (!inSel || !outSel) return; // settings dialog not in this page
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {
    console.warn('[uvpacket-web] enumerateDevices:', e);
    return;
  }
  inSel.innerHTML = '<option value="">— select input —</option>';
  outSel.innerHTML = '<option value="">— default —</option>';
  for (const d of devices) {
    if (d.kind === 'audioinput') {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
      inSel.appendChild(opt);
    } else if (d.kind === 'audiooutput') {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Output ${d.deviceId.slice(0, 8)}`;
      outSel.appendChild(opt);
    }
  }
  const savedIn = localStorage.getItem('uvpacket-audio-in') || '';
  const savedOut = localStorage.getItem('uvpacket-audio-out') || '';
  if (savedIn) inSel.value = savedIn;
  if (savedOut) outSel.value = savedOut;
}

// Defensive `?.` bindings: if a stale cached index.html is served
// without the audio dialog elements, the app should still boot and the
// loopback / TX paths should work without exploding at module top
// level.
const micGrantBtn = $('set-mic-grant');
if (micGrantBtn) {
  micGrantBtn.addEventListener('click', async () => {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch (e) {
      alert('Mic permission failed: ' + e);
      return;
    }
    await populateAudioDevices();
  });
}

const audioInSel = $('set-audio-in');
if (audioInSel) {
  audioInSel.onchange = (e) => {
    localStorage.setItem('uvpacket-audio-in', e.target.value || '');
  };
}
const audioOutSel = $('set-audio-out');
if (audioOutSel) {
  audioOutSel.onchange = (e) => {
    localStorage.setItem('uvpacket-audio-out', e.target.value || '');
  };
}

const txGainSlider = $('set-tx-gain');
const txGainVal = $('set-tx-gain-val');
function applyTxGain() {
  if (!txGainSlider) return;
  const v = parseInt(txGainSlider.value, 10);
  if (txGainVal) txGainVal.textContent = v + '%';
  audioOut.setGain(v / 100);
  localStorage.setItem('uvpacket-tx-gain', String(v));
}
if (txGainSlider) txGainSlider.oninput = applyTxGain;

// ───────────────────────────── Boot ────────────────────────────────────

window.addEventListener('error', (e) => {
  console.error('[uvpacket-web] uncaught:', e.error || e.message);
  setStatus('Uncaught error: ' + (e.message || e));
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[uvpacket-web] unhandled rejection:', e.reason);
  setStatus('Unhandled rejection: ' + (e.reason?.message || e.reason));
});

(async () => {
 try {
  await bootWasm();
  const slot = await loadActive();
  if (slot) {
    $('set-mycall').value = slot.mycall || '';
    $('set-addr-type').value = slot.active_addr_type || 'm';
    applyKey(
      {
        secret_hex: slot.secret_hex,
        pubkey_hex: slot.pubkey_hex,
        addr_m: slot.addr_m,
        addr_p: slot.addr_p,
        addr_mona1: slot.addr_mona1,
      },
      slot.mycall || '',
      slot.active_addr_type || 'm',
    );
  }
  setupWaterfall();
  // Default-fill date/time
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10);
  const hm = now.toISOString().slice(11, 16);
  $('f-date').value = ymd;
  $('f-time').value = hm;

  // Audio devices + TX gain. Browsers won't expose device labels until
  // a getUserMedia({audio: true}) has succeeded at least once, so we
  // try a non-prompting enumerate first; the user can re-trigger via
  // ⚙ → Grant for permission + labels.
  await populateAudioDevices();
  const savedGain = parseInt(localStorage.getItem('uvpacket-tx-gain') || '80', 10);
  txGainSlider.value = String(savedGain);
  applyTxGain();

  console.log('uvpacket-web', APP_VERSION, 'ready');
 } catch (e) {
  console.error('[uvpacket-web] boot failed:', e);
  setStatus('Boot failed: ' + (e?.message || e));
 }
})();

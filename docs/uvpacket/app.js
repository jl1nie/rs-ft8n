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

const APP_VERSION = '0.1.0';

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
let decoderReady = new Promise((resolve) => {
  decoder.addEventListener('message', function once(e) {
    if (e.data.type === 'ready') {
      decoder.removeEventListener('message', once);
      resolve();
    }
  });
});

async function bootWasm() {
  await init();
  decoder.addEventListener('error', (e) => {
    console.error('[uvpacket-web] worker error event:', e);
    setStatus('Worker error — see console.');
  });
  decoder.addEventListener('messageerror', (e) => {
    console.error('[uvpacket-web] worker messageerror:', e);
  });
  decoder.postMessage({ type: 'init' });
  await decoderReady;
  setStatus('Decoder ready.');
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
    await audioOut.play(r.samples);
    // Trigger an immediate decode on whatever the mic captured during TX,
    // skipping the next setInterval window so we don't miss the burst.
    if (state.listening) {
      setStatus('TX done — running post-TX decode.');
      runDecode();
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
$('loopback-btn').onclick = async () => {
  let r;
  try {
    r = buildEncoded();
  } catch (e) {
    alert(e.message || String(e));
    return;
  }
  setStatus(`Loopback: ${r.samples.length} samples to decoder…`);
  const samplesCopy = new Float32Array(r.samples);
  const replyHandler = (e) => {
    if (e.data.type === 'decoded') {
      decoder.removeEventListener('message', replyHandler);
      const n = e.data.frames.length;
      setStatus(`Loopback: ${n} frame(s) decoded.`);
      for (const f of e.data.frames) appendDecoded(f);
    } else if (e.data.type === 'error') {
      decoder.removeEventListener('message', replyHandler);
      setStatus('Loopback decoder error: ' + e.data.error);
    }
  };
  decoder.addEventListener('message', replyHandler);
  if (state.mode === 'fm') {
    decoder.postMessage(
      { type: 'decode-fm', samples: samplesCopy, audio_centre_hz: r.centre },
      [samplesCopy.buffer],
    );
  } else {
    decoder.postMessage(
      { type: 'decode-ssb', samples: samplesCopy, band_lo: 300, band_hi: 2700, step: 25 },
      [samplesCopy.buffer],
    );
  }
};

// ───────────────────────────── RX path ─────────────────────────────────

const cap = new UvAudioCapture({
  onWaterfall: (chunk) => pushWaterfall(chunk),
  onPeak: (p) => {
    $('vu-bar').style.width = Math.min(100, p * 100) + '%';
  },
});

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
  try {
    await cap.start();
    state.listening = true;
    $('listen-btn').textContent = '■ Stop';
    $('listen-btn').classList.add('on');
    decodeTimer = setInterval(runDecode, 1500);
  } catch (e) {
    alert('Mic access failed: ' + e);
  }
};

let decodeInFlight = false;
let decodePassCount = 0;
async function runDecode() {
  if (decodeInFlight) return;
  decodeInFlight = true;
  const samples = await cap.snapshot(6);
  if (samples.length < 12000) {
    decodeInFlight = false;
    return;
  }
  const pass = ++decodePassCount;
  const t0 = performance.now();
  const replyHandler = (e) => {
    if (e.data.type === 'decoded') {
      decoder.removeEventListener('message', replyHandler);
      decodeInFlight = false;
      const n = e.data.frames.length;
      const ms = Math.round(performance.now() - t0);
      if (n > 0) {
        setStatus(`RX pass ${pass}: ${n} frame(s) in ${ms} ms`);
        for (const f of e.data.frames) appendDecoded(f);
      } else {
        // Only update the status line on detected energy, otherwise the
        // "no frame" message would clobber TX status; just log instead.
        console.log(`[uvpacket-web] RX pass ${pass}: 0 frames (${ms} ms, ${samples.length} samples)`);
      }
    } else if (e.data.type === 'error') {
      decoder.removeEventListener('message', replyHandler);
      decodeInFlight = false;
      setStatus('Decoder error: ' + e.data.error);
      console.error('[uvpacket-web] decoder error:', e.data.error);
    }
  };
  decoder.addEventListener('message', replyHandler);
  if (state.mode === 'fm') {
    const centre = parseFloat($('f-centre').value) || 1500;
    decoder.postMessage(
      { type: 'decode-fm', samples, audio_centre_hz: centre },
      [samples.buffer],
    );
  } else {
    decoder.postMessage(
      { type: 'decode-ssb', samples, band_lo: 300, band_hi: 2700, step: 25 },
      [samples.buffer],
    );
  }
}

const seenSigs = new Set();
function appendDecoded(f) {
  if (!f.sig_b64) return;
  const key = f.json + f.sig_b64;
  if (seenSigs.has(key)) return;
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
  const samples = await cap.snapshot(2);
  if (samples.length < 12000) return;
  const replyHandler = (e) => {
    if (e.data.type === 'slots') {
      decoder.removeEventListener('message', replyHandler);
      renderSlots(e.data.slots);
    }
  };
  decoder.addEventListener('message', replyHandler);
  decoder.postMessage(
    { type: 'measure-slots', samples, band_lo: 300, band_hi: 2700, slot: 1200 },
    [samples.buffer],
  );
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

// ───────────────────────────── Waterfall ───────────────────────────────

const wfCanvas = $('wf');
const wfOverlay = $('wf-overlay');
const FFT_SIZE = 512;
let wfCtx = null;
let overlayCtx = null;
let wfRows = null;
let wfImg = null;
let inputBuf = new Float32Array(0);

function setupWaterfall() {
  const dpr = window.devicePixelRatio || 1;
  const rect = wfCanvas.getBoundingClientRect();
  for (const c of [wfCanvas, wfOverlay]) {
    c.width = Math.floor(rect.width * dpr);
    c.height = Math.floor(rect.height * dpr);
  }
  wfCtx = wfCanvas.getContext('2d');
  overlayCtx = wfOverlay.getContext('2d');
  wfImg = wfCtx.createImageData(wfCanvas.width, 1);
  wfRows = wfCanvas.height;
  redrawSlotMarkers();
}
window.addEventListener('resize', setupWaterfall);

function pushWaterfall(chunk) {
  if (!wfCtx) setupWaterfall();
  // Accumulate up to FFT_SIZE samples then run FFT.
  if (inputBuf.length < FFT_SIZE) {
    const merged = new Float32Array(inputBuf.length + chunk.length);
    merged.set(inputBuf);
    merged.set(chunk, inputBuf.length);
    inputBuf = merged;
  } else {
    const tail = new Float32Array(FFT_SIZE - chunk.length);
    tail.set(inputBuf.slice(inputBuf.length - tail.length));
    const merged = new Float32Array(FFT_SIZE);
    merged.set(tail);
    merged.set(chunk, tail.length);
    inputBuf = merged;
  }
  if (inputBuf.length < FFT_SIZE) return;
  drawWaterfallRow(inputBuf.slice(inputBuf.length - FFT_SIZE));
  inputBuf = new Float32Array(0);
}

// Real-input radix-2 FFT (small, simple, runs on every row).
function fftMag(input) {
  const n = input.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = input[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  // Bit-reverse
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }
  for (let s = 1; (1 << s) <= n; s++) {
    const m = 1 << s;
    const m2 = m >> 1;
    const wstep = (-2 * Math.PI) / m;
    for (let k = 0; k < n; k += m) {
      for (let l = 0; l < m2; l++) {
        const t = wstep * l;
        const wr = Math.cos(t), wi = Math.sin(t);
        const tr = wr * re[k + l + m2] - wi * im[k + l + m2];
        const ti = wr * im[k + l + m2] + wi * re[k + l + m2];
        re[k + l + m2] = re[k + l] - tr;
        im[k + l + m2] = im[k + l] - ti;
        re[k + l] += tr;
        im[k + l] += ti;
      }
    }
  }
  const half = n / 2;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  return mag;
}

function drawWaterfallRow(samples) {
  const mag = fftMag(samples);
  // Map FFT bins (0..N/2 → 0..6 kHz at 12 kHz sample rate) onto the
  // canvas width 0..3 kHz visible range. We display 0..3000 Hz.
  const w = wfCanvas.width;
  const halfBin = mag.length;
  const maxBinHz = 6000;
  const visibleHz = 3000;
  const visibleBins = Math.floor((visibleHz / maxBinHz) * halfBin);
  const data = wfImg.data;
  for (let x = 0; x < w; x++) {
    const bin = Math.floor((x / w) * visibleBins);
    const v = mag[bin] || 0;
    const db = 20 * Math.log10(v + 1e-9);
    const norm = Math.max(0, Math.min(1, (db + 40) / 60));
    const c = palette(norm);
    data[x * 4 + 0] = c[0];
    data[x * 4 + 1] = c[1];
    data[x * 4 + 2] = c[2];
    data[x * 4 + 3] = 255;
  }
  // Scroll the canvas up by 1 row, draw new row at bottom.
  wfCtx.drawImage(wfCanvas, 0, -1);
  wfCtx.putImageData(wfImg, 0, wfCanvas.height - 1);
  redrawSlotMarkers();
}

function palette(t) {
  // Simple black → green → yellow gradient.
  const r = Math.floor(255 * Math.max(0, Math.min(1, 2 * t - 1)));
  const g = Math.floor(255 * Math.max(0, Math.min(1, 2 * t)));
  return [r, g, 0];
}

function hzToCanvasX(hz) {
  return Math.floor((hz / 3000) * wfCanvas.width);
}
function redrawSlotMarkers() {
  if (!overlayCtx) return;
  overlayCtx.clearRect(0, 0, wfOverlay.width, wfOverlay.height);
  if (state.mode === 'ssb') {
    // Show 1200 Hz slot grid markers.
    overlayCtx.strokeStyle = 'rgba(118,255,3,0.5)';
    overlayCtx.lineWidth = 1;
    for (const f of [800, 2000]) {
      const x = hzToCanvasX(f);
      overlayCtx.beginPath();
      overlayCtx.moveTo(x, 0);
      overlayCtx.lineTo(x, wfOverlay.height);
      overlayCtx.stroke();
    }
  } else {
    // FM: single-station marker at the configured centre.
    const centre = parseFloat($('f-centre').value) || 1500;
    overlayCtx.strokeStyle = 'rgba(118,255,3,0.7)';
    overlayCtx.lineWidth = 2;
    const x = hzToCanvasX(centre);
    overlayCtx.beginPath();
    overlayCtx.moveTo(x, 0);
    overlayCtx.lineTo(x, wfOverlay.height);
    overlayCtx.stroke();
  }
}
$('f-centre').addEventListener('input', redrawSlotMarkers);

// ───────────────────────────── Boot ────────────────────────────────────

(async () => {
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
  console.log('uvpacket-web', APP_VERSION, 'ready');
})();

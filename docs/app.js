import init, { decode_wav, decode_wav_subtract, decode_sniper, encode_ft8 } from './ft8_web.js';
import { Waterfall } from './waterfall.js';
import { AudioCapture } from './audio-capture.js';
import { AudioOutput } from './audio-output.js';
import { FT8PeriodManager } from './ft8-period.js';
import { QsoManager, QSO_STATE } from './qso.js';
import { CatController } from './cat.js';
import { QsoLog } from './qso-log.js';

// ── Elements ────────────────────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const timingEl = document.getElementById('timing');
const resultsTable = document.getElementById('results');
const tbody = resultsTable.querySelector('tbody');
const subtractCheck = document.getElementById('subtract-mode');
const wfCanvas = document.getElementById('waterfall');
const wfWrap = document.getElementById('waterfall-wrap');
const deviceSelect = document.getElementById('audio-device');
const btnStart = document.getElementById('btn-start');
const timerEl = document.getElementById('period-timer');
const btnSnipe = document.getElementById('btn-snipe');
const snipeCallInput = document.getElementById('snipe-call');
const btnAp = document.getElementById('btn-ap');
const snipeStatusEl = document.getElementById('snipe-status');
const snipeOverlay = document.getElementById('snipe-overlay');
const snipeFreqLabel = document.getElementById('snipe-freq-label');

// QSO panel
const myCallInput = document.getElementById('my-call');
const myGridInput = document.getElementById('my-grid');
const qsoStateEl = document.getElementById('qso-state');
const qsoTxMsgEl = document.getElementById('qso-tx-msg');
const btnCq = document.getElementById('btn-cq');
const btnTx = document.getElementById('btn-tx');
const autoQsoCheck = document.getElementById('auto-qso');
const btnQsoReset = document.getElementById('btn-qso-reset');
const btnCat = document.getElementById('btn-cat');
const catStatusEl = document.getElementById('cat-status');

// ── Waterfall setup ─────────────────────────────────────────────────────────
function resizeCanvas() {
  wfCanvas.width = wfCanvas.clientWidth;
  wfCanvas.height = wfCanvas.clientHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const waterfall = new Waterfall(wfCanvas);
const FREQ_MIN = 200, FREQ_MAX = 2800;

// ── Audio output + CAT + QSO ────────────────────────────────────────────────
const audioOut = new AudioOutput();
const cat = new CatController();
const qsoLog = new QsoLog();

// Restore saved settings
myCallInput.value = localStorage.getItem('rs-ft8n-mycall') || '';
myGridInput.value = localStorage.getItem('rs-ft8n-mygrid') || '';
myCallInput.addEventListener('change', () => localStorage.setItem('rs-ft8n-mycall', myCallInput.value));
myGridInput.addEventListener('change', () => localStorage.setItem('rs-ft8n-mygrid', myGridInput.value));

const qso = new QsoManager({
  myCall: myCallInput.value,
  myGrid: myGridInput.value,
  onStateChange: (state) => {
    qsoStateEl.textContent = state;
    const tx = qso.getNextTx();
    qsoTxMsgEl.textContent = tx ? qso.formatTx(tx) : '';
    // Log when QSO completes (FINAL → IDLE with dxCall still set)
    if (state === QSO_STATE.IDLE && qso.dxCall) {
      qsoLog.add({
        dxCall: qso.dxCall, dxGrid: qso.dxGrid,
        txReport: qso.txReport, rxReport: qso.rxReport,
        freq: snipeMode ? snipeFreq : 1500,
      });
      statusEl.textContent = `QSO complete: ${qso.dxCall}`;
    }
  },
  onTxReady: (c1, c2, rpt) => {
    qsoTxMsgEl.textContent = `${c1} ${c2} ${rpt}`.trim();
  },
});

// Keep QSO manager in sync with input fields
myCallInput.addEventListener('input', () => qso.setMyInfo(myCallInput.value, myGridInput.value));
myGridInput.addEventListener('input', () => qso.setMyInfo(myCallInput.value, myGridInput.value));

// ── QSO buttons ─────────────────────────────────────────────────────────────
btnCq.addEventListener('click', () => {
  qso.setMyInfo(myCallInput.value, myGridInput.value);
  const tx = qso.callCq();
  qsoTxMsgEl.textContent = qso.formatTx(tx);
});

const btnHalt = document.getElementById('btn-halt');

btnHalt.addEventListener('click', () => {
  periodMgr.cancelTx();
  audioOut.stop();
  if (cat.connected) { cat.ptt(false).catch(() => {}); }
  btnTx.classList.remove('tx-active');
  statusEl.textContent = 'TX halted';
});

btnQsoReset.addEventListener('click', () => {
  periodMgr.cancelTx();
  audioOut.stop();
  if (cat.connected) { cat.ptt(false).catch(() => {}); }
  btnTx.classList.remove('tx-active');
  qso.reset();
  qsoTxMsgEl.textContent = '';
  statusEl.textContent = 'QSO reset';
});

btnTx.addEventListener('click', async () => {
  const tx = qso.getNextTx();
  if (!tx) { statusEl.textContent = 'No TX message ready'; return; }
  await transmit(tx.call1, tx.call2, tx.report);
});

async function transmit(call1, call2, report, freq) {
  if (!wasmReady) return;
  freq = freq || (snipeMode ? snipeFreq : 1500);
  try {
    statusEl.textContent = `TX: ${call1} ${call2} ${report}`;
    btnTx.classList.add('tx-active');

    const samples = encode_ft8(call1, call2, report, freq);

    // PTT ON
    if (cat.connected) { await cat.ptt(true); }

    // Play audio
    await audioOut.play(samples);

    // PTT OFF
    if (cat.connected) { await cat.ptt(false); }

    btnTx.classList.remove('tx-active');
    statusEl.textContent = `TX complete: ${call1} ${call2} ${report}`;
  } catch (e) {
    btnTx.classList.remove('tx-active');
    statusEl.textContent = `TX error: ${e.message || e}`;
    if (cat.connected) { try { await cat.ptt(false); } catch (_) {} }
  }
}

// ── CAT control ─────────────────────────────────────────────────────────────
btnCat.addEventListener('click', async () => {
  if (cat.connected) {
    await cat.disconnect();
    btnCat.classList.remove('connected');
    catStatusEl.textContent = 'disconnected';
    return;
  }
  if (!CatController.isSupported()) {
    catStatusEl.textContent = 'Web Serial not supported';
    return;
  }
  try {
    const proto = document.getElementById('cat-protocol').value;
    await cat.requestPort();
    await cat.connect({ protocol: proto });
    btnCat.classList.add('connected');
    catStatusEl.textContent = `connected (${proto})`;
  } catch (e) {
    catStatusEl.textContent = `error: ${e.message || e}`;
  }
});

// ── Snipe mode state ────────────────────────────────────────────────────────
let snipeMode = false;
let snipeFreq = 1000; // center frequency of 500 Hz window
let apCall = ''; // confirmed AP callsign (empty = AP off)

function updateSnipeOverlay() {
  if (!snipeMode) {
    snipeOverlay.style.display = 'none';
    snipeFreqLabel.style.display = 'none';
    return;
  }
  const w = wfCanvas.clientWidth;
  const freqRange = FREQ_MAX - FREQ_MIN;
  const leftFreq = snipeFreq - 250;
  const rightFreq = snipeFreq + 250;
  const leftPx = ((leftFreq - FREQ_MIN) / freqRange) * w;
  const rightPx = ((rightFreq - FREQ_MIN) / freqRange) * w;

  snipeOverlay.style.display = 'block';
  snipeOverlay.style.left = Math.max(0, leftPx) + 'px';
  snipeOverlay.style.width = (rightPx - leftPx) + 'px';

  snipeFreqLabel.style.display = 'block';
  snipeFreqLabel.style.left = (leftPx + 4) + 'px';
  snipeFreqLabel.textContent = `${snipeFreq.toFixed(0)} Hz ±250`;
}

function updateSnipeStatus() {
  const parts = [];
  if (snipeMode) parts.push('Snipe');
  if (apCall) parts.push(`AP: ${apCall}`);
  if (parts.length === 0) {
    snipeStatusEl.textContent = '';
  } else {
    snipeStatusEl.textContent = parts.join(' + ');
    snipeStatusEl.style.color = apCall ? '#76ff03' : '#4fc3f7';
  }
}

function confirmAp() {
  const call = snipeCallInput.value.trim().toUpperCase();
  if (call) {
    apCall = call;
    btnAp.classList.add('ap-on');
    btnAp.textContent = `AP: ${apCall}`;
  } else {
    apCall = '';
    btnAp.classList.remove('ap-on');
    btnAp.textContent = 'AP';
  }
  updateSnipeStatus();
}

btnSnipe.addEventListener('click', () => {
  snipeMode = !snipeMode;
  btnSnipe.classList.toggle('snipe-on', snipeMode);
  btnSnipe.textContent = snipeMode ? 'Snipe ON' : 'Snipe';
  updateSnipeOverlay();
  updateSnipeStatus();
});

btnAp.addEventListener('click', confirmAp);
snipeCallInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmAp(); });
// Typing in the call field clears the confirmed AP (must re-confirm)
snipeCallInput.addEventListener('input', () => {
  if (apCall) {
    apCall = '';
    btnAp.classList.remove('ap-on');
    btnAp.textContent = 'AP';
    updateSnipeStatus();
  }
});

// Click/drag on waterfall to set snipe frequency
wfWrap.addEventListener('click', (e) => {
  if (!snipeMode) return;
  const rect = wfCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const freq = FREQ_MIN + (x / rect.width) * (FREQ_MAX - FREQ_MIN);
  snipeFreq = Math.round(Math.max(FREQ_MIN + 250, Math.min(FREQ_MAX - 250, freq)));
  updateSnipeOverlay();
});

let dragging = false;
wfWrap.addEventListener('mousedown', (e) => { if (snipeMode) dragging = true; });
window.addEventListener('mouseup', () => { dragging = false; });
wfWrap.addEventListener('mousemove', (e) => {
  if (!snipeMode || !dragging) return;
  const rect = wfCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const freq = FREQ_MIN + (x / rect.width) * (FREQ_MAX - FREQ_MIN);
  snipeFreq = Math.round(Math.max(FREQ_MIN + 250, Math.min(FREQ_MAX - 250, freq)));
  updateSnipeOverlay();
});

// ── WASM init ───────────────────────────────────────────────────────────────
let wasmReady = false;
statusEl.textContent = 'Loading WASM module...';
init().then(async () => {
  wasmReady = true;
  statusEl.textContent = 'Ready. Drop a WAV file or select an audio device.';
  try { await populateDevices(); } catch (e) { console.warn('Audio devices:', e); }
}).catch(e => {
  statusEl.textContent = `WASM load failed: ${e}`;
});

// ── Decode helper ───────────────────────────────────────────────────────────
function runDecode(samples) {
  // Always run full-band subtract (works with or without hardware BPF)
  const results = subtractCheck.checked ? decode_wav_subtract(samples) : decode_wav(samples);

  // If AP is set and target not found in full-band, try AP-only supplement
  // (no EQ — EQ is only useful with hardware BPF)
  if (apCall) {
    const found = results.some(r => r.message.toUpperCase().includes(apCall));
    if (!found) {
      const freq = snipeMode ? snipeFreq : 1500;
      const ap = decode_sniper(samples, freq, apCall);
      for (const r of ap) {
        // Avoid duplicates
        if (!results.some(x => Math.abs(x.freq_hz - r.freq_hz) < 10)) {
          results.push(r);
        } else {
          r.free();
        }
      }
    }
  }

  return results;
}

function isTargetMessage(msg) {
  if (!apCall) return false;
  const upper = msg.toUpperCase();
  if (snipeMode) {
    // Snipe: highlight only messages TO the target (call2 position)
    const words = upper.split(/\s+/);
    // Standard Type 1: CALL1 CALL2 GRID/REPORT — call2 is words[1]
    // CQ: CQ CALL2 GRID — call2 is words[1]
    return words.length >= 2 && words[1] === apCall;
  }
  // Full-band: highlight any message mentioning the target
  return upper.includes(apCall);
}

function decodeModeName() {
  const parts = [];
  if (snipeMode) parts.push(`snipe ${snipeFreq}Hz (${snipeFreq-250}-${snipeFreq+250})`);
  else parts.push(subtractCheck.checked ? 'subtract' : 'single-pass');
  if (apCall) parts.push(`AP:${apCall}`);
  return parts.join(' + ');
}

// ── Audio capture ───────────────────────────────────────────────────────────
const capture = new AudioCapture({
  onWaterfall: (samples) => { waterfall.pushSamples(samples); },
  onBufferFull: () => {},
});

async function populateDevices() {
  const devices = await capture.enumerateDevices();
  deviceSelect.innerHTML = '<option value="">-- select device --</option>';
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.label;
    deviceSelect.appendChild(opt);
  }
  deviceSelect.disabled = false;
  btnStart.disabled = false;
}

// ── Period manager ──────────────────────────────────────────────────────────
const periodMgr = new FT8PeriodManager({
  onTick: (remaining) => { timerEl.textContent = remaining.toFixed(1) + 's'; },
  onPeriodEnd: async (periodIndex) => {
    if (!capture.running || !wasmReady) return;

    waterfall.drawPeriodLine();
    statusEl.textContent = 'Decoding...';
    const float32 = await capture.snapshot();

    if (float32.length < 12000) {
      statusEl.textContent = `Period: too few samples (${float32.length})`;
      return;
    }

    const samples = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      samples[i] = Math.round(Math.max(-32768, Math.min(32767, float32[i] * 32767)));
    }

    const t0 = performance.now();
    const results = runDecode(samples);
    const elapsed = performance.now() - t0;

    const n = results.length;
    const utc = new Date(periodIndex * 15000).toISOString().substr(11, 5);
    statusEl.textContent = `Period ${utc} UTC: ${float32.length} samples`;
    timingEl.textContent = `Decoded ${n} message(s) in ${elapsed.toFixed(1)} ms (${decodeModeName()})`;

    const msgs = [];
    if (n > 0) {
      resultsTable.hidden = false;
      for (let i = 0; i < n; i++) {
        const r = results[i];
        msgs.push({ freq_hz: r.freq_hz, message: r.message });
        const tr = document.createElement('tr');
        if (isTargetMessage(r.message)) tr.classList.add('target');
        if (r.pass >= 4 && r.hard_errors >= 35) tr.classList.add('suspect');
        tr.innerHTML = `
          <td class="num">${utc}</td>
          <td class="num">${r.freq_hz.toFixed(1)}</td>
          <td class="num">${r.dt_sec >= 0 ? '+' : ''}${r.dt_sec.toFixed(2)}</td>
          <td class="num">${r.snr_db >= 0 ? '+' : ''}${r.snr_db.toFixed(0)}</td>
          <td class="num">${r.hard_errors}</td>
          <td>${r.pass}</td>
          <td class="msg">${r.message}</td>
        `;
        // Click row to start QSO with that station
        const msgText = r.message;
        const msgFreq = r.freq_hz;
        tr.addEventListener('click', () => {
          const words = msgText.split(/\s+/);
          // Extract callsign: skip CQ/DE/QRZ, take first callsign-like token
          let dxCall = '';
          for (const w of words) {
            if (['CQ', 'DE', 'QRZ', 'DX'].includes(w)) continue;
            if (w.length >= 3 && /[0-9]/.test(w)) { dxCall = w; break; }
          }
          if (dxCall) {
            qso.setMyInfo(myCallInput.value, myGridInput.value);
            const tx = qso.callStation(dxCall);
            snipeCallInput.value = dxCall;
            statusEl.textContent = `Calling ${dxCall}`;
            qsoTxMsgEl.textContent = qso.formatTx(tx);
          }
        });
        tbody.insertBefore(tr, tbody.firstChild);
        r.free();
      }
    }
    waterfall.drawLabels(msgs);
    waterfall.drawFreqAxis();

    // ── QSO state machine: process decoded messages ──────────────────
    const period = periodMgr.getCurrentPeriod();
    for (const m of msgs) {
      // Pass SNR to QSO for auto-report
      if (m.freq_hz) qso.setRxSnr(parseFloat(m.snr_db || -10));
      const txMsg = qso.processMessage(m.message, period.isEven);
      if (txMsg) {
        const freq = snipeMode ? snipeFreq : 1500;
        if (autoQsoCheck.checked) {
          // TX on the opposite slot from the RX we just decoded
          const txSlot = !period.isEven;
          periodMgr.queueTx({ ...txMsg, freq }, txSlot);
          statusEl.textContent = `TX queued (${txSlot ? 'even' : 'odd'}): ${qso.formatTx(txMsg)}`;
        }
        break;
      }
    }

    // No response from DX → retry same message (auto mode)
    if (!txMsg && qso.state !== QSO_STATE.IDLE && autoQsoCheck.checked) {
      const retryTx = qso.retry();
      if (retryTx) {
        const freq = snipeMode ? snipeFreq : 1500;
        const txSlot = !period.isEven;
        periodMgr.queueTx({ ...retryTx, freq }, txSlot);
        statusEl.textContent = `TX retry (${qso.retryInfo()}): ${qso.formatTx(retryTx)}`;
      } else {
        statusEl.textContent = 'QSO timeout — max retries exceeded';
      }
    }

    // Hint: fill DX call into AP field
    if (qso.dxCall && !apCall && snipeCallInput.value !== qso.dxCall) {
      snipeCallInput.value = qso.dxCall;
    }
  },
});

// TX fire callback — period manager calls this at the right slot boundary
periodMgr.callbacks.onTxFire = async (tx) => {
  await transmit(tx.call1, tx.call2, tx.report, tx.freq);
};

// ── Start / Stop ────────────────────────────────────────────────────────────
let liveMode = false;

btnStart.addEventListener('click', async () => {
  if (!liveMode) {
    const deviceId = deviceSelect.value;
    if (!deviceId) { statusEl.textContent = 'Select an audio device first.'; return; }
    try {
      await capture.start(deviceId);
      periodMgr.start();
      liveMode = true;
      btnStart.textContent = 'Stop';
      btnStart.classList.add('active');
      statusEl.textContent = `Listening (${capture.getSampleRate()} Hz)...`;
      waterfall.clear();
    } catch (e) {
      statusEl.textContent = `Audio error: ${e.message || e}`;
    }
  } else {
    periodMgr.stop();
    capture.stop();
    liveMode = false;
    btnStart.textContent = 'Start';
    btnStart.classList.remove('active');
    timerEl.textContent = '--';
    statusEl.textContent = 'Stopped.';
  }
});

// ── File handling ───────────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('over');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

function parseWav(buf) {
  const view = new DataView(buf);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a WAV file');
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (sampleRate !== 12000) throw new Error(`Sample rate ${sampleRate} Hz (expected 12000)`);
  if (bitsPerSample !== 16) throw new Error(`${bitsPerSample}-bit (expected 16)`);
  if (numChannels !== 1) throw new Error(`${numChannels} channels (expected mono)`);
  let offset = 12;
  while (offset < buf.byteLength - 8) {
    const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1),
      view.getUint8(offset+2), view.getUint8(offset+3));
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') return new Int16Array(buf, offset + 8, size / 2);
    offset += 8 + size;
    if (offset % 2 !== 0) offset++;
  }
  throw new Error('No "data" chunk found');
}

async function handleFile(file) {
  if (!wasmReady) { statusEl.textContent = 'WASM not ready yet'; return; }
  if (liveMode) { statusEl.textContent = 'Stop live mode first.'; return; }

  statusEl.textContent = `Parsing ${file.name}...`;
  timingEl.textContent = '';
  tbody.innerHTML = '';
  resultsTable.hidden = true;

  try {
    const buf = await file.arrayBuffer();
    const samples = parseWav(buf);
    const nSamples = samples.length;
    const duration = (nSamples / 12000).toFixed(1);

    waterfall.clear();
    waterfall.pushSamples(samples);
    waterfall.drawFreqAxis();

    statusEl.textContent = `Decoding ${nSamples} samples (${duration} s)...`;
    await new Promise(r => setTimeout(r, 0));

    const t0 = performance.now();
    const results = runDecode(samples);
    const elapsed = performance.now() - t0;

    const n = results.length;
    statusEl.textContent = `${file.name}: ${nSamples} samples (${duration} s)`;
    timingEl.textContent = `Decoded ${n} message(s) in ${elapsed.toFixed(1)} ms (${decodeModeName()})`;

    const msgs = [];
    if (n > 0) {
      resultsTable.hidden = false;
      for (let i = 0; i < n; i++) {
        const r = results[i];
        msgs.push({ freq_hz: r.freq_hz, message: r.message });
        const tr = document.createElement('tr');
        if (isTargetMessage(r.message)) tr.classList.add('target');
        if (r.pass >= 4 && r.hard_errors >= 35) tr.classList.add('suspect');
        tr.innerHTML = `
          <td class="num">${i + 1}</td>
          <td class="num">${r.freq_hz.toFixed(1)}</td>
          <td class="num">${r.dt_sec >= 0 ? '+' : ''}${r.dt_sec.toFixed(2)}</td>
          <td class="num">${r.snr_db >= 0 ? '+' : ''}${r.snr_db.toFixed(0)}</td>
          <td class="num">${r.hard_errors}</td>
          <td>${r.pass}</td>
          <td class="msg">${r.message}</td>
        `;
        tbody.appendChild(tr);
        r.free();
      }
    }
    waterfall.drawLabels(msgs);
  } catch (e) {
    statusEl.textContent = `Error: ${e.message || e}`;
  }
}

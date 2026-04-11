// Main thread keeps WASM init for encode_ft8 (TX waveform synthesis).
// Decode runs in a Web Worker (decode-worker.js) so a 200-400 ms decode
// call doesn't freeze the waterfall or the UI.
import init, { encode_ft8, encode_free_text } from './ft8_web.js';

// ── Decode worker (off-main-thread WASM) ───────────────────────────────────
const decodeWorker = new Worker(
  new URL('./decode-worker.js', import.meta.url),
  { type: 'module' }
);
let decodeWorkerReady = false;
const decodeWorkerReadyPromise = new Promise((resolve) => {
  const onReady = (e) => {
    if (e.data?.type === 'ready') {
      decodeWorkerReady = true;
      decodeWorker.removeEventListener('message', onReady);
      resolve();
    }
  };
  decodeWorker.addEventListener('message', onReady);
});

// Pending request map: id → { resolve, reject }
const _decodePending = new Map();
let _decodeNextId = 1;
decodeWorker.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg?.id == null) return; // ignore 'ready' and other broadcasts
  const cb = _decodePending.get(msg.id);
  if (!cb) return;
  _decodePending.delete(msg.id);
  if (msg.ok) cb.resolve(msg.results);
  else cb.reject(new Error(msg.error));
});

/**
 * Call a WASM decode function inside the worker. Returns a Promise that
 * resolves to plain-object decoded messages (NOT WASM-backed, no .free()).
 */
function workerDecode(fn, args) {
  const id = _decodeNextId++;
  return new Promise((resolve, reject) => {
    _decodePending.set(id, { resolve, reject });
    decodeWorker.postMessage({ id, fn, args });
  });
}
import { Waterfall } from './waterfall.js';
import { AudioCapture } from './audio-capture.js';
import { AudioOutput } from './audio-output.js';
import { FT8PeriodManager } from './ft8-period.js';
import { QsoManager, QSO_STATE } from './qso.js';
import { CatController, loadRigProfiles, getRigProfiles, isTauriMode, listSerialPorts } from './cat.js';
import { QsoLog } from './qso-log.js';

// ── Elements ────────────────────────────────────────────────────────────────
const body = document.body;
const tabScout = document.getElementById('tab-scout');
const tabSnipe = document.getElementById('tab-snipe');
const badgeSnipe = document.getElementById('badge-snipe');
let unreadSnipe = 0;
function addUnread(mode) {
  if (mode !== 'snipe') return;
  if (currentMode === 'snipe') return;
  unreadSnipe++;
  badgeSnipe.textContent = unreadSnipe > 99 ? '99+' : unreadSnipe;
  badgeSnipe.style.display = '';
}
const timerEl = document.getElementById('period-timer');
const btnSettings = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const wfCanvas = document.getElementById('waterfall');
const wfWrap = document.getElementById('waterfall-wrap');
const snipeOverlay = document.getElementById('snipe-overlay');
const snipeFreqLabel = document.getElementById('snipe-freq-label');
const chatList = document.getElementById('chat-list');
const snipeDxCall = document.getElementById('snipe-dx-call');
const snipeDxInfo = document.getElementById('snipe-dx-info');
const snipeTxLine = document.getElementById('snipe-tx-line');
const snipeBand = document.getElementById('snipe-band');
const qsoLabel = document.getElementById('qso-label');
const txActionsEl = document.getElementById('tx-actions');
const btnHalt = document.getElementById('btn-halt');
const autoCheck = document.getElementById('auto-qso');
const fileInput = document.getElementById('file-input');
// Scout status bar
const scoutState = document.getElementById('scout-state');
const scoutDxEl = document.getElementById('scout-dx');
const scoutDecodeInfo = document.getElementById('scout-decode-info');
const scoutTxQueue = document.getElementById('scout-tx-queue');
const snipeDecodeInfo = document.getElementById('snipe-decode-info');
const scoutDots = [
  document.getElementById('scout-dot-1'), document.getElementById('scout-dot-2'),
  document.getElementById('scout-dot-3'), document.getElementById('scout-dot-4'),
];
const myCallInput = document.getElementById('my-call');
const myGridInput = document.getElementById('my-grid');
const deviceSelect = document.getElementById('audio-device');
const outputDeviceSelect = document.getElementById('audio-output-device');
const bandSelect = document.getElementById('band-header');
const subtractCheck = document.getElementById('subtract-mode');
const apCheck = document.getElementById('ap-mode');
const strictnessSelect = document.getElementById('decode-strictness');
const btnCat = document.getElementById('btn-cat');
const btnCatBle = document.getElementById('btn-cat-ble');
const catStatusEl = document.getElementById('cat-status');
const btnStart = document.getElementById('btn-start');

// ── State ───────────────────────────────────────────────────────────────────
let wasmReady = false;
let liveMode = false;
let currentMode = 'scout'; // 'scout' | 'snipe'
let snipeBpf = 1000;  // Snipe BPF window center (receive)
let snipeDf = 1000;   // Snipe TX frequency
let scoutDf = 1500;   // Scout TX frequency
let apCall = '';
let snipePhase = 'watch'; // 'watch' | 'call'
let snipeAltCall = ''; // call2 (sender) from last tapped Snipe message
let rxSlotEven = null; // even/odd of the period where DX was last heard
let lastDecodeMs = 0; // last decode duration for timer display
let lastPeriodIndex = -1; // track period changes for separator
let apDisabledAuto = false; // true if AP was auto-disabled due to timeout
let subDisabledAuto = false; // true if subtract was auto-disabled due to timeout
const FREQ_MIN = 100, FREQ_MAX = 3000;
// USB passband center = 1500 Hz (ITU standard, rig-independent).
// The 500 Hz narrow filter is centered here in DATA-USB mode.
const FILTER_CENTER = 1500;

// ── Status display ─────────────────────────────────────────────────────────
function setStatus(text) {
  const isTx = text.startsWith('TX queued') || text.startsWith('CQ queued')
    || text.startsWith('Retry') || text.startsWith('TX:');
  if (isTx) {
    scoutTxQueue.textContent = text;
  } else {
    scoutDecodeInfo.textContent = text;
    if (!periodMgr.hasTxQueued()) scoutTxQueue.textContent = '';
  }
  // Decode counts (e.g. "10d 1783ms") go to snipe-decode-info only — not here
  if (!/^\d+d \d+ms/.test(text)) snipeTxLine.textContent = text;
  // Show Halt/Reset when TX is queued, active, or halted
  btnHalt.style.display = (periodMgr.hasTxQueued() || isTx || halted) ? '' : 'none';
}

const DOM_MAX = 200; // max child elements per list
function pruneList(el) {
  while (el.children.length > DOM_MAX) el.firstChild.remove();
}

function showToast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2000);
}

const scoutTargetEl = document.getElementById('scout-target');
const scoutTargetCall = document.getElementById('scout-target-call');
const scoutTargetMsg = document.getElementById('scout-target-msg');
const scoutTargetInfo = document.getElementById('scout-target-info');

function clearTargetCards() {
  scoutTargetMsg.textContent = '';
  scoutTargetInfo.textContent = '';
  snipeDxInfo.textContent = '';
}

function updateScoutStatus() {
  const state = qso.state;
  const stateIdx = { IDLE: -1, CALLING: 0, REPORT: 1, FINAL: 2 }[state] ?? -1;
  scoutDots.forEach((d, i) => {
    d.className = 'dot';
    if (i < stateIdx) d.classList.add('done');
    if (i === stateIdx) d.classList.add('current');
  });
  if (state === 'IDLE' && qso.dxCall) scoutDots.forEach(d => d.classList.add('done'));
  scoutState.textContent = state === 'IDLE' ? '' : state;
  scoutDxEl.textContent = (state !== 'IDLE' && qso.dxCall) ? qso.dxCall : '';

  // Scout target card: show during active QSO in Scout mode only
  const active = currentMode === 'scout' && state !== 'IDLE' && qso.dxCall;
  scoutTargetEl.style.display = active ? '' : 'none';
  if (active) {
    scoutTargetCall.textContent = qso.dxCall;
  }
}

// ── Waterfall ───────────────────────────────────────────────────────────────
function resizeCanvas() {
  wfCanvas.width = wfCanvas.clientWidth;
  wfCanvas.height = wfCanvas.clientHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);
// Waterfall at 6 kHz / fftSize 1024 — bin width 5.86 Hz (identical to the
// old 12k/2048 setup), but ~half the main-thread FFT cost. The audio
// worklet boxcar-decimates 12 kHz → 6 kHz internally for this path; the
// snapshot/decode path stays at 12 kHz so decoding is unaffected.
const waterfall = new Waterfall(wfCanvas, { sampleRate: 6000, fftSize: 1024 });
waterfall.dfLine = scoutDf; // show DF line on startup

// ── Core modules ────────────────────────────────────────────────────────────
const audioOut = new AudioOutput();
audioOut.setGain((localStorage.getItem('webft8-tx-gain') || 100) / 100);
const cat = new CatController();
const qsoLog = new QsoLog();

// Restore settings
myCallInput.value = localStorage.getItem('webft8-mycall') || '';
myGridInput.value = localStorage.getItem('webft8-mygrid') || '';
myCallInput.addEventListener('change', () => {
  myCallInput.value = myCallInput.value.toUpperCase();
  localStorage.setItem('webft8-mycall', myCallInput.value);
});
myGridInput.addEventListener('change', () => {
  myGridInput.value = myGridInput.value.toUpperCase();
  localStorage.setItem('webft8-mygrid', myGridInput.value);
});
const savedStrictness = localStorage.getItem('webft8-strictness');
if (savedStrictness !== null) strictnessSelect.value = savedStrictness;
strictnessSelect.addEventListener('change', () => localStorage.setItem('webft8-strictness', strictnessSelect.value));
const cqBestSnrCheck = document.getElementById('cq-best-snr');
const cqReplyLabel = document.getElementById('cq-reply-label');
const updateCqLabel = () => { cqReplyLabel.textContent = cqBestSnrCheck.checked ? 'CQ reply: best SNR' : 'CQ reply: first decoded'; };
cqBestSnrCheck.addEventListener('change', updateCqLabel);
updateCqLabel();
const eqModeSelect = document.getElementById('eq-mode');
const savedEq = localStorage.getItem('webft8-eq-mode');
if (savedEq) eqModeSelect.value = savedEq;
eqModeSelect.addEventListener('change', () => localStorage.setItem('webft8-eq-mode', eqModeSelect.value));
const retryLimitInput = document.getElementById('retry-limit');
const savedRetry = localStorage.getItem('webft8-retry-limit');
if (savedRetry) retryLimitInput.value = savedRetry;
retryLimitInput.addEventListener('change', () => {
  const v = Math.max(1, Math.min(30, parseInt(retryLimitInput.value, 10) || 15));
  retryLimitInput.value = v;
  localStorage.setItem('webft8-retry-limit', v);
  qso.maxRetries = v;
});
const savedBand = localStorage.getItem('webft8-band');
if (savedBand) bandSelect.value = savedBand;
bandSelect.addEventListener('change', async () => {
  localStorage.setItem('webft8-band', bandSelect.value);
  const baseHz = Math.round(parseFloat(bandSelect.value) * 1e6);
  if (currentMode === 'snipe' && snipePhase === 'call') {
    await cat.setFreq(baseHz + (snipeBpf - FILTER_CENTER));
  } else {
    await cat.setFreq(baseHz);
  }
  await cat.setModeData();
});
deviceSelect.addEventListener('change', () => localStorage.setItem('webft8-audio-in', deviceSelect.value));
outputDeviceSelect.addEventListener('change', () => localStorage.setItem('webft8-audio-out', outputDeviceSelect.value));

// ── TX Messages ──────────────────────────────────────────────────────────────
const tx1CqSuffix = document.getElementById('tx1-cq-suffix');
const tx5FreeText = document.getElementById('tx5-free-text');
const savedCqSuffix = localStorage.getItem('webft8-tx1-cq-suffix');
const savedFreeText = localStorage.getItem('webft8-tx5-free-text');
if (savedCqSuffix) tx1CqSuffix.value = savedCqSuffix;
if (savedFreeText) tx5FreeText.value = savedFreeText;
tx1CqSuffix.addEventListener('input', () => {
  localStorage.setItem('webft8-tx1-cq-suffix', tx1CqSuffix.value);
  updateTxActions();
});
tx5FreeText.addEventListener('input', () => {
  localStorage.setItem('webft8-tx5-free-text', tx5FreeText.value);
});

// ── Audio level controls ───────────────────────────────────────────────────
const rxGainSlider = document.getElementById('rx-gain');
const rxGainVal = document.getElementById('rx-gain-val');
const rxMeter = document.getElementById('rx-meter');
const rxClip = document.getElementById('rx-clip');
const txGainSlider = document.getElementById('tx-gain');
const txGainVal = document.getElementById('tx-gain-val');
const txMeter = document.getElementById('tx-meter');
const txClip = document.getElementById('tx-clip');

const savedRxGain = localStorage.getItem('webft8-rx-gain');
const savedTxGain = localStorage.getItem('webft8-tx-gain');
if (savedRxGain) { rxGainSlider.value = savedRxGain; }
if (savedTxGain) { txGainSlider.value = savedTxGain; }
rxGainVal.textContent = rxGainSlider.value + '%';
txGainVal.textContent = txGainSlider.value + '%';

rxGainSlider.addEventListener('input', () => {
  const pct = rxGainSlider.value;
  rxGainVal.textContent = pct + '%';
  capture.setGain(pct / 100);
  localStorage.setItem('webft8-rx-gain', pct);
});
txGainSlider.addEventListener('input', () => {
  const pct = txGainSlider.value;
  txGainVal.textContent = pct + '%';
  audioOut.setGain(pct / 100);
  localStorage.setItem('webft8-tx-gain', pct);
  updateTxMeter();
});

function updateTxMeter() {
  if (!audioOut.playing) return;
  const pct = Math.min(audioOut.gain * 100, 100);
  txMeter.style.width = pct + '%';
  if (audioOut.gain > 0.95) {
    txMeter.classList.add('clip');
    txClip.classList.add('active');
  } else {
    txMeter.classList.remove('clip');
    txClip.classList.remove('active');
  }
}


const qso = new QsoManager({
  myCall: myCallInput.value,
  myGrid: myGridInput.value,
  onStateChange: (state) => {
    updateQsoDisplay();
    if (state === QSO_STATE.IDLE && qso.dxCall) {
      qsoLog.add({
        dxCall: qso.dxCall, dxGrid: qso.dxGrid,
        txReport: qso.txReport, rxReport: qso.rxReport,
        freq: currentMode === 'snipe' ? snipeDf : scoutDf,
        bandMHz: bandSelect.value,
        state: 'IDLE', // completed
      });
      addChatMsg('sys', '', `QSO logged: ${qso.dxCall}`, 0);
      showToast(`QSO logged: ${qso.dxCall}`);
    }
  },
  onTxReady: () => updateQsoDisplay(),
});
qso.maxRetries = parseInt(retryLimitInput.value, 10) || 15;

myCallInput.addEventListener('input', () => {
  myCallInput.value = myCallInput.value.toUpperCase();
  qso.setMyInfo(myCallInput.value, myGridInput.value);
});
myGridInput.addEventListener('input', () => {
  myGridInput.value = myGridInput.value.toUpperCase();
  qso.setMyInfo(myCallInput.value, myGridInput.value);
});

// Waterfall FFT can be disabled at runtime via Settings → Decode → "Waterfall FFT".
// Useful for isolating whether the main-thread FFT load affects audio decode quality.
const wfEnableEl = document.getElementById('waterfall-enable');
let waterfallEnabled = (localStorage.getItem('webft8-wf-enable') ?? '1') === '1';
if (wfEnableEl) {
  wfEnableEl.checked = waterfallEnabled;
  wfEnableEl.addEventListener('change', () => {
    waterfallEnabled = wfEnableEl.checked;
    localStorage.setItem('webft8-wf-enable', waterfallEnabled ? '1' : '0');
    if (!waterfallEnabled) waterfall.clear();
  });
}

const capture = new AudioCapture({
  onWaterfall: (samples) => { if (waterfallEnabled) waterfall.pushSamples(samples); },
  onBufferFull: () => {},
});
capture.onSampleRate = (rate) => waterfall.setSampleRate(rate);
capture._onDisconnect = () => {
  periodMgr.stop();
  liveMode = false;
  updateLiveUI();
  setStatus('Audio disconnected');
  showToast('Audio disconnected');
};
// RX level meter from AudioWorklet peak reports.
capture.onPeak = (level) => {
  const pct = Math.min(level * 100, 100);
  rxMeter.style.width = pct + '%';
};
cat.onDisconnect = () => {
  btnCat.textContent = 'Connect Rig';
  btnCatBle.textContent = 'Connect BLE';
  catStatusEl.textContent = 'disconnected';
  setStatus('CAT disconnected');
  showToast('CAT disconnected');
};

// ── Mode switching ──────────────────────────────────────────────────────────
tabScout.addEventListener('click', () => setMode('scout'));
tabSnipe.addEventListener('click', () => setMode('snipe'));

function setMode(mode) {
  currentMode = mode;
  body.className = mode + '-mode';
  tabScout.classList.toggle('active', mode === 'scout');
  tabSnipe.classList.toggle('active', mode === 'snipe');
  if (mode === 'snipe') { unreadSnipe = 0; badgeSnipe.style.display = 'none'; }
  resizeCanvas();
  waterfall.clear();
  waterfall.dfLine = mode === 'scout' ? scoutDf : snipeDf;
  waterfall.targetLine = (mode === 'snipe' && snipePhase === 'call') ? snipeBpf : null;
  waterfall.freqOffset = (mode === 'snipe' && snipePhase === 'call') ? (snipeBpf - FILTER_CENTER) : 0;
  if (mode === 'snipe') {
    snipePhaseHint.textContent = snipePhase === 'watch'
      ? `full-band  DF ${snipeDf} Hz  Target ${snipeBpf} Hz`
      : `BPF ${snipeBpf} Hz  DF ${snipeDf} Hz`;
  }
  updateSnipeOverlay();
}

// ── Snipe Watch/Call phase ──────────────────────────────────────────────────
const btnWatch = document.getElementById('btn-watch');
const btnCall = document.getElementById('btn-call');
const snipePhaseHint = document.getElementById('snipe-phase-hint');
const snipeCallersEl = document.getElementById('snipe-callers');

btnWatch.addEventListener('click', () => setSnipePhase('watch'));
btnCall.addEventListener('click', () => setSnipePhase('call'));

/** Compute shifted dial frequency so the physical filter covers snipeBpf. */
function snipeDialHz() {
  const baseHz = Math.round(parseFloat(bandSelect.value) * 1e6);
  return baseHz + (snipeBpf - FILTER_CENTER);
}

async function setSnipePhase(phase) {
  snipePhase = phase;
  btnWatch.classList.toggle('active', phase === 'watch');
  btnCall.classList.toggle('active', phase === 'call');
  const snipeView = document.getElementById('snipe-view');
  snipeView.classList.toggle('snipe-call-phase', phase === 'call');
  if (phase === 'watch') {
    waterfall.freqOffset = 0;
    waterfall.noiseWindow = null;
    waterfall.targetLine = null;
    snipePhaseHint.textContent = `full-band  DF ${snipeDf} Hz`;
    await cat.setFilter(false);
    const baseHz = Math.round(parseFloat(bandSelect.value) * 1e6);
    await cat.setFreq(baseHz);
  } else {
    waterfall.freqOffset = snipeBpf - FILTER_CENTER;
    waterfall.noiseWindow = { min: snipeBpf - 250, max: snipeBpf + 250 };
    waterfall.targetLine = snipeBpf;
    snipePhaseHint.textContent = `BPF ${snipeBpf} Hz  DF ${snipeDf} Hz`;
    await cat.setFilter(true);
    await cat.setFreq(snipeDialHz());
  }
  updateSnipeOverlay();
}

// ── Settings panel ──────────────────────────────────────────────────────────
function openSettings() {
  settingsPanel.classList.add('open');
  settingsOverlay.classList.add('open');
}
function closeSettings() {
  // Require callsign and grid before allowing close
  if (!myCallInput.value.trim() || !myGridInput.value.trim()) {
    myCallInput.style.borderColor = myCallInput.value.trim() ? '' : '#f44336';
    myGridInput.style.borderColor = myGridInput.value.trim() ? '' : '#f44336';
    setStatus('Enter callsign and grid');
    return;
  }
  myCallInput.style.borderColor = '';
  myGridInput.style.borderColor = '';
  settingsPanel.classList.remove('open');
  settingsOverlay.classList.remove('open');
}
btnSettings.addEventListener('click', openSettings);
settingsOverlay.addEventListener('click', closeSettings);
document.getElementById('btn-close-settings').addEventListener('click', closeSettings);

// Open settings on first launch (no callsign set)
if (!myCallInput.value) setTimeout(openSettings, 500);

// ── Snipe overlay on waterfall ──────────────────────────────────────────────
function updateSnipeOverlay() {
  if (currentMode !== 'snipe' || snipePhase === 'watch') {
    snipeOverlay.style.display = 'none';
    snipeFreqLabel.style.display = 'none';
    return;
  }
  const w = wfCanvas.clientWidth;
  const range = FREQ_MAX - FREQ_MIN;
  const left = ((snipeBpf - 250 - FREQ_MIN) / range) * w;
  const right = ((snipeBpf + 250 - FREQ_MIN) / range) * w;
  snipeOverlay.style.display = 'block';
  snipeOverlay.style.left = Math.max(0, left) + 'px';
  snipeOverlay.style.width = (right - left) + 'px';
  snipeFreqLabel.style.display = 'block';
  snipeFreqLabel.style.left = (left + 4) + 'px';
  snipeFreqLabel.textContent = `${snipeBpf} Hz`;
}

// Left-click: set DF (TX frequency) — both Watch and Call
wfWrap.addEventListener('click', async (e) => {
  const rect = wfCanvas.getBoundingClientRect();
  const freq = Math.round(FREQ_MIN + ((e.clientX - rect.left) / rect.width) * (FREQ_MAX - FREQ_MIN));
  if (currentMode === 'snipe') {
    snipeDf = Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq));
    waterfall.dfLine = snipeDf;
    setStatus(`DF: ${snipeDf} Hz`);
    snipePhaseHint.textContent = snipePhase === 'watch'
      ? `full-band  DF ${snipeDf} Hz`
      : `BPF ${snipeBpf} Hz  DF ${snipeDf} Hz`;
  } else {
    scoutDf = Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq));
    waterfall.dfLine = scoutDf;
    setStatus(`DF: ${scoutDf} Hz`);
  }
});

// Right-click: set target frequency (BPF center, green line) — Snipe only
// preventDefault() must come before the mode guard so Tauri WebView never
// shows the "Save image" system context menu on the canvas element.
wfWrap.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  if (currentMode !== 'snipe') return;
  const rect = wfCanvas.getBoundingClientRect();
  const freq = Math.round(FREQ_MIN + ((e.clientX - rect.left) / rect.width) * (FREQ_MAX - FREQ_MIN));
  snipeBpf = Math.max(FREQ_MIN + 250, Math.min(FREQ_MAX - 250, freq));
  if (snipePhase === 'call') {
    waterfall.targetLine = snipeBpf;
    waterfall.freqOffset = snipeBpf - FILTER_CENTER;
    waterfall.noiseWindow = { min: snipeBpf - 250, max: snipeBpf + 250 };
    await cat.setFreq(snipeDialHz());
  }
  updateSnipeOverlay();
  snipePhaseHint.textContent = snipePhase === 'watch'
    ? `full-band  DF ${snipeDf} Hz  Target ${snipeBpf} Hz`
    : `BPF ${snipeBpf} Hz  DF ${snipeDf} Hz`;
  setStatus(`Target: ${snipeBpf} Hz`);
});

// ── Chat message helper (Scout mode) ────────────────────────────────────────
function addChatMsg(type, time, text, snr, actionCb, freq, dt) {
  const es = document.getElementById('empty-state');
  if (es) es.remove();
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;

  const myCall = myCallInput.value.toUpperCase();
  const dxCall = qso.dxCall;

  // Highlight callsigns
  let html = text.replace(/\b([A-Z0-9/<>]{3,})\b/g, (m) => {
    if (m === dxCall) return `<span class="target">${m}</span>`;
    if (m === myCall) return `<span class="call">${m}</span>`;
    return m;
  });

  const freqStr = freq != null ? `${Math.round(freq)}` : '';
  const dtStr = dt != null ? `${dt >= 0 ? '+' : ''}${dt.toFixed(1)}` : '';
  const snrStr = snr != null && type === 'rx' ? `${snr >= 0 ? '+' : ''}${Math.round(snr)}` : '';

  div.innerHTML = `
    <span class="col-freq">${freqStr}</span>
    <span class="col-dt">${dtStr}</span>
    <span class="col-snr">${snrStr}</span>
    <span class="text">${html}</span>
  `;

  // Mark QSO-related messages
  if (type === 'rx' && dxCall && text.includes(dxCall)) {
    div.classList.add('qso-active');
  }

  // Clickable RX messages: tap to call that station
  if (type === 'rx' && actionCb) {
    div.style.cursor = 'pointer';
    div.addEventListener('click', actionCb);
  }

  chatList.appendChild(div);
  pruneList(chatList);
  chatList.scrollTop = chatList.scrollHeight;
  if (type === 'rx') {
    div.classList.add('new');
    div.addEventListener('animationend', () => div.classList.remove('new'), { once: true });
  }
}

// ── QSO display update ─────────────────────────────────────────────────────
const snipeRxList = document.getElementById('snipe-rx-list');

function updateQsoDisplay() {
  const state = qso.state;

  // Snipe view
  qsoLabel.textContent = state;
  snipeDxCall.textContent = qso.dxCall || 'No target';
  const tx = qso.getNextTx();
  snipeTxLine.textContent = tx ? `Next: ${qso.formatTx(tx)}` : '';

  // Progress dots
  const dots = [
    document.getElementById('dot-1'),
    document.getElementById('dot-2'),
    document.getElementById('dot-3'),
    document.getElementById('dot-4'),
  ];
  const stateIdx = { IDLE: -1, CALLING: 0, REPORT: 1, FINAL: 2 }[state] ?? -1;
  dots.forEach((d, i) => {
    d.className = 'dot';
    if (i < stateIdx) d.classList.add('done');
    if (i === stateIdx) d.classList.add('current');
  });
  if (state === QSO_STATE.IDLE && qso.dxCall) {
    dots.forEach(d => d.classList.add('done'));
  }

  updateScoutStatus();
  updateTxActions();
}

function updateTxActions() {
  txActionsEl.innerHTML = '';
  const myCall = myCallInput.value.toUpperCase();
  const myGrid = myGridInput.value.toUpperCase();
  const dx = qso.dxCall;
  const state = qso.state;

  if (state === QSO_STATE.IDLE || !dx) {
    // IDLE — show CQ button (with optional suffix like CQ POTA)
    const suffix = tx1CqSuffix.value.trim().toUpperCase();
    const cqLabel = suffix ? `CQ ${suffix}` : 'CQ';
    const btn = document.createElement('button');
    btn.className = 'cq';
    btn.textContent = cqLabel;
    btn.addEventListener('click', () => {
      qso.setMyInfo(myCallInput.value, myGridInput.value);
      qso.freeText = tx5FreeText.value.trim().toUpperCase();
      const tx = qso.callCq(suffix);
      queueTxMsg(tx.call1, tx.call2, tx.report);
    });
    txActionsEl.appendChild(btn);

    // Snipe: show alt call (sender) as secondary option
    if (currentMode === 'snipe' && snipeAltCall && snipeAltCall !== myCall) {
      const altBtn = document.createElement('button');
      altBtn.className = 'tx-msg';
      altBtn.textContent = `Call ${snipeAltCall}`;
      altBtn.addEventListener('click', () => {
        qso.setMyInfo(myCallInput.value, myGridInput.value);
        const tx = qso.callStation(snipeAltCall);
        apCall = snipeAltCall;
        snipeDxCall.textContent = snipeAltCall;
        clearTargetCards();
        snipeAltCall = '';
        if (tx) queueTxMsg(tx.call1, tx.call2, tx.report);
      });
      txActionsEl.appendChild(altBtn);
    }
    return;
  }

  // QSO active — short DX call button + CQ
  const tx = qso.getNextTx();
  if (tx) {
    const btn = document.createElement('button');
    btn.className = 'tx-next';
    btn.textContent = dx; // just DX callsign, not full message
    btn.addEventListener('click', () => queueTxMsg(tx.call1, tx.call2, tx.report));
    txActionsEl.appendChild(btn);
  }
  const cqSfx = tx1CqSuffix.value.trim().toUpperCase();
  const cqBtn = document.createElement('button');
  cqBtn.className = 'cq';
  cqBtn.textContent = cqSfx ? `CQ ${cqSfx}` : 'CQ';
  cqBtn.addEventListener('click', () => {
    qso.setMyInfo(myCallInput.value, myGridInput.value);
    qso.freeText = tx5FreeText.value.trim().toUpperCase();
    const cqTx = qso.callCq(cqSfx);
    queueTxMsg(cqTx.call1, cqTx.call2, cqTx.report);
  });
  txActionsEl.appendChild(cqBtn);
}

autoCheck.addEventListener('change', updateTxActions);

// ── Decode ──────────────────────────────────────────────────────────────────
// Scout adaptive budget: shed subtract first, then AP.
// Snipe always runs both (narrow band = fast).
const BUDGET_MS = 2400;

async function runDecode(samples, sampleRate, onPartial) {
  const t0 = performance.now();

  // Dispatch to f32 or i16 entry points based on the input array type.
  // Live capture passes Float32Array directly (worklet output) — skips
  // the JS i16 conversion loop. WAV file drops still arrive as Int16Array.
  const isF32 = samples instanceof Float32Array;
  const fnDecodeName   = isF32 ? 'decode_wav_f32'          : 'decode_wav';
  const fnSniperName   = isF32 ? 'decode_sniper_f32'       : 'decode_sniper';
  const fnPhase1Name   = isF32 ? 'decode_phase1_f32'       : 'decode_phase1';
  const fnPhase2Name   = isF32 ? 'decode_phase2_f32'       : 'decode_phase2';

  // Subtract: use if enabled and not auto-disabled
  const useSub = subtractCheck.checked && !subDisabledAuto;
  const strict = parseInt(strictnessSelect.value, 10);
  const sr = sampleRate || capture.getSampleRate();

  let results;
  if (useSub) {
    // Pipelined decode: Phase 1 (fast, ~200ms) + Phase 2 (subtract, budget permitting).
    // Phase 1 caches audio + FFT in WASM thread_local; Phase 2 reuses them.
    const p1 = await workerDecode(fnPhase1Name, [samples, sr]);
    const p1Ms = performance.now() - t0;

    // Show Phase 1 results immediately while Phase 2 runs
    if (onPartial && p1.length > 0) onPartial(p1);

    let p2 = [];
    if (BUDGET_MS - p1Ms > 200) {
      p2 = await workerDecode(fnPhase2Name, [strict]);
    }
    results = [...p1, ...p2];
  } else {
    // Non-subtract path (unchanged)
    results = await workerDecode(fnDecodeName, [samples, strict, sr]);
  }

  // AP supplement: enabled by checkbox, auto-disabled by budget
  // Skip AP when calling CQ (no target yet — AP would only produce false positives)
  const isCqWaiting = qso.state === QSO_STATE.CALLING && !qso.dxCall;
  const useAp = apCheck.checked && !apDisabledAuto && !isCqWaiting;
  const apTarget = useAp
    ? (apCall || (currentMode === 'scout' && qso.dxCall ? qso.dxCall : ''))
    : '';

  if (apTarget) {
    const found = results.some(r => r.message.toUpperCase().includes(apTarget));
    if (!found) {
      const freq = currentMode === 'snipe' ? snipeDf : scoutDf;
      const myCall = myCallInput.value.trim().toUpperCase();
      const eqOn = eqModeSelect.value === 'adaptive';
      const ap = await workerDecode(
        fnSniperName,
        [samples, freq, apTarget, myCall, eqOn, sr],
      );
      for (const r of ap) {
        if (!results.some(x => Math.abs(x.freq_hz - r.freq_hz) < 10)) {
          results.push(r);
        }
        // Plain objects from the worker — no .free() needed.
      }
    }
  }

  const totalMs = performance.now() - t0;
  lastDecodeMs = Math.round(totalMs);

  // Scout adaptive shedding: subtract first, then AP
  if (currentMode === 'scout' && totalMs > BUDGET_MS) {
    if (useSub && !subDisabledAuto) {
      subDisabledAuto = true; // shed subtract first
    } else if (apTarget && !apDisabledAuto) {
      apDisabledAuto = true;  // then shed AP
    }
  }

  // Recovery: re-enable in reverse order (AP first, then subtract)
  if (currentMode === 'scout' && totalMs < BUDGET_MS * 0.6) {
    if (apDisabledAuto) {
      apDisabledAuto = false;
    } else if (subDisabledAuto) {
      subDisabledAuto = false;
    }
  }

  return results;
}

// ── TX queue helper (all manual TX goes through period manager) ─────────────
function queueTxMsg(call1, call2, report) {
  clearHalted();
  const freq = currentMode === 'snipe' ? snipeDf : scoutDf;
  const txSlot = rxSlotEven !== null ? !rxSlotEven : !periodMgr.getCurrentPeriod().isEven;
  periodMgr.queueTx({ call1, call2, report, freq }, txSlot);
  setStatus(`TX queued: ${call1} ${call2} ${report}`);
}

// ── Transmit (called by period manager at period boundary) ─────────────────
async function transmit(call1, call2, report, freq) {
  if (!wasmReady) return;
  freq = freq || (currentMode === 'snipe' ? snipeDf : scoutDf);
  try {
    const txText = `${call1} ${call2} ${report}`.trim();
    scoutTxQueue.textContent = ''; // clear queue indicator
    setStatus(`TX: ${txText}`);
    // Mark matching button (find by text content)
    const allBtns = txActionsEl.querySelectorAll('button');
    let activeBtn = null;
    for (const b of allBtns) {
      if (b.textContent.trim() === txText || b.textContent.includes(call1)) {
        activeBtn = b;
        break;
      }
    }
    if (!activeBtn && allBtns.length) activeBtn = allBtns[0];
    if (activeBtn) activeBtn.classList.add('tx-active');
    timerEl.classList.add('tx-on');

    const utc = new Date().toISOString().substr(11, 8);
    addChatMsg('tx sending', utc, txText, undefined);

    const samples = call1 === '__FREE__'
      ? encode_free_text(report, freq)
      : encode_ft8(call1, call2, report, freq);

    // Show TX level meter (peak of generated waveform * gain)
    const txPeak = AudioOutput.peakLevel(samples) * (txGainSlider.value / 100);
    const txPct = Math.min(txPeak * 100, 100);
    txMeter.style.width = txPct + '%';
    if (txPeak > 0.95) {
      txMeter.classList.add('clip');
      txClip.classList.add('active');
    } else {
      txMeter.classList.remove('clip');
      txClip.classList.remove('active');
    }

    if (cat.connected) await cat.ptt(true);
    await audioOut.play(samples, outputDeviceSelect.value || undefined);
    if (cat.connected) await cat.ptt(false);

    if (activeBtn) activeBtn.classList.remove('tx-active');
    timerEl.classList.remove('tx-on');
    setStatus('TX complete');
  } catch (e) {
    txActionsEl.querySelectorAll('.tx-active').forEach(b => b.classList.remove('tx-active'));
    timerEl.classList.remove('tx-on');
    setStatus(`TX error: ${e.message || e}`);
    await cat.safePttOff();
  }
}

// ── Period manager ──────────────────────────────────────────────────────────
const periodMgr = new FT8PeriodManager({
  onTick: (rem) => { timerEl.textContent = `${Math.ceil(rem)}s`; },
  onPeriodEnd: async (periodIndex, isEven) => {
    if (!capture.running || !wasmReady) return;

    waterfall.drawPeriodLine();
    const float32 = await capture.snapshot();
    if (float32.length < 12000) return;

    // JS-side peak-normalize before decode. This is cache-safe: works even
    // if the browser serves a stale WASM build without Rust-side normalization.
    // Signals from USB radio adapters are typically at < 0.01 full-scale;
    // without this, i16 conversion wastes 6-7 bits of dynamic range.
    {
      let peak = 0;
      for (let i = 0; i < float32.length; i++) { const a = Math.abs(float32[i]); if (a > peak) peak = a; }
      if (peak > 1e-6) { const s = 0.8 / peak; for (let i = 0; i < float32.length; i++) float32[i] *= s; }
    }

    // ── Per-message rendering helper ──────────────────────────────────────
    // Pushes decoded messages to chat/snipe views, logs them, and feeds the
    // QSO state machine.  Designed to be called once (non-subtract) or twice
    // (Phase 1 partial + Phase 2 remainder) per period.
    const utc = new Date(periodIndex * 15000).toISOString().substr(11, 8);
    let sepInserted = false;
    const callers = []; // track stations calling me (for pileup notification)
    let txMsg = null;
    const msgs = [];

    function pushResults(batch) {
      // Insert period separator once, on the first batch with results
      if (!sepInserted && batch.length > 0) {
        const sep = document.createElement('div');
        sep.className = 'period-sep';
        sep.textContent = utc;
        chatList.appendChild(sep);
        snipeRxList.appendChild(sep.cloneNode(true));
        sepInserted = true;
      }

      // In Snipe Call mode, decoded freq_hz is in audio space (VFO-shifted).
      // Add freqOffset to display in the original (Watch) coordinate system.
      const freqOff = (currentMode === 'snipe' && snipePhase === 'call')
        ? (snipeBpf - FILTER_CENTER) : 0;

      for (const r of batch) {
        const msg = r.message;
        const freq = r.freq_hz + freqOff;
        const snr = r.snr_db;
        const dt = r.dt_sec;
        msgs.push({ freq_hz: freq, dt_sec: dt, snr_db: snr, message: msg });

        qsoLog.addRx({ message: msg, freq_hz: freq, snr_db: snr });

        // Scout chat
        const words = msg.split(/\s+/);
        const calls = [];
        for (const w of words) {
          if (['CQ', 'DE', 'QRZ', 'DX'].includes(w)) continue;
          if (w.length >= 3 && /[0-9]/.test(w)) calls.push(w);
          if (calls.length >= 2) break;
        }
        const isCq = /^(CQ|DE|QRZ)\b/.test(msg);
        const clickCall = isCq ? (calls[0] || '') : (calls[1] || calls[0] || '');
        addChatMsg('rx', utc, msg, snr, clickCall ? () => {
          qso.setMyInfo(myCallInput.value, myGridInput.value);
          const tx = qso.callStation(clickCall);
          apCall = clickCall;
          snipeBpf = Math.max(FREQ_MIN + 250, Math.min(FREQ_MAX - 250, Math.round(freq)));
          snipeDf = snipeBpf;
          clearTargetCards();
          if (tx) queueTxMsg(tx.call1, tx.call2, tx.report);
        } : null, freq, dt);

        // Snipe view
        if (currentMode === 'snipe' && apCall && msg.toUpperCase().includes(apCall)) {
          snipeDxInfo.textContent = `${freq.toFixed(0)} Hz  ${snr >= 0 ? '+' : ''}${Math.round(snr)} dB`;
        }

        // Track callers
        const myCall = myCallInput.value.toUpperCase();
        const w = msg.split(/\s+/);
        if (w[0] === myCall && w.length >= 2 && w[1] !== myCall) {
          callers.push({ call: w[1], snr, msg, freq });
        }

        // QSO state machine (skip CQ responses — handled below after SNR sort)
        const isCqWait = qso.state === QSO_STATE.CALLING && !qso.dxCall;
        if (!isCqWait) {
          qso.setRxSnr(snr);
          const result = qso.processMessage(msg);
          if (result && !txMsg) txMsg = result;
        }

        // Update target card
        if (qso.dxCall && msg.toUpperCase().includes(qso.dxCall)) {
          scoutTargetMsg.textContent = msg;
          scoutTargetInfo.textContent = `${freq.toFixed(0)} Hz  ${snr >= 0 ? '+' : ''}${Math.round(snr)} dB`;
        }
      }
    }

    // Pass Float32Array directly — runDecode dispatches to the f32 WASM
    // entry points which fold scaling + i16 conversion + (no-op) resample
    // into a single Rust pass. The decode runs in a Web Worker so the
    // main thread (waterfall, UI) stays responsive throughout.
    //
    // onPartial: Phase 1 results are pushed to chat immediately while
    // Phase 2 (subtract) is still running in the worker.
    const results = await runDecode(float32, null, pushResults);
    const n = results.length;

    // Push any remaining results not yet shown (non-subtract path, or
    // Phase 2 results that arrived after the onPartial callback).
    // pushResults is idempotent per-message via the msgs array check.
    const shownCount = msgs.length;
    if (shownCount < n) {
      pushResults(results.slice(shownCount));
    }

    lastPeriodIndex = periodIndex;

    const shed = [subDisabledAuto && 'sub', apDisabledAuto && 'AP'].filter(Boolean);
    const shedTag = shed.length ? ` [-${shed.join(',')}]` : '';
    setStatus(`${n}d ${lastDecodeMs}ms${shedTag}`);
    {
      // Decoder depth breakdown for snipe-decode-info
      let bp = 0, osd2 = 0, osd3 = 0, osd4 = 0;
      for (const r of results) {
        const p = r.pass ?? 0;
        if (p <= 3) bp++;
        else if (p === 4) osd2++;
        else if (p === 5) osd3++;
        else if (p === 13) osd4++;
        else bp++; // AP passes count as BP-level for display
      }
      const parts = [`${n}d ${lastDecodeMs}ms`];
      if (n > 0) {
        const depth = [
          bp   && `BP:${bp}`,
          osd2 && `OSD2:${osd2}`,
          osd3 && `OSD3:${osd3}`,
          osd4 && `OSD4:${osd4}`,
        ].filter(Boolean).join(' ');
        if (depth) parts.push(depth);
      }
      if (shedTag) parts.push(shedTag.trim());
      snipeDecodeInfo.textContent = parts.join('  ');
    }

    // AP target: use QSO dxCall if available, or last Snipe target
    if (qso.dxCall) apCall = qso.dxCall;

    // CQ response handling: sort by SNR, feed strongest to SM
    if (qso.state === QSO_STATE.CALLING && !qso.dxCall && callers.length > 0) {
      const useSNR = cqBestSnrCheck.checked;
      if (useSNR) callers.sort((a, b) => b.snr - a.snr);
      // Feed strongest (or first) caller to SM
      const best = callers[0];
      qso.setRxSnr(best.snr);
      const result = qso.processMessage(best.msg);
      if (result && !txMsg) txMsg = result;
      // Update target card
      if (qso.dxCall) {
        scoutTargetMsg.textContent = best.msg;
        scoutTargetInfo.textContent = `${best.freq.toFixed(0)} Hz  ${best.snr >= 0 ? '+' : ''}${Math.round(best.snr)} dB`;
      }
    }

    // Pileup notification
    if (callers.length > 1) {
      const others = callers.filter(c => c.call !== qso.dxCall).map(c => c.call);
      if (others.length > 0) {
        scoutTargetInfo.textContent += `  +${others.length}: ${others.join(' ')}`;
      }
    }

    // Auto TX / retry (skip if halted — user must explicitly resume)
    const txSlot = !isEven;
    if (halted) { /* user halted, don't auto-queue */ }
    else if (txMsg && autoCheck.checked) {
      const freq = currentMode === 'snipe' ? snipeDf : scoutDf;
      rxSlotEven = isEven; // remember DX's slot
      periodMgr.queueTx({ ...txMsg, freq }, txSlot);
      setStatus(`TX queued: ${qso.formatTx(txMsg)}`);
    } else if (!txMsg && qso.state !== QSO_STATE.IDLE && autoCheck.checked) {
      const prevState = qso.state;
      const prevDx = qso.dxCall;
      const retryTx = qso.retry();
      if (retryTx) {
        const freq = currentMode === 'snipe' ? snipeDf : scoutDf;
        periodMgr.queueTx({ ...retryTx, freq }, txSlot);
        setStatus(`Retry ${qso.retryInfo()}: ${qso.formatTx(retryTx)}`);
      } else if (prevDx) {
        // Max retries exceeded — log incomplete QSO
        qsoLog.add({
          dxCall: prevDx, dxGrid: qso.dxGrid,
          txReport: qso.txReport, rxReport: qso.rxReport,
          freq: currentMode === 'snipe' ? snipeDf : scoutDf,
        bandMHz: bandSelect.value,
          state: prevState, // incomplete
        });
        addChatMsg('sys', '', `QSO timeout: ${prevDx}`, 0);
        // Auto-switch back to Watch on failure in Call phase
        if (currentMode === 'snipe' && snipePhase === 'call') {
          setSnipePhase('watch');
        }
      }
    }

    // Snipe: unified RX list — append all decoded messages every period.
    // No Watch/Call filtering: both phases share the same list so history
    // is preserved across phase switches. Target messages are highlighted.
    if (currentMode === 'snipe') {
      const myCall = myCallInput.value.toUpperCase();
      const pickedUp = [];   // who DX responded to (DX picked up)
      const pileCallers = []; // who is calling DX, with their freq

      for (const m of msgs) {
        const upper = m.message.toUpperCase();
        const isTarget = apCall && upper.includes(apCall);

        // Track callers of current target
        if (apCall) {
          const words = m.message.split(/\s+/);
          const w0 = words[0]?.toUpperCase();
          const w1 = words[1]?.toUpperCase();
          // DX responded to someone → "picked up"
          if (w0 === apCall && w1 && w1 !== myCall) {
            pickedUp.push({ call: words[1], freq: Math.round(m.freq_hz) });
          }
          // Someone is calling DX → track their DF
          if (w1 === apCall && w0 && !['CQ','DE','QRZ','DX'].includes(w0) && w0 !== myCall) {
            pileCallers.push({ call: words[0], freq: Math.round(m.freq_hz) });
          }
        }

        const div = document.createElement('div');
        div.className = 'chat-msg rx';
        if (isTarget) div.classList.add('qso-active');
        const snrV = Math.round(m.snr_db);
        div.innerHTML = `<span class="col-freq">${Math.round(m.freq_hz)}</span>
          <span class="col-dt">${m.dt_sec >= 0 ? '+' : ''}${m.dt_sec.toFixed(1)}</span>
          <span class="col-snr">${snrV >= 0 ? '+' : ''}${snrV}</span>
          <span class="text">${m.message}</span>`;
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => {
          const words = m.message.split(/\s+/);
          const calls = [];
          for (const w of words) {
            if (['CQ','DE','QRZ','DX'].includes(w)) continue;
            if (w.length >= 3 && /[0-9]/.test(w)) calls.push(w);
            if (calls.length >= 2) break;
          }
          const isCq = /^(CQ|DE|QRZ)\b/.test(m.message);
          const target = calls[0] || '';
          const sender = isCq ? calls[0] : (calls[1] || calls[0] || '');
          if (target) {
            qso.setMyInfo(myCallInput.value, myGridInput.value);
            const tx = qso.callStation(target);
            apCall = target;
            snipeDxCall.textContent = target;
            clearTargetCards();
            snipeAltCall = (sender && sender !== target) ? sender : '';
            if (tx) queueTxMsg(tx.call1, tx.call2, tx.report);
            // Set BPF center to clicked station's frequency
            snipeBpf = Math.max(FREQ_MIN + 250, Math.min(FREQ_MAX - 250, Math.round(m.freq_hz)));
            if (snipePhase === 'call') {
              waterfall.targetLine = snipeBpf;
              waterfall.freqOffset = snipeBpf - FILTER_CENTER;
              waterfall.noiseWindow = { min: snipeBpf - 250, max: snipeBpf + 250 };
              cat.setFreq(snipeDialHz());
            }
            updateSnipeOverlay();
          }
        });
        div.classList.add('new');
        div.addEventListener('animationend', () => div.classList.remove('new'), { once: true });
        snipeRxList.appendChild(div);
      }

      if (msgs.length > 0) {
        pruneList(snipeRxList);
        snipeRxList.scrollTop = snipeRxList.scrollHeight;
        addUnread('snipe');
      }

      // Show pileup summary (single line, truncated)
      if (apCall) {
        const freqMap = Object.fromEntries(pileCallers.map(c => [c.call.toUpperCase(), c.freq]));
        const fmt = ({ call, freq }) => {
          const f = freqMap[call.toUpperCase()] ?? freq;
          return `${call}@${f}`;
        };
        const parts = [];
        if (pickedUp.length > 0) parts.push(`Picked: ${pickedUp.map(fmt).join(' ')}`);
        if (pileCallers.length > 0) parts.push(`Pile: ${pileCallers.map(fmt).join(' ')}`);
        snipeCallersEl.textContent = parts.join('   ');
      }
    }

    waterfall.drawLabels(msgs);
    waterfall.drawFreqAxis();

    // Sync AP target from QSO
    if (qso.dxCall) apCall = qso.dxCall;
  },
});

// TX fire from period manager
periodMgr.callbacks.onTxFire = async (tx) => {
  await transmit(tx.call1, tx.call2, tx.report, tx.freq);
};

// ── Halt / Reset (progressive: 1st tap = halt TX, 2nd tap = reset QSO) ─────
let halted = false;

btnHalt.addEventListener('click', async () => {
  if (!halted) {
    // First tap: cancel TX, stop audio output, but keep QSO state
    periodMgr.cancelTx();
    audioOut.stop();
    await cat.safePttOff();
    txActionsEl.querySelectorAll('.tx-active').forEach(b => b.classList.remove('tx-active'));
    timerEl.classList.remove('tx-on');
    halted = true;
    btnHalt.textContent = 'Reset';
    setStatus('Halted — tap Reset to abandon QSO');
  } else {
    // Second tap: reset QSO to IDLE
    if (qso.state !== QSO_STATE.IDLE && qso.dxCall) {
      qsoLog.add({
        dxCall: qso.dxCall, dxGrid: qso.dxGrid,
        txReport: qso.txReport, rxReport: qso.rxReport,
        freq: currentMode === 'snipe' ? snipeDf : scoutDf,
        bandMHz: bandSelect.value,
        state: qso.state,
      });
    }
    qso.reset();
    rxSlotEven = null;
    halted = false;
    btnHalt.textContent = 'Halt';
    updateQsoDisplay();
    setStatus('QSO reset');
  }
});

// Clear halted state when user explicitly queues TX (resume QSO)
function clearHalted() {
  if (halted) {
    halted = false;
    btnHalt.textContent = 'Halt';
  }
}

// ── Audio start/stop ────────────────────────────────────────────────────────
const logoEl = document.querySelector('.header h1');

function updateLiveUI() {
  btnStart.textContent = liveMode ? 'Stop Audio' : 'Start Audio';
  logoEl.classList.toggle('live', liveMode);
  if (!liveMode) timerEl.textContent = '--';
}

async function toggleAudio() {
  if (!liveMode) {
    if (!myCallInput.value.trim() || !myGridInput.value.trim()) {
      openSettings();
      setStatus('Enter callsign and grid');
      return;
    }
    const deviceId = deviceSelect.value;
    if (!deviceId) { openSettings(); setStatus('Select audio device'); return; }
    try {
      await capture.start(deviceId);
      capture.setGain(rxGainSlider.value / 100);
      localStorage.setItem('webft8-audio-in', deviceId);
      periodMgr.start();
      liveMode = true;
      updateLiveUI();
      setStatus('');
      waterfall.clear();
      const es = document.getElementById('empty-state');
      if (es) es.remove();
      closeSettings();
      // Auto-connect rig if saved model exists and port was previously granted
      if (!cat.connected) {
        const rigId = localStorage.getItem('webft8-rig');
        if (rigId && document.getElementById('rig-model').value) {
          try {
            if ('serial' in navigator) {
              const ports = await navigator.serial.getPorts();
              if (ports.length === 1) {
                cat.port = ports[0];
                cat.transportType = 'serial';
                await cat.connect(rigId);
                btnCat.textContent = 'Disconnect';
                catStatusEl.textContent = 'connected (auto)';
              }
            }
          } catch (_) { /* silent — user can connect manually */ }
        }
      }
    } catch (e) {
      setStatus(`Audio error: ${e.message || e}`);
    }
  } else {
    periodMgr.stop();
    capture.stop();
    liveMode = false;
    updateLiveUI();
    setStatus('Stopped');
  }
}

btnStart.addEventListener('click', toggleAudio);
logoEl.addEventListener('click', toggleAudio);

// ── Test tone ─────────────────────────────────────────────────────────────
const btnTestTone = document.getElementById('btn-test-tone');
btnTestTone.addEventListener('click', async () => {
  if (audioOut.playing) {
    audioOut.stop();
    if (cat.connected) await cat.safePttOff();
    btnTestTone.textContent = 'Test Tone';
    timerEl.classList.remove('tx-on');
    txMeter.style.width = '0%';
    txMeter.classList.remove('clip');
    txClip.classList.remove('active');
  } else {
    const df = currentMode === 'snipe' ? snipeDf : scoutDf;
    if (cat.connected) await cat.ptt(true);
    await audioOut.startTone(df, outputDeviceSelect.value || undefined);
    btnTestTone.textContent = `Stop (${df} Hz)`;
    timerEl.classList.add('tx-on');
    updateTxMeter();
  }
});

// ── CAT ─────────────────────────────────────────────────────────────────────

// Tauri mode: show COM port selector and populate it
const catPortField = document.getElementById('cat-port-field');
const catPortSelect = document.getElementById('cat-port');
const btnCatRefresh = document.getElementById('btn-cat-refresh');

async function refreshCatPorts() {
  const ports = await listSerialPorts();
  catPortSelect.innerHTML = '';
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.vid ? `${p.name} (${p.vid.toString(16)}:${p.pid.toString(16)})` : p.name;
    catPortSelect.appendChild(opt);
  }
  // Restore last used port
  const last = localStorage.getItem('webft8-cat-port');
  if (last) catPortSelect.value = last;
}

if (isTauriMode()) {
  catPortField.style.display = '';
  refreshCatPorts();
  btnCatRefresh.addEventListener('click', refreshCatPorts);
  // Tauri WebView shows a native "Save image" context menu on canvas right-clicks.
  // Suppress it globally — custom right-click handlers use e.preventDefault() anyway.
  document.addEventListener('contextmenu', e => e.preventDefault());
}

/** Apply rig initial state after any connect path (serial / BLE / auto).
 *  Sets DATA-USB mode, band frequency, and Wide filter (Watch phase start). */
async function rigSetup() {
  const baseHz = Math.round(parseFloat(bandSelect.value) * 1e6);
  await cat.setModeData();
  await new Promise(r => setTimeout(r, 200)); // settle after mode change
  await cat.setFreq(baseHz);
  await cat.setFilter(false); // Wide — Watch phase
}

btnCat.addEventListener('click', async () => {
  if (cat.connected) {
    await cat.disconnect();
    btnCat.textContent = 'Connect Rig';
    catStatusEl.textContent = 'disconnected';
    return;
  }
  if (!CatController.isSerialSupported()) {
    catStatusEl.textContent = 'Web Serial not supported';
    return;
  }
  try {
    const rigId = document.getElementById('rig-model').value;
    if (!rigId) { catStatusEl.textContent = 'Select a rig model'; return; }

    if (isTauriMode()) {
      const portName = catPortSelect.value;
      if (!portName) { catStatusEl.textContent = 'Select a COM port'; return; }
      await cat.connectTauri(rigId, portName);
      localStorage.setItem('webft8-cat-port', portName);
    } else {
      await cat.requestPort();
      await cat.connect(rigId);
    }

    btnCat.textContent = 'Disconnect';
    const profiles = getRigProfiles();
    catStatusEl.textContent = `connected (${profiles[rigId]?.label || rigId})`;
    localStorage.setItem('webft8-rig', rigId);
    await rigSetup();
  } catch (e) {
    await cat.disconnect();
    btnCat.textContent = 'Connect Rig';
    catStatusEl.textContent = `error: ${e.message || e}`;
  }
});

// ── CAT BLE ───────────────────────────────────────────────────────────────
btnCatBle.addEventListener('click', async () => {
  if (cat.connected) {
    await cat.disconnect();
    btnCatBle.textContent = 'Connect BLE';
    catStatusEl.textContent = 'disconnected';
    return;
  }
  try {
    // BLE is IC-705 only — auto-select rig profile
    const rigId = 'ic705';
    document.getElementById('rig-model').value = rigId;
    catStatusEl.textContent = 'pairing...';
    await cat.connectBle(rigId);
    btnCatBle.textContent = 'Disconnect';
    catStatusEl.textContent = 'BLE connected (IC-705)';
    localStorage.setItem('webft8-rig', rigId);
    await rigSetup();
  } catch (e) {
    catStatusEl.textContent = `BLE error: ${e.message || e}`;
  }
});

// ── Log export ─────────────────────────────────────────────────────────────
document.getElementById('btn-export-zip').addEventListener('click', () => qsoLog.exportZip());
document.getElementById('btn-clear-log').addEventListener('click', () => {
  if (confirm('Clear all QSO and RX logs?')) {
    qsoLog.clear();
    refreshQsoList();
  }
});

function refreshQsoList() {
  const el = document.getElementById('qso-list');
  const entries = qsoLog.getAll();
  const rxCount = qsoLog.getRxLog().length;
  const header = `<div style="color:var(--c-accent);margin-bottom:var(--sp-xs)">${entries.length} QSOs / ${rxCount} RX</div>`;
  if (!entries.length) { el.innerHTML = header + 'No QSOs'; return; }
  el.innerHTML = header + entries.slice(0, 50).map(e => {
    const t = e.utc.slice(0, 16).replace('T', ' ');
    const tag = e.state && e.state !== 'IDLE' ? ` [${e.state}]` : '';
    return `<div>${t} ${e.dxCall}${tag}</div>`;
  }).join('');
}

// Refresh QSO list when settings panel opens
btnSettings.addEventListener('click', refreshQsoList);

// ── File drop (on waterfall) ────────────────────────────────────────────────
wfWrap.addEventListener('dragover', e => { e.preventDefault(); wfWrap.classList.add('drop-over'); });
wfWrap.addEventListener('dragleave', () => wfWrap.classList.remove('drop-over'));
wfWrap.addEventListener('drop', e => {
  e.preventDefault(); wfWrap.classList.remove('drop-over');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });
document.getElementById('btn-open-wav').addEventListener('click', () => fileInput.click());

function parseWav(buf) {
  const view = new DataView(buf);
  if (String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== 'RIFF')
    throw new Error('Not a WAV file');
  const sr = view.getUint32(24, true), bps = view.getUint16(34, true), ch = view.getUint16(22, true);
  // sample rate is now passed through to decode_wav (resample_to_12k handles
  // any rate). Only enforce 16-bit / mono for the JS-side parser.
  if (bps !== 16) throw new Error(`${bps}-bit (need 16)`);
  if (ch !== 1) throw new Error(`${ch} ch (need mono)`);
  let off = 12;
  while (off < buf.byteLength - 8) {
    const id = String.fromCharCode(view.getUint8(off), view.getUint8(off+1), view.getUint8(off+2), view.getUint8(off+3));
    const sz = view.getUint32(off + 4, true);
    if (id === 'data') return { samples: new Int16Array(buf, off + 8, sz / 2), sampleRate: sr };
    off += 8 + sz; if (off % 2) off++;
  }
  throw new Error('No data chunk');
}

async function handleFile(file) {
  if (!wasmReady) return;
  // Auto-stop live audio if active
  if (liveMode) {
    periodMgr.stop();
    capture.stop();
    liveMode = false;
    btnStart.textContent = 'Start Audio';
    timerEl.textContent = '--';
  }
  try {
    const buf = await file.arrayBuffer();
    const { samples, sampleRate: wavRate } = parseWav(buf);

    // Render the waterfall at the WAV's actual rate. The next live-audio
    // start will reset this back to 6 kHz via capture.onSampleRate.
    waterfall.clear();
    waterfall.setSampleRate(wavRate);
    waterfall.pushSamples(samples);
    waterfall.drawFreqAxis();

    setStatus('Decoding...');
    await new Promise(r => setTimeout(r, 0));

    const t0 = performance.now();
    const results = await runDecode(samples, wavRate);
    const elapsed = performance.now() - t0;

    setStatus(`${results.length}d ${elapsed.toFixed(0)}ms`);
    chatList.innerHTML = '';

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      addChatMsg('rx', `${i+1}`, r.message, r.snr_db, null, r.freq_hz, r.dt_sec);
      // Plain object from the worker — no .free() needed.
    }
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
  }
}

// ── Splash helpers ──────────────────────────────────────────────────────────
const splashEl = document.getElementById('splash');
const splashStatus = document.getElementById('splash-status');
const splashProgress = document.getElementById('splash-progress');
const splashDiag = document.getElementById('splash-diag');
function splashStep(text, pct) {
  if (splashStatus) splashStatus.textContent = text;
  if (splashProgress) splashProgress.style.width = pct + '%';
}
function diagLine(label, value, cls) {
  if (!splashDiag) return;
  const line = document.createElement('div');
  line.innerHTML = `${label}: <span class="${cls || 'val'}">${value}</span>`;
  splashDiag.appendChild(line);
}
function splashDismiss() {
  // Copy diagnostics to empty-state before removing splash
  const diagDst = document.getElementById('diag-info');
  if (diagDst && splashDiag) {
    diagDst.innerHTML = splashDiag.innerHTML;
  }
  if (splashEl) {
    splashEl.classList.add('fade-out');
    setTimeout(() => splashEl.remove(), 600);
  }
}

// Build version — bumped on every commit-worthy change so the splash makes
// it obvious which build the user is actually running (catches stale PWA
// caches and helps when triaging "I refreshed but it didn't update").
const APP_VERSION = '2026-04-11-m';

// ── WASM init ───────────────────────────────────────────────────────────────
splashStep('Loading WASM...', 10);
init().then(async () => {
  wasmReady = true;
  splashStep('Benchmarking...', 30);
  diagLine('Version', APP_VERSION, 'ok');
  diagLine('WASM', 'loaded', 'ok');
  await new Promise(r => setTimeout(r, 0)); // yield to render splash

  // ── 1. Decode benchmark ──────────────────────────────────────────
  // Single-shot: 15 seconds of silence through the f32 production path
  // (Float32Array → worker → decode_wav_f32). Includes the postMessage
  // round-trip cost so the number reflects what the live decode actually
  // pays per period, and is therefore the right input for the static
  // shedding decision below.
  await decodeWorkerReadyPromise;
  const benchF32 = new Float32Array(180000); // 15s silence at 12kHz
  const bt0 = performance.now();
  await workerDecode('decode_wav_f32', [benchF32, 1, 12000]);
  const benchMs = performance.now() - bt0;
  console.log(`Bench: decode silence (f32, via worker) = ${benchMs.toFixed(0)} ms`);

  // Static shedding thresholds — tuned so Atom-class tablets (~400 ms) get
  // `sub off` preemptively instead of relying on runtime adaptive shedding,
  // which would otherwise miss the first 1-2 decodes after startup.
  const benchCls = benchMs > 800 ? 'bad' : benchMs > 300 ? 'warn' : 'ok';
  diagLine('Decode bench', `${benchMs.toFixed(0)} ms`, benchCls);

  if (benchMs > 800) {
    subDisabledAuto = true;
    apDisabledAuto = true;
    diagLine('Shedding', 'sub + AP off', 'warn');
  } else if (benchMs > 300) {
    subDisabledAuto = true;
    diagLine('Shedding', 'sub off', 'warn');
  } else {
    diagLine('Shedding', 'none', 'ok');
  }

  // ── 2. Audio system probe ────────────────────────────────────────
  splashStep('Probing audio...', 55);
  await new Promise(r => setTimeout(r, 0));

  // 2a. System output rate (AudioContext default — informational only).
  // This is NOT the rate we'll capture at; capture rate is determined by
  // the selected mic input device when audio is started.
  let systemRate = '?';
  try {
    const probeCtx = new AudioContext();
    systemRate = probeCtx.sampleRate;
    await probeCtx.close();
  } catch (e) {
    systemRate = 'error';
  }
  diagLine('System rate', `${systemRate} Hz`);
  diagLine('Waterfall rate', '6000 Hz (decimated)', 'ok');
  // The actual capture rate (mic device native rate) is logged to the
  // browser console when Start Audio is pressed.

  // 2c. Navigator / UA info
  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad/i.test(ua);
  const browserMatch = ua.match(/(Chrome|Firefox|Safari|Edg)\/(\d+)/);
  const browserTag = browserMatch ? `${browserMatch[1]}/${browserMatch[2]}` : 'unknown';
  diagLine('Browser', browserTag);
  diagLine('Platform', isMobile ? 'mobile' : 'desktop');

  splashStep('Ready', 90);
  await new Promise(r => setTimeout(r, 0));
  setStatus('Ready');

  // Load rig profiles and populate selector
  const profiles = await loadRigProfiles();
  const rigSelect = document.getElementById('rig-model');
  rigSelect.innerHTML = '<option value="">-- select rig --</option>';
  for (const [id, rig] of Object.entries(profiles)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = rig.label;
    rigSelect.appendChild(opt);
  }
  const savedRig = localStorage.getItem('webft8-rig');
  if (savedRig) rigSelect.value = savedRig;

  // Tauri auto-connect: silently reconnect if rig + port were saved
  if (isTauriMode() && savedRig) {
    const savedPort = localStorage.getItem('webft8-cat-port');
    if (savedPort) {
      try {
        await cat.connectTauri(savedRig, savedPort);
        btnCat.textContent = 'Disconnect';
        catStatusEl.textContent = `connected (${profiles[savedRig]?.label || savedRig})`;
        await rigSetup();
      } catch (e) {
        catStatusEl.textContent = `auto-connect failed: ${e.message || e}`;
      }
    }
  }

  // Show CAT / BLE buttons based on browser support
  if (CatController.isSerialSupported()) {
    btnCat.style.display = '';
  } else {
    btnCat.style.display = 'none';
  }
  if (CatController.isBleSupported()) {
    btnCatBle.style.display = '';
  }

  try {
    const devices = await capture.enumerateDevices();
    deviceSelect.innerHTML = '<option value="">-- select --</option>';
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.id; opt.textContent = d.label;
      deviceSelect.appendChild(opt);
    }
    // Enumerate audio output devices
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const outputs = allDevices.filter(d => d.kind === 'audiooutput');
    outputDeviceSelect.innerHTML = '<option value="">-- default --</option>';
    for (const d of outputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Output ${d.deviceId.slice(0, 8)}`;
      outputDeviceSelect.appendChild(opt);
    }
    // Restore saved device selections
    const savedIn = localStorage.getItem('webft8-audio-in');
    if (savedIn) {
      // Try exact match first; fall back to matching by label substring
      deviceSelect.value = savedIn;
      if (!deviceSelect.value) {
        for (const opt of deviceSelect.options) {
          if (opt.value && opt.value.startsWith(savedIn.slice(0, 16))) {
            deviceSelect.value = opt.value;
            break;
          }
        }
      }
    }
    const savedOut = localStorage.getItem('webft8-audio-out');
    if (savedOut) outputDeviceSelect.value = savedOut;

    // Ready — tap logo to start
    splashStep('Ready', 100);
    if (myCallInput.value && deviceSelect.value) {
      setStatus('Ready');
    }
  } catch (e) { console.warn('Audio devices:', e); }
  updateTxActions();
  // Dismiss splash — diagnostics persist in empty-state
  setTimeout(splashDismiss, 400);
}).catch(e => { setStatus(`Load failed: ${e}`); splashDismiss(); });

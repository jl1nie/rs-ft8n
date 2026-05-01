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
import { GpsNmeaSync } from './gps-nmea.js';
import { QsoLog } from './qso-log.js';

// ── Protocol selector (FT8 default; FT4/WSPR opt-in via settings cog) ──────
// Stored in localStorage as 'webft8-protocol' = 'ft8' | 'ft4' | 'wspr'.
// Accessed via the helpers below so any flag change propagates to period
// scheduler and decode dispatch without restarts.
function currentProtocol() {
  const v = localStorage.getItem('webft8-protocol');
  if (v === 'ft4' || v === 'wspr' || v === 'q65') return v;
  return 'ft8';
}

// Q65 sub-mode: 0 = Q65-30A (30 s slot), 1‥5 = Q65-60A‥E (60 s slot).
function currentQ65Submode() {
  const v = parseInt(localStorage.getItem('webft8-q65-submode') || '0', 10);
  return (v >= 0 && v <= 5) ? v : 0;
}
function currentQ65Fading() {
  return localStorage.getItem('webft8-q65-fading') === '1';
}
function currentQ65B90() {
  const v = parseFloat(localStorage.getItem('webft8-q65-b90') || '8');
  return (v >= 3 && v <= 15) ? v : 8;
}
function currentQ65FadingModel() {
  // 0 = Gaussian, 1 = Lorentzian
  return localStorage.getItem('webft8-q65-fading-model') === '1' ? 1 : 0;
}

function getSlotMs() {
  const p = currentProtocol();
  if (p === 'ft4') return 7500;
  if (p === 'wspr') return 120000;
  if (p === 'q65') return currentQ65Submode() === 0 ? 30000 : 60000;
  return 15000;
}

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
const headerEl = document.querySelector('.header');
const btnSettings = document.getElementById('btn-settings');
const btnNtp = document.getElementById('btn-ntp');
const dtStatusEl = document.getElementById('dt-status');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const wfCanvas = document.getElementById('waterfall');
const wfWrap = document.getElementById('waterfall-wrap');
const snipeOverlay = document.getElementById('snipe-overlay');
const snipeFreqLabel = document.getElementById('snipe-freq-label');
const chatList = document.getElementById('chat-list');
const snipeDxCall = document.getElementById('snipe-dx-call');
const snipeDxGridInput = document.getElementById('snipe-dx-grid');
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
const protocolSelect = document.getElementById('protocol-select');
const q65SubmodeSelect = document.getElementById('q65-submode');
const q65SubmodeField = document.getElementById('q65-submode-field');
const q65FadingToggle = document.getElementById('q65-fading-toggle');
const q65FadingCheck = document.getElementById('q65-fading');
const q65B90Field = document.getElementById('q65-b90-field');
const q65B90Slider = document.getElementById('q65-b90');
const q65B90Label = document.getElementById('q65-b90-label');
const q65FadingModelField = document.getElementById('q65-fading-model-field');
const q65FadingModelSelect = document.getElementById('q65-fading-model');

function syncQ65Visibility() {
  const isQ65 = currentProtocol() === 'q65';
  const fading = isQ65 && currentQ65Fading();
  if (q65SubmodeField)      q65SubmodeField.style.display      = isQ65 ? '' : 'none';
  if (q65FadingToggle)      q65FadingToggle.style.display      = isQ65 ? '' : 'none';
  if (q65B90Field)          q65B90Field.style.display          = fading ? '' : 'none';
  if (q65FadingModelField)  q65FadingModelField.style.display  = fading ? '' : 'none';
}

if (protocolSelect) {
  protocolSelect.value = currentProtocol();
  protocolSelect.addEventListener('change', () => {
    const v = protocolSelect.value;
    const normalized = (v === 'ft4' || v === 'wspr' || v === 'q65') ? v : 'ft8';
    localStorage.setItem('webft8-protocol', normalized);
    // Push the new slot length into the running scheduler (restarts it
    // safely) so the UI switches over without a page reload.
    periodMgr.setSlotMs(getSlotMs());
    syncQ65Visibility();
  });
}
if (q65SubmodeSelect) {
  q65SubmodeSelect.value = String(currentQ65Submode());
  q65SubmodeSelect.addEventListener('change', () => {
    localStorage.setItem('webft8-q65-submode', q65SubmodeSelect.value);
    // Q65-30A is 30s, Q65-60A‥E are 60s — push the new slot length.
    periodMgr.setSlotMs(getSlotMs());
  });
}
if (q65FadingCheck) {
  q65FadingCheck.checked = currentQ65Fading();
  q65FadingCheck.addEventListener('change', () => {
    localStorage.setItem('webft8-q65-fading', q65FadingCheck.checked ? '1' : '0');
    syncQ65Visibility();
  });
}
if (q65B90Slider) {
  q65B90Slider.value = String(currentQ65B90());
  if (q65B90Label) q65B90Label.textContent = q65B90Slider.value;
  q65B90Slider.addEventListener('input', () => {
    localStorage.setItem('webft8-q65-b90', q65B90Slider.value);
    if (q65B90Label) q65B90Label.textContent = q65B90Slider.value;
  });
}
if (q65FadingModelSelect) {
  q65FadingModelSelect.value = String(currentQ65FadingModel());
  q65FadingModelSelect.addEventListener('change', () => {
    localStorage.setItem('webft8-q65-fading-model', q65FadingModelSelect.value);
  });
}
syncQ65Visibility();
const deviceSelect = document.getElementById('audio-device');
const outputDeviceSelect = document.getElementById('audio-output-device');
const bandSelect = document.getElementById('band-header');
const subtractCheck = document.getElementById('subtract-mode');
const apCheck = document.getElementById('ap-mode');
const dtAutoCorrectCheck = document.getElementById('dt-auto-correct');
const strictnessSelect = document.getElementById('decode-strictness');
const btnCat = document.getElementById('btn-cat');
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
let apGrid = '';
let snipeBpfSet = false; // true once user has explicitly right-clicked to set BPF target
let lastDecodedMsgs = []; // msgs from last completed period (for GL reactive search)
let snipePhase = 'watch'; // 'watch' | 'call'
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
  // Show ■/↺ when TX is queued, active, or QSO in progress
  const showHalt = periodMgr.hasTxQueued() || isTx || halted || !!qso.dxCall;
  btnHalt.style.display = showHalt ? '' : 'none';
  if (showHalt) updateHaltBtn();
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

let _glSearchTimer = null;
snipeDxGridInput.addEventListener('input', () => {
  const val = snipeDxGridInput.value.trim().toUpperCase();
  snipeDxGridInput.value = val;
  apGrid = val;
  if (_glSearchTimer) clearTimeout(_glSearchTimer);
  if (val.length < 4) { snipeDxInfo.textContent = ''; return; }
  _glSearchTimer = setTimeout(() => {
    // Search last decoded CQ messages for matching grid prefix
    const match = lastDecodedMsgs.find(m => {
      const w = m.message.toUpperCase().split(/\s+/);
      return /^(CQ|DE|QRZ)/.test(w[0]) && w.length >= 3 && w[2].startsWith(val);
    });
    if (match) {
      const fullGrid = match.message.toUpperCase().split(/\s+/)[2];
      snipeDxGridInput.value = fullGrid;
      apGrid = fullGrid;
      const snrStr = `${match.snr_db >= 0 ? '+' : ''}${Math.round(match.snr_db)} dB`;
      snipeDxInfo.textContent = `${Math.round(match.freq_hz)} Hz ${snrStr}`;
    } else {
      snipeDxGridInput.value = '';
      apGrid = '';
      snipeDxInfo.textContent = '';
    }
  }, 600);
});

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
// Canvas drawing height is fixed at 280 px (Snipe mode max).  The wrapper
// clips to the mode-appropriate height (220/280 px) via overflow:hidden, and
// the canvas is pinned to the bottom so the most-recent rows are always visible.
// Only width is updated on resize; setting canvas.height would clear the buffer.
const WF_CANVAS_HEIGHT = 280;
function resizeCanvas() {
  const newW = wfCanvas.clientWidth;
  if (wfCanvas.width !== newW) wfCanvas.width = newW;
  if (wfCanvas.height !== WF_CANVAS_HEIGHT) wfCanvas.height = WF_CANVAS_HEIGHT;
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
  showToast('Audio disconnected');
};
// RX level meter from AudioWorklet peak reports.
capture.onPeak = (level) => {
  const pct = Math.min(level * 100, 100);
  rxMeter.style.width = pct + '%';
};
cat.onDisconnect = () => {
  btnCat.textContent = 'Connect';
  catStatusEl.textContent = 'disconnected';
  showToast('CAT disconnected');
  // BLE GPS queries stop automatically (BleTransport.disconnect clears timer)
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
  waterfall.dfLine = mode === 'scout' ? scoutDf : snipeDf;
  waterfall.targetLine = (mode === 'snipe' && snipeBpfSet) ? snipeBpf : null;
  waterfall.freqOffset = (mode === 'snipe' && snipePhase === 'call') ? (snipeBpf - FILTER_CENTER) : 0;
  if (mode === 'snipe') {
    snipePhaseHint.textContent = snipePhase === 'watch'
      ? (snipeBpfSet ? `full-band  BPF ${snipeBpf} Hz  DF ${snipeDf} Hz` : `full-band  DF ${snipeDf} Hz`)
      : `BPF ${snipeBpf} Hz  DF ${snipeDf} Hz`;
  }
  updateSnipeOverlay();
  waterfall.drawFreqAxis();
}

// ── Snipe BPF toggle ────────────────────────────────────────────────────────
const btnBpf = document.getElementById('btn-bpf');
const snipePhaseHint = document.getElementById('snipe-phase-hint');
const snipeCallersEl = document.getElementById('snipe-callers');

btnBpf.addEventListener('click', () => setSnipePhase(snipePhase === 'watch' ? 'call' : 'watch'));

// Allow manual callsign entry in the Snipe target field
snipeDxCall.addEventListener('input', () => {
  const pos = snipeDxCall.selectionStart;
  snipeDxCall.value = snipeDxCall.value.toUpperCase();
  snipeDxCall.setSelectionRange(pos, pos);
});
snipeDxCall.addEventListener('change', () => {
  const call = snipeDxCall.value.trim().toUpperCase();
  snipeDxCall.value = call;
  apCall = call;
  qso.dxCall = call;  // set target for AP filtering without starting TX
  updateQsoDisplay();
});

/** Compute shifted dial frequency so the physical filter covers snipeBpf. */
function snipeDialHz() {
  const baseHz = Math.round(parseFloat(bandSelect.value) * 1e6);
  return baseHz + (snipeBpf - FILTER_CENTER);
}

/**
 * Audio frequency (Hz) to pass to WASM encode/decode for Snipe TX.
 *
 * `snipeDf` is always stored in *band-offset* coordinates (= WF display
 * position = original-VFO-relative Hz).  In Call phase the VFO has been
 * shifted by freqOffset = snipeBpf − FILTER_CENTER, so the audio frequency
 * that lands at the correct band position is:
 *
 *   audio = snipeDf − freqOffset = snipeDf − (snipeBpf − FILTER_CENTER)
 *
 * In Watch phase freqOffset = 0, so audio = snipeDf directly.
 */
function snipeAudioHz() {
  return snipePhase === 'call'
    ? snipeDf - (snipeBpf - FILTER_CENTER)
    : snipeDf;
}

async function setSnipePhase(phase) {
  snipePhase = phase;
  btnBpf.classList.toggle('active', phase === 'call');
  const snipeView = document.getElementById('snipe-view');
  snipeView.classList.toggle('snipe-call-phase', phase === 'call');
  if (phase === 'watch') {
    waterfall.freqOffset = 0;
    waterfall.noiseWindow = null;
    waterfall.targetLine = snipeBpfSet ? snipeBpf : null;
    snipePhaseHint.textContent = snipeBpfSet
      ? `full-band  BPF ${snipeBpf} Hz  DF ${snipeDf} Hz`
      : `full-band  DF ${snipeDf} Hz`;
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
  waterfall.drawFreqAxis();
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

// NTP Sync is useful on any platform — desktop clocks can also drift (VMs, sleep/wake).
const isMobile = !isTauriMode() && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

function applyDtAutoCorrectUi() {
  const on = dtAutoCorrectCheck.checked;
  periodMgr.setDtAutoCorrect(on);
  // NTP button is independent of FT8 auto-correct — always enabled
  if (!on) {
    dtStatusEl.textContent = '';
    dtStatusEl.style.display = 'none';
  }
}
dtAutoCorrectCheck.addEventListener('change', applyDtAutoCorrectUi);

btnNtp.addEventListener('click', async () => {
  btnNtp.disabled = true;
  btnNtp.textContent = 'Syncing...';
  await syncNtpOffset();
  btnNtp.disabled = false;
  btnNtp.textContent = 'NTP Sync';
});

// ── GPS NMEA sync (IC-705 USB-B) ───────────────────────────────────────────
const btnGpsSync = document.getElementById('btn-gps-sync');
let gpsSync = null;

// Hide GPS button only when neither Web Serial nor Tauri native serial is available
if (!GpsNmeaSync.isSupported()) {
  btnGpsSync.style.display = 'none';
}

function _applyGpsOffset(offsetSec, label) {
  periodMgr.setClockOffset(offsetSec);
  const sign = offsetSec >= 0 ? '+' : '';
  setStatus(`${label}: ${sign}${offsetSec.toFixed(2)} s`);
}

btnGpsSync.addEventListener('click', async () => {
  if (gpsSync) {
    await gpsSync.disconnect();
    gpsSync = null;
    btnGpsSync.textContent = 'GPS Sync';
    return;
  }
  gpsSync = new GpsNmeaSync(_applyGpsOffset);
  try {
    let portName;
    if (isTauriMode()) {
      // In Tauri, show a port selection prompt using the native port list
      const ports = await listSerialPorts();
      if (!ports.length) throw new Error('No serial ports found');
      // Build a simple selection string: "COM8 (VID:0C28 PID:0003)"
      const choices = ports.map(p =>
        `${p.name}${p.vid ? ` (${p.vid.toString(16).toUpperCase().padStart(4,'0')}:${p.pid.toString(16).toUpperCase().padStart(4,'0')})` : ''}`
      );
      const choice = prompt(
        'Select GPS port (IC-705 USB-B):\n' + choices.map((c, i) => `${i}: ${c}`).join('\n'),
        '0'
      );
      if (choice === null) { gpsSync = null; return; }
      const idx = parseInt(choice, 10);
      if (isNaN(idx) || idx < 0 || idx >= ports.length) throw new Error('Invalid selection');
      portName = ports[idx].name;
    }
    await gpsSync.connect(portName);
    btnGpsSync.textContent = 'GPS ●';
  } catch (e) {
    gpsSync = null;
    setStatus('GPS: ' + (e.message || e));
  }
});
settingsOverlay.addEventListener('click', closeSettings);
document.getElementById('btn-close-settings').addEventListener('click', closeSettings);

// Open settings on first launch (no callsign set)
if (!myCallInput.value) setTimeout(openSettings, 500);

// ── Snipe overlay on waterfall ──────────────────────────────────────────────
function updateSnipeOverlay() {
  if (currentMode !== 'snipe' || !snipeBpfSet) {
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
  snipeBpfSet = true;
  // Show BPF target overlay in both Watch and Call modes
  waterfall.targetLine = snipeBpf;
  waterfall.noiseWindow = { min: snipeBpf - 250, max: snipeBpf + 250 };
  if (snipePhase === 'call') {
    waterfall.freqOffset = snipeBpf - FILTER_CENTER;
    await cat.setFreq(snipeDialHz());
  }
  updateSnipeOverlay();
  snipePhaseHint.textContent = snipePhase === 'watch'
    ? `full-band  BPF ${snipeBpf} Hz  DF ${snipeDf} Hz`
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

function updateQsoDisplay() {
  const state = qso.state;

  // Snipe view
  qsoLabel.textContent = state;
  snipeDxCall.value = qso.dxCall || '';
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

    return;
  }

  // QSO active: [CQ] [相手コール] [73]
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

  // 相手コール — queues the appropriate TX for the current state
  // Label: "3Y0Z ▸ PM95" / "3Y0Z ▸ R-05" / "3Y0Z ▸ 73" so operator sees what will be sent
  const tx = qso.getNextTx();
  if (tx) {
    const dxBtn = document.createElement('button');
    dxBtn.className = 'state-nav-btn current-state';
    dxBtn.textContent = dx;
    dxBtn.addEventListener('click', () => queueTxMsg(tx.call1, tx.call2, tx.report));
    txActionsEl.appendChild(dxBtn);
  }

  // 73 — force FINAL and queue
  if (state !== QSO_STATE.FINAL) {
    const btn73 = document.createElement('button');
    btn73.className = 'state-nav-btn';
    btn73.textContent = '73';
    btn73.addEventListener('click', () => {
      const t = qso.forceState(QSO_STATE.FINAL);
      if (t) queueTxMsg(t.call1, t.call2, t.report);
      updateTxActions(); updateQsoDisplay();
    });
    txActionsEl.appendChild(btn73);
  }
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
  // Protocol routing: FT4 → `decode_ft4_*`, WSPR → `decode_wspr_*`,
  //                   Q65 → `decode_q65_*` (basic BP or fast-fading).
  const isF32 = samples instanceof Float32Array;
  const proto = currentProtocol();
  const ft4   = proto === 'ft4';
  const wspr  = proto === 'wspr';
  const q65   = proto === 'q65';
  let fnDecodeName, fnSniperName, fnSubtractName, fnPhase1Name, fnPhase2Name;
  if (q65) {
    // Pick fast-fading variant only when the user enabled it (EME
    // recordings with measurable Doppler spread). Plain Q65 BP scan
    // covers the terrestrial / ionoscatter common case.
    const fading = currentQ65Fading();
    if (fading) {
      fnDecodeName = isF32 ? 'decode_q65_wav_fading_f32' : 'decode_q65_wav_fading';
    } else {
      fnDecodeName = isF32 ? 'decode_q65_wav_f32'        : 'decode_q65_wav';
    }
    fnSniperName   = null; // no sniper / Phase1+2 / subtract for Q65 — WAV-drop path only
    fnSubtractName = null;
    fnPhase1Name   = null;
    fnPhase2Name   = null;
  } else if (wspr) {
    fnDecodeName   = isF32 ? 'decode_wspr_wav_f32' : 'decode_wspr_wav';
    fnSniperName   = null; // no sniper mode for WSPR yet (coarse-only path)
    fnSubtractName = null;
    fnPhase1Name   = null;
    fnPhase2Name   = null;
  } else if (ft4) {
    fnDecodeName   = isF32 ? 'decode_ft4_wav_f32'          : 'decode_ft4_wav';
    fnSniperName   = isF32 ? 'decode_ft4_sniper_f32'       : 'decode_ft4_sniper';
    fnSubtractName = isF32 ? 'decode_ft4_wav_subtract_f32' : 'decode_ft4_wav_subtract';
    fnPhase1Name   = null;
    fnPhase2Name   = null;
  } else {
    fnDecodeName   = isF32 ? 'decode_wav_f32'     : 'decode_wav';
    fnSniperName   = isF32 ? 'decode_sniper_f32'  : 'decode_sniper';
    fnSubtractName = null;
    fnPhase1Name   = isF32 ? 'decode_phase1_f32'  : 'decode_phase1';
    fnPhase2Name   = isF32 ? 'decode_phase2_f32'  : 'decode_phase2';
  }

  // Subtract: use if enabled and not auto-disabled
  const useSub = subtractCheck.checked && !subDisabledAuto;
  const strict = parseInt(strictnessSelect.value, 10);
  const sr = sampleRate || capture.getSampleRate();

  let results;
  if (q65) {
    // Q65: one-shot scan. Sub-mode (0..5) is a required parameter
    // both for the basic BP path and the fast-fading variant.
    const submode = currentQ65Submode();
    if (currentQ65Fading()) {
      // (samples, submode, b90_ts, model, sample_rate)
      results = await workerDecode(fnDecodeName, [
        samples, submode, currentQ65B90(), currentQ65FadingModel(), sr,
      ]);
    } else {
      // (samples, submode, sample_rate)
      results = await workerDecode(fnDecodeName, [samples, submode, sr]);
    }
  } else if (wspr) {
    // WSPR: one-shot scan. No subtract, no phase split, no AP yet.
    // sampleRate argument uses the same signature convention but the
    // decoder takes only (samples, sample_rate).
    results = await workerDecode(fnDecodeName, [samples, sr]);
  } else if (useSub) {
    if (ft4) {
      // FT4 one-shot subtract (internal 3-pass SIC).
      results = await workerDecode(fnSubtractName, [samples, strict, sr]);
    } else {
      // FT8 pipelined decode: Phase 1 (fast, ~200ms) + Phase 2 (subtract,
      // budget permitting). Phase 1 caches audio + FFT in WASM thread_local;
      // Phase 2 reuses them.
      const p1 = await workerDecode(fnPhase1Name, [samples, sr]);
      const p1Ms = performance.now() - t0;

      // Show Phase 1 results immediately while Phase 2 runs
      if (onPartial && p1.length > 0) onPartial(p1);

      let p2 = [];
      if (BUDGET_MS - p1Ms > 200) {
        p2 = await workerDecode(fnPhase2Name, [strict]);
      }
      results = [...p1, ...p2];
    }
  } else {
    // Non-subtract path
    results = await workerDecode(fnDecodeName, [samples, strict, sr]);
  }

  // AP supplement: enabled by checkbox, auto-disabled by budget.
  // Skip AP when calling CQ (no target yet — AP would only produce false positives)
  // or in WSPR / Q65 mode (no sniper entry point exposed; Q65 has its
  // own AP / AP-list strategies but they're not wired in this UI yet).
  const isCqWaiting = qso.state === QSO_STATE.CALLING && !qso.dxCall;
  const useAp = apCheck.checked && !apDisabledAuto && !isCqWaiting && !wspr && !q65;
  const apTarget = useAp
    ? (apCall || (currentMode === 'scout' && qso.dxCall ? qso.dxCall : ''))
    : '';

  const apGridActive = useAp ? apGrid : '';
  if (apTarget || apGridActive) {
    const found = apTarget && results.some(r => r.message.toUpperCase().includes(apTarget));
    if (!found) {
      const freq = currentMode === 'snipe' ? snipeAudioHz() : scoutDf;
      const myCall = myCallInput.value.trim().toUpperCase();
      const eqOn = eqModeSelect.value === 'adaptive';
      // Watch phase: CQ-style AP (pass empty mycall + grid).
      // Call phase: QSO AP (pass real mycall, no grid — grid bits overlap report).
      const apMyCall = (currentMode === 'snipe' && snipePhase === 'call') ? myCall : '';
      const apGridVal = (currentMode === 'snipe' && snipePhase === 'call') ? '' : apGridActive;
      const ap = await workerDecode(
        fnSniperName,
        [samples, freq, apTarget, apGridVal, apMyCall, eqOn, sr],
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
  const freq = currentMode === 'snipe' ? snipeAudioHz() : scoutDf;
  const txSlot = rxSlotEven !== null ? !rxSlotEven : !periodMgr.getCurrentPeriod().isEven;
  periodMgr.queueTx({ call1, call2, report, freq }, txSlot);
  setStatus(`TX queued: ${call1} ${call2} ${report}`);
}

// ── NTP clock-offset sync (HTTP-based) ────────────────────────────────────
// Fetches UTC time from a public API, compares with Date.now(), and applies
// the measured offset to the period manager.  Works without NTP UDP access.
async function syncNtpOffset() {
  // HTTP-based time sync (UDP NTP is not accessible from browsers).
  // Each API has CORS enabled and returns UTC time in JSON.
  // Strategy: take 3 measurements per API, keep the one with minimum RTT.
  // Minimum RTT ≈ most symmetric path → best midpoint estimate (standard NTP practice).
  const APIS = [
    { url: 'https://time.cloudflare.com/',
      parse: d => new Date(d.time).getTime() },
    { url: 'https://worldtimeapi.org/api/timezone/UTC',
      parse: d => new Date(d.utc_datetime).getTime() },
    { url: 'https://timeapi.io/api/time/current/zone?timeZone=UTC',
      parse: d => new Date(d.dateTime + 'Z').getTime() },
  ];

  for (const api of APIS) {
    try {
      let best = null;
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const resp = await fetch(api.url, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        const t1 = Date.now();
        if (!resp.ok) break;
        const data = await resp.json();
        const serverMs = api.parse(data);
        if (isNaN(serverMs)) break;
        const rttMs = t1 - t0;
        const offsetSec = (t0 + rttMs / 2 - serverMs) / 1000;
        if (!best || rttMs < best.rttMs) best = { offsetSec, rttMs };
      }
      if (!best) continue;

      periodMgr.setClockOffset(best.offsetSec);
      const sign = best.offsetSec >= 0 ? '+' : '';
      const msg = `NTP: DT ${sign}${best.offsetSec.toFixed(2)} s`;
      showToast(msg);
      return best.offsetSec;
    } catch (_) { /* try next API */ }
  }
  showToast('NTP sync failed');
  return null;
}

// ── Transmit (called by period manager at period boundary) ─────────────────
async function transmit(call1, call2, report, freq) {
  if (!wasmReady) return;
  freq = freq || (currentMode === 'snipe' ? snipeAudioHz() : scoutDf);
  txActive = true;
  updateHaltBtn();
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
    txActive = false;
    updateHaltBtn();
    setStatus('TX complete');
  } catch (e) {
    txActionsEl.querySelectorAll('.tx-active').forEach(b => b.classList.remove('tx-active'));
    timerEl.classList.remove('tx-on');
    txActive = false;
    updateHaltBtn();
    setStatus(`TX error: ${e.message || e}`);
    await cat.safePttOff();
  }
}

// ── Period manager (slot length follows FT8/FT4 selector) ──────────────────
const periodMgr = new FT8PeriodManager({
  onTick: (rem) => {
    // Recover from Chrome auto-suspending the AudioContext after inactivity.
    // The suspension causes the worklet to stop sending audio, which stalls
    // snapshot() and breaks the decode loop.  Resume proactively each tick.
    if (capture.audioCtx?.state === 'suspended') {
      capture.audioCtx.resume().catch(() => {});
    }
    // rem is already time-until-next-boundary-fire (from _nextFireMs in ft8-period.js).
    // Timer turns yellow when |DT offset| >= 1.0 s.
    timerEl.textContent = `${Math.ceil(rem)}s`;
    const dtWarn = Math.abs(periodMgr.clockOffsetSec) >= 1.0;
    timerEl.classList.toggle('dt-corrected', dtWarn);
    headerEl.classList.toggle('dt-warn', dtWarn);
  },
  onClockOffset: (offsetSec) => {
    // Show DT correction value below the NTP button.
    if (Math.abs(offsetSec) > 0.1) {
      const sign = offsetSec >= 0 ? '+' : '';
      dtStatusEl.textContent = `DT ${sign}${offsetSec.toFixed(2)} s`;
      dtStatusEl.style.display = '';
    } else {
      dtStatusEl.textContent = '';
      dtStatusEl.style.display = 'none';
    }
  },
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
    const utc = new Date(periodIndex * getSlotMs()).toISOString().substr(11, 8);
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
        pruneList(chatList);
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
        // Extract grid from CQ messages: "CQ DXCALL GRID" — words[2] if Maidenhead
        const clickGrid = (isCq && words.length >= 3 && /^[A-R]{2}[0-9]{2}/i.test(words[2]))
          ? words[2].toUpperCase() : '';
        addChatMsg('rx', utc, msg, snr, clickCall ? () => {
          qso.setMyInfo(myCallInput.value, myGridInput.value);
          const tx = qso.callStation(clickCall);
          apCall = clickCall;
          apGrid = clickGrid;
          snipeDxGridInput.value = clickGrid;
          snipeBpf = Math.max(FREQ_MIN + 250, Math.min(FREQ_MAX - 250, Math.round(freq)));
          snipeBpfSet = true;
          snipeDf = snipeBpf; // sync TX to new target (band-offset coords)
          clearTargetCards();
          if (tx) queueTxMsg(tx.call1, tx.call2, tx.report);
          // In Call phase: update BPF center and VFO to track the tapped station
          if (currentMode === 'snipe' && snipePhase === 'call') {
            waterfall.targetLine = snipeBpf;
            waterfall.freqOffset = snipeBpf - FILTER_CENTER;
            waterfall.noiseWindow = { min: snipeBpf - 250, max: snipeBpf + 250 };
            cat.setFreq(snipeDialHz());
          }
          updateSnipeOverlay();
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

    // Feed DT values to clock-offset estimator.
    // Only use BP/OSD results with clean sync (dt_sec is reliable);
    // skip AP-assisted passes which may be anchored to a known signal.
    {
      const dtVals = results
        .filter(r => (r.pass ?? 0) <= 5 && r.dt_sec != null)
        .map(r => r.dt_sec);
      if (dtVals.length >= 1) periodMgr.addDtSamples(dtVals);
    }

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
    //
    // Timing problem: onPeriodEnd(N) runs inside the period-N+1 boundary
    // callback.  When decode finds a response needed in the odd slot and we
    // are already IN the odd period N+1, simply queuing puts the TX in N+3
    // (30 s later) because the next matching slot after N+1 is N+3.
    //
    // Fix: if the current period is already the right TX slot AND decode
    // finished within the 2.4 s TX window, fire immediately (fire-and-forget,
    // same as onTxFire).  Otherwise fall back to queuing for the next slot.
    const txSlot = !isEven;   // false=odd when DX used even, true=even when DX used odd
    // Helper: fire TX immediately if decode finished within the 2.4 s TX window
    // and the current period is already the correct slot.  Otherwise queue.
    const _fireTx = (tx, label) => {
      const freq = currentMode === 'snipe' ? snipeAudioHz() : scoutDf;
      const { isEven: curIsEven, elapsed } = periodMgr.getCurrentPeriod();
      rxSlotEven = isEven; // remember which slot DX used
      if (txSlot === curIsEven && elapsed < 2.4) {
        // Fire-and-forget: do NOT await — same as onTxFire behaviour
        transmit(tx.call1, tx.call2, tx.report, tx.freq ?? freq);
      } else {
        periodMgr.queueTx({ ...tx, freq }, txSlot);
        setStatus(label ?? `TX queued: ${qso.formatTx(tx)}`);
      }
    };

    if (halted) { /* user halted, don't auto-queue */ }
    else if (txMsg && autoCheck.checked) {
      _fireTx(txMsg);
    } else if (!txMsg && qso.state !== QSO_STATE.IDLE && autoCheck.checked) {
      const prevState = qso.state;
      const prevDx = qso.dxCall;
      const retryTx = qso.retry();
      if (retryTx) {
        _fireTx(retryTx, `Retry ${qso.retryInfo()}: ${qso.formatTx(retryTx)}`);
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

    // Snipe: track who DX responded to (Picked summary)
    // Decoded from DX's TX period — always visible. Also count unread badge.
    if (currentMode === 'snipe' && apCall && msgs.length > 0) {
      const myCall = myCallInput.value.toUpperCase();
      const pickedUp = [];
      for (const m of msgs) {
        const words = m.message.split(/\s+/);
        const w0 = words[0]?.toUpperCase();
        const w1 = words[1]?.toUpperCase();
        if (w0 === apCall && w1 && w1 !== myCall) {
          pickedUp.push({ call: words[1], freq: Math.round(m.freq_hz) });
        }
      }
      if (pickedUp.length > 0) {
        const fmt = ({ call, freq }) => `${call}@${freq}`;
        snipeCallersEl.textContent = `Picked: ${pickedUp.map(fmt).join(' ')}`;
      } else {
        snipeCallersEl.textContent = '';
      }
      addUnread('snipe');
    }

    lastDecodedMsgs = msgs;
    waterfall.drawLabels(msgs);
    waterfall.drawFreqAxis();

    // Sync AP target from QSO
    if (qso.dxCall) apCall = qso.dxCall;
  },
}, getSlotMs());

// Apply DT auto-correct initial UI state (periodMgr now initialized)
applyDtAutoCorrectUi();

// TX fire from period manager
periodMgr.callbacks.onTxFire = async (tx) => {
  await transmit(tx.call1, tx.call2, tx.report, tx.freq);
};

// ── Halt / Reset ────────────────────────────────────────────────────────────
// ■ (TX active/queued) — cancels TX, keeps QSO state
// ↺ (TX idle)          — logs partial QSO if any, resets to IDLE
let halted = false;
let txActive = false;  // true while transmit() is running (audio playing)

function updateHaltBtn() {
  // ■ when TX is queued OR actively transmitting
  btnHalt.textContent = (periodMgr.hasTxQueued() || txActive) ? '■' : '↺';
}

btnHalt.addEventListener('click', async () => {
  if (periodMgr.hasTxQueued() || txActive) {
    // Cancel TX, stop audio, keep QSO state
    periodMgr.cancelTx();
    audioOut.stop();
    await cat.safePttOff();
    txActionsEl.querySelectorAll('.tx-active').forEach(b => b.classList.remove('tx-active'));
    timerEl.classList.remove('tx-on');
    halted = true;
    updateHaltBtn();
    setStatus('TX halted — tap ↺ to reset QSO');
  } else {
    // Reset QSO, log partial QSO if applicable
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
    updateHaltBtn();
    updateQsoDisplay();
    setStatus('QSO reset');
  }
});

// Clear halted state when user explicitly queues TX (resume QSO)
function clearHalted() {
  if (halted) {
    halted = false;
    updateHaltBtn();
  }
}

// ── Audio start/stop ────────────────────────────────────────────────────────
const logoEl = document.querySelector('.header h1');

function updateLiveUI() {
  btnStart.textContent = liveMode ? 'Stop Audio' : 'Start Audio';
  logoEl.classList.toggle('live', liveMode);
  if (!liveMode) {
    timerEl.textContent = '--';
    timerEl.classList.remove('dt-corrected');
  }
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
    const df = currentMode === 'snipe' ? snipeAudioHz() : scoutDf;
    if (cat.connected) await cat.ptt(true);
    await audioOut.startTone(df, outputDeviceSelect.value || undefined);
    btnTestTone.textContent = `Stop (${df} Hz)`;
    timerEl.classList.add('tx-on');
    updateTxMeter();
  }
});

// ── CAT ─────────────────────────────────────────────────────────────────────

const catPortField = document.getElementById('cat-port-field');
const catPortSelect = document.getElementById('cat-port');
const btnCatRefresh = document.getElementById('btn-cat-refresh');
const transportSerialRadio = document.getElementById('transport-serial');
const transportBleRadio = document.getElementById('transport-ble');
const transportBleLabel = document.getElementById('transport-ble-label');
const rigModelField = document.getElementById('rig-model-field');
const bleRigLabel = document.getElementById('ble-rig-label');

/** Update UI visibility based on selected transport and environment. */
function applyTransportUi() {
  const isBle = transportBleRadio.checked;
  rigModelField.style.display = isBle ? 'none' : '';
  bleRigLabel.style.display = isBle ? '' : 'none';
  catPortField.style.display = (!isBle && isTauriMode()) ? '' : 'none';
}

// BLE radio: hide entirely if BLE not supported
if (!CatController.isBleSupported()) {
  transportBleLabel.style.display = 'none';
}

// Restore saved transport
const savedTransport = localStorage.getItem('webft8-transport');
if (savedTransport === 'ble' && CatController.isBleSupported()) {
  transportBleRadio.checked = true;
}

applyTransportUi();

transportSerialRadio.addEventListener('change', applyTransportUi);
transportBleRadio.addEventListener('change', applyTransportUi);

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
    btnCat.textContent = 'Connect';
    catStatusEl.textContent = 'disconnected';
    return;
  }

  const isBle = transportBleRadio.checked;

  if (isBle) {
    // ── BLE path (IC-705 only) ────────────────────────────────────────────
    try {
      const rigId = 'ic705';
      catStatusEl.textContent = 'pairing...';
      await cat.connectBle(rigId);
      btnCat.textContent = 'Disconnect';
      catStatusEl.textContent = 'BLE connected (IC-705)';
      localStorage.setItem('webft8-rig', rigId);
      localStorage.setItem('webft8-transport', 'ble');
      showToast('BLE connected (IC-705)');

      // Enable GPS UTC sync via CI-V position query (0x23 0x00) over BLE
      if (cat.ble && dtAutoCorrectCheck.checked) {
        cat.ble.onGpsTime = (offsetSec) => _applyGpsOffset(offsetSec, 'GPS(BLE)');
        cat.ble._startGpsQuery();
      }

      await rigSetup();
    } catch (e) {
      btnCat.textContent = 'Connect';
      catStatusEl.textContent = `BLE error: ${e.message || e}`;
      showToast(`BLE error: ${e.message || e}`);
    }
  } else {
    // ── Serial path (Web Serial / Tauri) ──────────────────────────────────
    if (!CatController.isSerialSupported()) {
      catStatusEl.textContent = 'Web Serial not supported';
      showToast('Web Serial not supported');
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
      const label = profiles[rigId]?.label || rigId;
      catStatusEl.textContent = `connected (${label})`;
      localStorage.setItem('webft8-rig', rigId);
      localStorage.setItem('webft8-transport', 'serial');
      showToast(`Connected: ${label}`);
      await rigSetup();
    } catch (e) {
      await cat.disconnect();
      btnCat.textContent = 'Connect';
      catStatusEl.textContent = `error: ${e.message || e}`;
      showToast(`CAT error: ${e.message || e}`);
    }
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
const APP_VERSION = '0.4.11';

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
        localStorage.setItem('webft8-transport', 'serial');
        transportSerialRadio.checked = true;  // sync radio to actual connected transport
        await rigSetup();
      } catch (e) {
        catStatusEl.textContent = `auto-connect failed: ${e.message || e}`;
      }
    }
  }

  // Show/hide Connect button based on whether any transport is supported
  if (!CatController.isSerialSupported() && !CatController.isBleSupported()) {
    btnCat.style.display = 'none';
  }

  // Re-apply transport UI now that profiles are loaded
  applyTransportUi();

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

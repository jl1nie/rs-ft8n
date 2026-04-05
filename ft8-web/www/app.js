import init, { decode_wav, decode_wav_subtract, decode_sniper, encode_ft8 } from '../pkg/ft8_web.js';
import { Waterfall } from './waterfall.js';
import { AudioCapture } from './audio-capture.js';
import { AudioOutput } from './audio-output.js';
import { FT8PeriodManager } from './ft8-period.js';
import { QsoManager, QSO_STATE } from './qso.js';
import { CatController, loadRigProfiles, getRigProfiles } from './cat.js';
import { QsoLog } from './qso-log.js';

// ── Elements ────────────────────────────────────────────────────────────────
const body = document.body;
const tabScout = document.getElementById('tab-scout');
const tabSnipe = document.getElementById('tab-snipe');
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
const snipeDxMsg = document.getElementById('snipe-dx-msg');
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
const scoutDots = [
  document.getElementById('scout-dot-1'), document.getElementById('scout-dot-2'),
  document.getElementById('scout-dot-3'), document.getElementById('scout-dot-4'),
];
const myCallInput = document.getElementById('my-call');
const myGridInput = document.getElementById('my-grid');
const deviceSelect = document.getElementById('audio-device');
const outputDeviceSelect = document.getElementById('audio-output-device');
const bandSelect = document.getElementById('band-freq');
const bandHeader = document.getElementById('band-header');
const subtractCheck = document.getElementById('subtract-mode');
const apCheck = document.getElementById('ap-mode');
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
let snipePhase = 'watch'; // 'watch' | 'call'
let snipeAltCall = ''; // call2 (sender) from last tapped Snipe message
let rxSlotEven = null; // even/odd of the period where DX was last heard
let lastDecodeMs = 0; // last decode duration for timer display
let lastPeriodIndex = -1; // track period changes for separator
let apDisabledAuto = false; // true if AP was auto-disabled due to timeout
let subDisabledAuto = false; // true if subtract was auto-disabled due to timeout
const FREQ_MIN = 100, FREQ_MAX = 3000;

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
  snipeTxLine.textContent = text;
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
  snipeDxMsg.textContent = '';
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

  // Scout target card: show during active QSO
  const active = state !== 'IDLE' && qso.dxCall;
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
const waterfall = new Waterfall(wfCanvas);
waterfall.dfLine = scoutDf; // show DF line on startup

// ── Core modules ────────────────────────────────────────────────────────────
const audioOut = new AudioOutput();
const cat = new CatController();
const qsoLog = new QsoLog();

// Restore settings
myCallInput.value = localStorage.getItem('rs-ft8n-mycall') || '';
myGridInput.value = localStorage.getItem('rs-ft8n-mygrid') || '';
myCallInput.addEventListener('change', () => localStorage.setItem('rs-ft8n-mycall', myCallInput.value));
myGridInput.addEventListener('change', () => localStorage.setItem('rs-ft8n-mygrid', myGridInput.value));
// Sync header band selector from settings band selector
for (const opt of bandSelect.options) {
  const o = document.createElement('option');
  o.value = opt.value;
  o.textContent = opt.value; // short label in header
  bandHeader.appendChild(o);
}
const savedBand = localStorage.getItem('rs-ft8n-band');
if (savedBand) { bandSelect.value = savedBand; bandHeader.value = savedBand; }
function syncBand(src) {
  bandSelect.value = src.value;
  bandHeader.value = src.value;
  localStorage.setItem('rs-ft8n-band', src.value);
}
bandSelect.addEventListener('change', () => syncBand(bandSelect));
bandHeader.addEventListener('change', () => syncBand(bandHeader));
deviceSelect.addEventListener('change', () => localStorage.setItem('rs-ft8n-audio-in', deviceSelect.value));
outputDeviceSelect.addEventListener('change', () => localStorage.setItem('rs-ft8n-audio-out', outputDeviceSelect.value));

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

myCallInput.addEventListener('input', () => qso.setMyInfo(myCallInput.value, myGridInput.value));
myGridInput.addEventListener('input', () => qso.setMyInfo(myCallInput.value, myGridInput.value));

const capture = new AudioCapture({
  onWaterfall: (samples) => waterfall.pushSamples(samples),
  onBufferFull: () => {},
});
capture._onDisconnect = () => {
  periodMgr.stop();
  liveMode = false;
  updateLiveUI();
  setStatus('Audio disconnected');
  showToast('Audio disconnected');
};
cat.onDisconnect = () => {
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
  resizeCanvas();
  waterfall.clear();
  waterfall.dfLine = mode === 'scout' ? scoutDf : snipeDf;
  updateSnipeOverlay();
}

// ── Snipe Watch/Call phase ──────────────────────────────────────────────────
const btnWatch = document.getElementById('btn-watch');
const btnCall = document.getElementById('btn-call');
const snipePhaseHint = document.getElementById('snipe-phase-hint');
const snipeCallersEl = document.getElementById('snipe-callers');

btnWatch.addEventListener('click', () => setSnipePhase('watch'));
btnCall.addEventListener('click', () => setSnipePhase('call'));

function setSnipePhase(phase) {
  snipePhase = phase;
  btnWatch.classList.toggle('active', phase === 'watch');
  btnCall.classList.toggle('active', phase === 'call');
  const snipeView = document.getElementById('snipe-view');
  snipeView.classList.toggle('snipe-call-phase', phase === 'call');
  if (phase === 'watch') {
    snipePhaseHint.textContent = `full-band  DF ${snipeDf} Hz`;
    cat.setFilter(false); // restore wide filter
  } else {
    snipePhaseHint.textContent = `BPF ${snipeBpf} Hz  DF ${snipeDf} Hz`;
    cat.setFilter(true); // engage narrow filter
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

wfWrap.addEventListener('click', (e) => {
  const rect = wfCanvas.getBoundingClientRect();
  const freq = Math.round(FREQ_MIN + ((e.clientX - rect.left) / rect.width) * (FREQ_MAX - FREQ_MIN));
  if (currentMode === 'snipe') {
    if (snipePhase === 'watch') {
      // Watch: set TX frequency (DF) — full-band receive
      snipeDf = Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq));
      waterfall.dfLine = snipeDf;
      setStatus(`DF: ${snipeDf} Hz`);
    } else {
      // Call: set BPF window center — narrow receive
      snipeBpf = Math.max(FREQ_MIN + 250, Math.min(FREQ_MAX - 250, freq));
      setStatus(`BPF: ${snipeBpf} Hz`);
    }
    updateSnipeOverlay();
  } else {
    scoutDf = Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq));
    waterfall.dfLine = scoutDf;
    setStatus(`DF: ${scoutDf} Hz`);
  }
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
    // IDLE — show CQ button
    const btn = document.createElement('button');
    btn.className = 'cq';
    btn.textContent = 'CQ';
    btn.addEventListener('click', () => {
      qso.setMyInfo(myCallInput.value, myGridInput.value);
      const tx = qso.callCq();
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
  const cqBtn = document.createElement('button');
  cqBtn.className = 'cq';
  cqBtn.textContent = 'CQ';
  cqBtn.addEventListener('click', () => {
    qso.setMyInfo(myCallInput.value, myGridInput.value);
    const cqTx = qso.callCq();
    queueTxMsg(cqTx.call1, cqTx.call2, cqTx.report);
  });
  txActionsEl.appendChild(cqBtn);
}

autoCheck.addEventListener('change', updateTxActions);

// ── Decode ──────────────────────────────────────────────────────────────────
// Scout adaptive budget: shed subtract first, then AP.
// Snipe always runs both (narrow band = fast).
const BUDGET_MS = 2400;

function runDecode(samples) {
  const t0 = performance.now();

  // Subtract: use if enabled and not auto-disabled
  const useSub = subtractCheck.checked && !subDisabledAuto;
  const results = useSub ? decode_wav_subtract(samples) : decode_wav(samples);
  const baseMs = performance.now() - t0;

  // AP supplement: enabled by checkbox, auto-disabled by budget
  const useAp = apCheck.checked && !apDisabledAuto;
  const apTarget = useAp
    ? (apCall || (currentMode === 'scout' && qso.dxCall ? qso.dxCall : ''))
    : '';

  if (apTarget) {
    const found = results.some(r => r.message.toUpperCase().includes(apTarget));
    if (!found) {
      const freq = currentMode === 'snipe' ? snipeDf : scoutDf;
      const myCall = myCallInput.value.trim().toUpperCase();
      const ap = decode_sniper(samples, freq, apTarget, myCall);
      for (const r of ap) {
        if (!results.some(x => Math.abs(x.freq_hz - r.freq_hz) < 10)) {
          results.push(r);
        } else {
          r.free();
        }
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

    const utc = new Date().toISOString().substr(11, 5);
    addChatMsg('tx sending', utc, txText, undefined);

    const samples = encode_ft8(call1, call2, report, freq);
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

    // Convert to i16
    const samples = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      samples[i] = Math.round(Math.max(-32768, Math.min(32767, float32[i] * 32767)));
    }

    const results = runDecode(samples);
    const n = results.length;
    const utc = new Date(periodIndex * 15000).toISOString().substr(11, 5);
    // Period separator with UTC (skip if no decodes)
    if (n > 0) {
      const sep = document.createElement('div');
      sep.className = 'period-sep';
      sep.textContent = utc;
      chatList.appendChild(sep);
      snipeRxList.appendChild(sep.cloneNode(true));
    }
    lastPeriodIndex = periodIndex;

    const shed = [subDisabledAuto && 'sub', apDisabledAuto && 'AP'].filter(Boolean);
    const shedTag = shed.length ? ` [-${shed.join(',')}]` : '';
    setStatus(`${n}d ${lastDecodeMs}ms${shedTag}`);

    // AP target: use QSO dxCall if available, or last Snipe target
    if (qso.dxCall) apCall = qso.dxCall;

    const msgs = [];
    let txMsg = null;
    const callers = []; // track stations calling me (for pileup notification)

    for (let i = 0; i < n; i++) {
      const r = results[i];
      const msg = r.message;
      const freq = r.freq_hz;
      const snr = r.snr_db;
      const dt = r.dt_sec;
      const suspect = r.pass >= 4 && r.hard_errors >= 35;
      msgs.push({ freq_hz: freq, dt_sec: dt, snr_db: snr, message: msg });

      // Log all non-suspect RX to persistent store
      if (!suspect) {
        qsoLog.addRx({ message: msg, freq_hz: freq, snr_db: snr });
      }

      // Scout chat
      if (!suspect) {
        const words = msg.split(/\s+/);
        // Extract sender (call2): skip CQ/DE/QRZ/DX prefixes, then
        // in "CQ SENDER GRID" sender is 1st call, in "DEST SENDER RPT" sender is 2nd call
        const calls = [];
        for (const w of words) {
          if (['CQ', 'DE', 'QRZ', 'DX'].includes(w)) continue;
          if (w.length >= 3 && /[0-9]/.test(w)) calls.push(w);
          if (calls.length >= 2) break;
        }
        // CQ message: only 1 call before grid → sender is calls[0]
        // Directed message: DEST SENDER → sender is calls[1]
        const isCq = /^(CQ|DE|QRZ)\b/.test(msg);
        const clickCall = isCq ? (calls[0] || '') : (calls[1] || calls[0] || '');
        addChatMsg('rx', utc, msg, snr, clickCall ? () => {
          qso.setMyInfo(myCallInput.value, myGridInput.value);
          const tx = qso.callStation(clickCall);
          apCall = clickCall;
          clearTargetCards();
          if (tx) queueTxMsg(tx.call1, tx.call2, tx.report);
        } : null, freq, dt);
      }

      // Snipe view: update target info
      if (currentMode === 'snipe' && apCall && msg.toUpperCase().includes(apCall)) {
        snipeDxMsg.textContent = msg;
        snipeDxInfo.textContent = `${freq.toFixed(0)} Hz  ${snr >= 0 ? '+' : ''}${Math.round(snr)} dB`;
      }

      // Track callers (my call is first word = someone calling me)
      if (!suspect) {
        const myCall = myCallInput.value.toUpperCase();
        const w = msg.split(/\s+/);
        if (w[0] === myCall && w.length >= 2 && w[1] !== myCall) {
          callers.push({ call: w[1], snr, msg, freq });
        }
      }

      // QSO state machine (skip CQ responses — handled below after SNR sort)
      const isCqWait = qso.state === QSO_STATE.CALLING && !qso.dxCall;
      if (!suspect && !isCqWait) {
        qso.setRxSnr(snr);
        const result = qso.processMessage(msg);
        if (result && !txMsg) txMsg = result;
      }

      // Update target card when DX is heard
      if (!suspect && qso.dxCall && msg.toUpperCase().includes(qso.dxCall)) {
        scoutTargetMsg.textContent = msg;
        scoutTargetInfo.textContent = `${freq.toFixed(0)} Hz  ${snr >= 0 ? '+' : ''}${Math.round(snr)} dB`;
      }

      r.free();
    }

    // CQ response handling: sort by SNR, feed strongest to SM
    if (qso.state === QSO_STATE.CALLING && !qso.dxCall && callers.length > 0) {
      const useSNR = !document.getElementById('cq-first-decoded')?.checked;
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

    // Snipe: update RX list based on phase
    if (currentMode === 'snipe') {
      const myCall = myCallInput.value.toUpperCase();

      if (snipePhase === 'watch') {
        // Watch: show callers of target + all band activity
        const callers = [];
        for (const m of msgs) {
          const upper = m.message.toUpperCase();
          // Track who is calling the target
          if (apCall && upper.includes(apCall)) {
            const words = m.message.split(/\s+/);
            // "TARGET CALLER GRID/RPT" — caller is words[1]
            if (words[0]?.toUpperCase() === apCall && words[1] && words[1].toUpperCase() !== myCall) {
              callers.push(words[1]);
            }
          }

          const div = document.createElement('div');
          div.className = 'chat-msg rx';
          const isTarget = apCall && upper.includes(apCall);
          if (isTarget) div.classList.add('qso-active');
          const snrV = Math.round(m.snr_db);
          div.innerHTML = `<span class="col-freq">${Math.round(m.freq_hz)}</span>
            <span class="col-dt">${m.dt_sec >= 0 ? '+' : ''}${m.dt_sec.toFixed(1)}</span>
            <span class="col-snr">${snrV >= 0 ? '+' : ''}${snrV}</span>
            <span class="text">${m.message}</span>`;
          div.style.cursor = 'pointer';
          div.addEventListener('click', () => {
            const words = m.message.split(/\s+/);
            // Extract call1 (target) and call2 (sender/alt)
            const calls = [];
            for (const w of words) {
              if (['CQ','DE','QRZ','DX'].includes(w)) continue;
              if (w.length >= 3 && /[0-9]/.test(w)) calls.push(w);
              if (calls.length >= 2) break;
            }
            const isCq = /^(CQ|DE|QRZ)\b/.test(m.message);
            const target = isCq ? (calls[0] || '') : (calls[0] || '');
            const sender = isCq ? (calls[0] || '') : (calls[1] || '');
            if (target) {
              qso.setMyInfo(myCallInput.value, myGridInput.value);
              const tx = qso.callStation(target);
              apCall = target;
              snipeDxCall.textContent = target;
              clearTargetCards();
              snipeAltCall = (sender && sender !== target) ? sender : '';
              if (tx) queueTxMsg(tx.call1, tx.call2, tx.report);
            }
          });
          snipeRxList.appendChild(div);
        }
        pruneList(snipeRxList);\n        snipeRxList.scrollTop = snipeRxList.scrollHeight;

        // Show callers list
        if (apCall && callers.length > 0) {
          snipeCallersEl.textContent = `Calling ${apCall}: ${callers.join(', ')}`;
        }

      } else {
        // Call phase: only show messages involving me and target
        for (const m of msgs) {
          const upper = m.message.toUpperCase();
          if (!apCall) continue;
          const involvesMe = upper.includes(myCall);
          const involvesTarget = upper.includes(apCall);
          if (!involvesMe && !involvesTarget) continue;

          const div = document.createElement('div');
          div.className = 'chat-msg rx';
          if (involvesTarget) div.classList.add('qso-active');
          const snrV = Math.round(m.snr_db);
          div.innerHTML = `<span class="col-freq">${Math.round(m.freq_hz)}</span>
            <span class="col-dt">${m.dt_sec >= 0 ? '+' : ''}${m.dt_sec.toFixed(1)}</span>
            <span class="col-snr">${snrV >= 0 ? '+' : ''}${snrV}</span>
            <span class="text">${m.message}</span>`;
          snipeRxList.appendChild(div);
        }
        snipeRxList.scrollTop = snipeRxList.scrollHeight;

        // Auto-switch back to Watch on QSO failure (reset)
        // (handled by retry timeout above — user can manually switch too)
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

btnHalt.addEventListener('click', () => {
  if (!halted) {
    // First tap: cancel TX, stop audio output, but keep QSO state
    periodMgr.cancelTx();
    audioOut.stop();
    cat.safePttOff();
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
      localStorage.setItem('rs-ft8n-audio-in', deviceId);
      periodMgr.start();
      liveMode = true;
      updateLiveUI();
      setStatus('');
      waterfall.clear();
      const es = document.getElementById('empty-state');
      if (es) es.remove();
      closeSettings();
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

// ── CAT ─────────────────────────────────────────────────────────────────────
btnCat.addEventListener('click', async () => {
  if (cat.connected) {
    await cat.disconnect();
    btnCat.textContent = 'Connect CAT';
    catStatusEl.textContent = 'disconnected';
    return;
  }
  if (!CatController.isSupported()) {
    catStatusEl.textContent = 'Web Serial not supported';
    return;
  }
  try {
    const rigId = document.getElementById('rig-model').value;
    if (!rigId) { catStatusEl.textContent = 'Select a rig model'; return; }
    await cat.requestPort();
    await cat.connect(rigId);
    btnCat.textContent = 'Disconnect';
    const profiles = getRigProfiles();
    catStatusEl.textContent = `connected (${profiles[rigId]?.label || rigId})`;
    localStorage.setItem('rs-ft8n-rig', rigId);
  } catch (e) {
    catStatusEl.textContent = `error: ${e.message || e}`;
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
  if (sr !== 12000) throw new Error(`${sr} Hz (need 12000)`);
  if (bps !== 16) throw new Error(`${bps}-bit (need 16)`);
  if (ch !== 1) throw new Error(`${ch} ch (need mono)`);
  let off = 12;
  while (off < buf.byteLength - 8) {
    const id = String.fromCharCode(view.getUint8(off), view.getUint8(off+1), view.getUint8(off+2), view.getUint8(off+3));
    const sz = view.getUint32(off + 4, true);
    if (id === 'data') return new Int16Array(buf, off + 8, sz / 2);
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
    const samples = parseWav(buf);
    waterfall.clear();
    waterfall.pushSamples(samples);
    waterfall.drawFreqAxis();

    setStatus('Decoding...');
    await new Promise(r => setTimeout(r, 0));

    const t0 = performance.now();
    const results = runDecode(samples);
    const elapsed = performance.now() - t0;

    setStatus(`${results.length}d ${elapsed.toFixed(0)}ms`);
    chatList.innerHTML = '';

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.pass >= 4 && r.hard_errors >= 35) { r.free(); continue; }
      addChatMsg('rx', `${i+1}`, r.message, r.snr_db, null, r.freq_hz, r.dt_sec);
      r.free();
    }
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
  }
}

// ── WASM init ───────────────────────────────────────────────────────────────
setStatus('Loading...');
init().then(async () => {
  wasmReady = true;
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
  const savedRig = localStorage.getItem('rs-ft8n-rig');
  if (savedRig) rigSelect.value = savedRig;

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
    const savedIn = localStorage.getItem('rs-ft8n-audio-in');
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
    const savedOut = localStorage.getItem('rs-ft8n-audio-out');
    if (savedOut) outputDeviceSelect.value = savedOut;

    // Ready — tap logo to start
    if (myCallInput.value && deviceSelect.value) {
      setStatus('Tap logo to start');
    }
  } catch (e) { console.warn('Audio devices:', e); }
  updateTxActions();
}).catch(e => { setStatus(`Load failed: ${e}`); });

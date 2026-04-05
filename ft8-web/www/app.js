import init, { decode_wav, decode_wav_subtract, decode_sniper, encode_ft8 } from '../pkg/ft8_web.js';
import { Waterfall } from './waterfall.js';
import { AudioCapture } from './audio-capture.js';
import { AudioOutput } from './audio-output.js';
import { FT8PeriodManager } from './ft8-period.js';
import { QsoManager, QSO_STATE } from './qso.js';
import { CatController } from './cat.js';
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
const statusEl = document.getElementById('status');
const fileInput = document.getElementById('file-input');
const myCallInput = document.getElementById('my-call');
const myGridInput = document.getElementById('my-grid');
const deviceSelect = document.getElementById('audio-device');
const outputDeviceSelect = document.getElementById('audio-output-device');
const snipeCallInput = document.getElementById('snipe-call');
const subtractCheck = document.getElementById('subtract-mode');
const btnCat = document.getElementById('btn-cat');
const catStatusEl = document.getElementById('cat-status');
const btnStart = document.getElementById('btn-start');
const btnReset = document.getElementById('btn-qso-reset');

// ── State ───────────────────────────────────────────────────────────────────
let wasmReady = false;
let liveMode = false;
let currentMode = 'scout'; // 'scout' | 'snipe'
let snipeFreq = 1000;
let scoutDf = 1500; // Scout mode TX frequency (Hz)
let apCall = '';
let snipePhase = 'watch'; // 'watch' | 'call'
let snipeAltCall = ''; // call2 (sender) from last tapped Snipe message
const FREQ_MIN = 200, FREQ_MAX = 2800;

// ── Waterfall ───────────────────────────────────────────────────────────────
function resizeCanvas() {
  wfCanvas.width = wfCanvas.clientWidth;
  wfCanvas.height = wfCanvas.clientHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);
const waterfall = new Waterfall(wfCanvas);

// ── Core modules ────────────────────────────────────────────────────────────
const audioOut = new AudioOutput();
const cat = new CatController();
const qsoLog = new QsoLog();

// Restore settings
myCallInput.value = localStorage.getItem('rs-ft8n-mycall') || '';
myGridInput.value = localStorage.getItem('rs-ft8n-mygrid') || '';
snipeCallInput.value = localStorage.getItem('rs-ft8n-dxcall') || '';
myCallInput.addEventListener('change', () => localStorage.setItem('rs-ft8n-mycall', myCallInput.value));
myGridInput.addEventListener('change', () => localStorage.setItem('rs-ft8n-mygrid', myGridInput.value));
snipeCallInput.addEventListener('change', () => localStorage.setItem('rs-ft8n-dxcall', snipeCallInput.value));

const qso = new QsoManager({
  myCall: myCallInput.value,
  myGrid: myGridInput.value,
  onStateChange: (state) => {
    updateQsoDisplay();
    if (state === QSO_STATE.IDLE && qso.dxCall) {
      qsoLog.add({
        dxCall: qso.dxCall, dxGrid: qso.dxGrid,
        txReport: qso.txReport, rxReport: qso.rxReport,
        freq: currentMode === 'snipe' ? snipeFreq : scoutDf,
        state: 'IDLE', // completed
      });
      addChatMsg('sys', '', `QSO complete: ${qso.dxCall}`, 0);
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
  waterfall.dfLine = mode === 'scout' ? scoutDf : null;
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
    snipePhaseHint.textContent = 'full-band — tap WF to set DF';
  } else {
    snipePhaseHint.textContent = `narrow ${snipeFreq} Hz — calling`;
    // Auto-start calling if we have a target
    if (apCall && qso.state === QSO_STATE.IDLE) {
      qso.setMyInfo(myCallInput.value, myGridInput.value);
      qso.callStation(apCall);
      statusEl.textContent = `Calling ${apCall}`;
    }
  }
  // Clear RX list when switching phases
  document.getElementById('snipe-rx-list').innerHTML = '';
}

// ── Settings panel ──────────────────────────────────────────────────────────
function openSettings() {
  settingsPanel.classList.add('open');
  settingsOverlay.classList.add('open');
}
function closeSettings() {
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
  if (currentMode !== 'snipe') {
    snipeOverlay.style.display = 'none';
    snipeFreqLabel.style.display = 'none';
    return;
  }
  const w = wfCanvas.clientWidth;
  const range = FREQ_MAX - FREQ_MIN;
  const left = ((snipeFreq - 250 - FREQ_MIN) / range) * w;
  const right = ((snipeFreq + 250 - FREQ_MIN) / range) * w;
  snipeOverlay.style.display = 'block';
  snipeOverlay.style.left = Math.max(0, left) + 'px';
  snipeOverlay.style.width = (right - left) + 'px';
  snipeFreqLabel.style.display = 'block';
  snipeFreqLabel.style.left = (left + 4) + 'px';
  snipeFreqLabel.textContent = `${snipeFreq} Hz`;
}

wfWrap.addEventListener('click', (e) => {
  const rect = wfCanvas.getBoundingClientRect();
  const freq = Math.round(FREQ_MIN + ((e.clientX - rect.left) / rect.width) * (FREQ_MAX - FREQ_MIN));
  if (currentMode === 'snipe') {
    snipeFreq = Math.max(FREQ_MIN + 250, Math.min(FREQ_MAX - 250, freq));
    updateSnipeOverlay();
  } else {
    scoutDf = Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq));
    waterfall.dfLine = scoutDf;
    statusEl.textContent = `DF: ${scoutDf} Hz`;
  }
});

// ── Chat message helper (Scout mode) ────────────────────────────────────────
function addChatMsg(type, time, text, snr, actionCb) {
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;

  const myCall = myCallInput.value.toUpperCase();
  const dxCall = qso.dxCall;

  // Highlight callsigns
  let html = text.replace(/\b([A-Z0-9/]{3,})\b/g, (m) => {
    if (m === dxCall) return `<span class="target">${m}</span>`;
    if (m === myCall) return `<span class="call">${m}</span>`;
    return m;
  });

  div.innerHTML = `
    <span class="time">${time}</span>
    <span class="snr">${snr !== undefined && type === 'rx' ? (snr >= 0 ? '+' : '') + Math.round(snr) : ''}</span>
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

  // Unified TX actions
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
      addChatMsg('tx', '', qso.formatTx(tx), undefined);
      statusEl.textContent = 'Calling CQ';
    });
    txActionsEl.appendChild(btn);

    // Snipe: show alt call (sender) as secondary option
    if (currentMode === 'snipe' && snipeAltCall && snipeAltCall !== myCall) {
      const altBtn = document.createElement('button');
      altBtn.className = 'tx-msg';
      altBtn.textContent = `Call ${snipeAltCall}`;
      altBtn.addEventListener('click', () => {
        qso.setMyInfo(myCallInput.value, myGridInput.value);
        qso.callStation(snipeAltCall);
        snipeCallInput.value = snipeAltCall;
        apCall = snipeAltCall;
        snipeDxCall.textContent = snipeAltCall;
        snipeAltCall = '';
        updateTxActions();
        statusEl.textContent = `Calling ${apCall}`;
      });
      txActionsEl.appendChild(altBtn);
    }
    return;
  }

  if (autoCheck.checked) {
    // Auto ON — show single next-TX button
    const tx = qso.getNextTx();
    if (tx) {
      const btn = document.createElement('button');
      btn.className = 'tx-next';
      btn.textContent = qso.formatTx(tx);
      btn.addEventListener('click', () => transmit(tx.call1, tx.call2, tx.report));
      txActionsEl.appendChild(btn);
    }
    return;
  }

  // Auto OFF — show all TX options
  const options = [];
  if (state === QSO_STATE.CALLING) {
    options.push({ label: `${dx} ${myCall} ${myGrid}`, c1: dx, c2: myCall, rpt: myGrid });
  }
  if (state === QSO_STATE.REPORT) {
    const rpt = qso._autoReport();
    options.push({ label: `${dx} ${myCall} ${rpt}`, c1: dx, c2: myCall, rpt });
    options.push({ label: `${dx} ${myCall} R${rpt}`, c1: dx, c2: myCall, rpt: `R${rpt}` });
  }
  if (state === QSO_STATE.FINAL) {
    options.push({ label: `${dx} ${myCall} RR73`, c1: dx, c2: myCall, rpt: 'RR73' });
    options.push({ label: `${dx} ${myCall} 73`, c1: dx, c2: myCall, rpt: '73' });
  }
  options.push({ label: `${dx} ${myCall} ${myGrid}`, c1: dx, c2: myCall, rpt: myGrid });
  options.push({ label: `CQ ${myCall} ${myGrid}`, c1: 'CQ', c2: myCall, rpt: myGrid });

  const seen = new Set();
  for (const o of options) {
    if (seen.has(o.label)) continue;
    seen.add(o.label);
    const btn = document.createElement('button');
    btn.className = 'tx-msg';
    btn.textContent = o.label;
    btn.addEventListener('click', () => transmit(o.c1, o.c2, o.rpt));
    txActionsEl.appendChild(btn);
  }
}

autoCheck.addEventListener('change', updateTxActions);

// ── Decode ──────────────────────────────────────────────────────────────────
function runDecode(samples) {
  const results = subtractCheck.checked ? decode_wav_subtract(samples) : decode_wav(samples);

  // AP supplement if target not found
  if (apCall) {
    const found = results.some(r => r.message.toUpperCase().includes(apCall));
    if (!found) {
      const freq = currentMode === 'snipe' ? snipeFreq : scoutDf;
      const ap = decode_sniper(samples, freq, apCall);
      for (const r of ap) {
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

// ── Transmit ────────────────────────────────────────────────────────────────
async function transmit(call1, call2, report, freq) {
  if (!wasmReady) return;
  freq = freq || (currentMode === 'snipe' ? snipeFreq : scoutDf);
  try {
    statusEl.textContent = `TX: ${call1} ${call2} ${report}`;
    // Mark active button
    const activeBtn = txActionsEl.querySelector('button');
    if (activeBtn) activeBtn.classList.add('tx-active');

    const utc = new Date().toISOString().substr(11, 5);
    addChatMsg('tx sending', utc, `${call1} ${call2} ${report}`, undefined);

    const samples = encode_ft8(call1, call2, report, freq);
    if (cat.connected) await cat.ptt(true);
    await audioOut.play(samples, outputDeviceSelect.value || undefined);
    if (cat.connected) await cat.ptt(false);

    if (activeBtn) activeBtn.classList.remove('tx-active');
    statusEl.textContent = 'TX complete';
  } catch (e) {
    txActionsEl.querySelectorAll('.tx-active').forEach(b => b.classList.remove('tx-active'));
    statusEl.textContent = `TX error: ${e.message || e}`;
    if (cat.connected) try { await cat.ptt(false); } catch (_) {}
  }
}

// ── Period manager ──────────────────────────────────────────────────────────
const periodMgr = new FT8PeriodManager({
  onTick: (rem) => timerEl.textContent = rem.toFixed(1) + 's',
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

    const t0 = performance.now();
    const results = runDecode(samples);
    const elapsed = performance.now() - t0;
    const n = results.length;
    const utc = new Date(periodIndex * 15000).toISOString().substr(11, 5);

    statusEl.textContent = `${n} decoded (${elapsed.toFixed(0)} ms)`;

    // Update AP from snipe call input
    apCall = snipeCallInput.value.trim().toUpperCase();

    const msgs = [];
    let txMsg = null;

    for (let i = 0; i < n; i++) {
      const r = results[i];
      const msg = r.message;
      const freq = r.freq_hz;
      const snr = r.snr_db;
      const suspect = r.pass >= 4 && r.hard_errors >= 35;
      msgs.push({ freq_hz: freq, message: msg });

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
          snipeCallInput.value = clickCall;
          apCall = clickCall;
          statusEl.textContent = `Calling ${clickCall}`;
        } : null);
      }

      // Snipe view: update target info
      if (currentMode === 'snipe' && apCall && msg.toUpperCase().includes(apCall)) {
        snipeDxMsg.textContent = msg;
        snipeDxInfo.textContent = `${freq.toFixed(0)} Hz  ${snr >= 0 ? '+' : ''}${Math.round(snr)} dB`;
      }

      // QSO state machine
      if (!suspect) {
        qso.setRxSnr(snr);
        const result = qso.processMessage(msg);
        if (result && !txMsg) txMsg = result;
      }

      r.free();
    }

    // Auto TX / retry
    const period = periodMgr.getCurrentPeriod();
    if (txMsg && autoCheck.checked) {
      const freq = currentMode === 'snipe' ? snipeFreq : scoutDf;
      periodMgr.queueTx({ ...txMsg, freq }, !period.isEven);
      statusEl.textContent = `TX queued: ${qso.formatTx(txMsg)}`;
    } else if (!txMsg && qso.state !== QSO_STATE.IDLE && autoCheck.checked) {
      // Save state before retry (retry may reset on max retries)
      const prevState = qso.state;
      const prevDx = qso.dxCall;
      const retryTx = qso.retry();
      if (retryTx) {
        const freq = currentMode === 'snipe' ? snipeFreq : scoutDf;
        periodMgr.queueTx({ ...retryTx, freq }, !period.isEven);
        statusEl.textContent = `Retry ${qso.retryInfo()}: ${qso.formatTx(retryTx)}`;
      } else if (prevDx) {
        // Max retries exceeded — log incomplete QSO
        qsoLog.add({
          dxCall: prevDx, dxGrid: qso.dxGrid,
          txReport: qso.txReport, rxReport: qso.rxReport,
          freq: currentMode === 'snipe' ? snipeFreq : scoutDf,
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
          div.innerHTML = `<span class="snr" style="min-width:2em">${Math.round(m.freq_hz)}</span>
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
              qso.callStation(target);
              snipeCallInput.value = target;
              apCall = target;
              snipeDxCall.textContent = target;
              // Store alt call (sender) if different from target
              snipeAltCall = (sender && sender !== target) ? sender : '';
              updateTxActions();
            }
          });
          snipeRxList.appendChild(div);
        }
        snipeRxList.scrollTop = snipeRxList.scrollHeight;

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
          div.innerHTML = `<span class="snr" style="min-width:2em">${Math.round(m.freq_hz)}</span>
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

    // Fill DX call hint
    if (qso.dxCall && snipeCallInput.value !== qso.dxCall) {
      snipeCallInput.value = qso.dxCall;
    }
  },
});

// TX fire from period manager
periodMgr.callbacks.onTxFire = async (tx) => {
  await transmit(tx.call1, tx.call2, tx.report, tx.freq);
};

// ── Buttons ─────────────────────────────────────────────────────────────────
btnHalt.addEventListener('click', () => {
  periodMgr.cancelTx();
  audioOut.stop();
  if (cat.connected) cat.ptt(false).catch(() => {});
  txActionsEl.querySelectorAll('.tx-active').forEach(b => b.classList.remove('tx-active'));
  statusEl.textContent = 'Halted';
});

btnReset.addEventListener('click', () => {
  periodMgr.cancelTx();
  audioOut.stop();
  if (cat.connected) cat.ptt(false).catch(() => {});
  txActionsEl.querySelectorAll('.tx-active').forEach(b => b.classList.remove('tx-active'));
  // Save incomplete QSO before reset
  if (qso.state !== QSO_STATE.IDLE && qso.dxCall) {
    qsoLog.add({
      dxCall: qso.dxCall, dxGrid: qso.dxGrid,
      txReport: qso.txReport, rxReport: qso.rxReport,
      freq: currentMode === 'snipe' ? snipeFreq : scoutDf,
      state: qso.state, // incomplete
    });
  }
  qso.reset();
  chatList.innerHTML = '';
  updateQsoDisplay();
  statusEl.textContent = 'Reset';
});

// ── Audio start/stop ────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  if (!liveMode) {
    const deviceId = deviceSelect.value;
    if (!deviceId) { statusEl.textContent = 'Select audio device'; return; }
    try {
      await capture.start(deviceId);
      periodMgr.start();
      liveMode = true;
      btnStart.textContent = 'Stop Audio';
      statusEl.textContent = `Listening (${capture.getSampleRate()} Hz)`;
      waterfall.clear();
      settingsPanel.classList.remove('open');
      settingsOverlay.classList.remove('open');
    } catch (e) {
      statusEl.textContent = `Audio error: ${e.message || e}`;
    }
  } else {
    periodMgr.stop();
    capture.stop();
    liveMode = false;
    btnStart.textContent = 'Start Audio';
    timerEl.textContent = '--';
    statusEl.textContent = 'Stopped';
  }
});

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
    const proto = document.getElementById('cat-protocol').value;
    await cat.requestPort();
    await cat.connect({ protocol: proto });
    btnCat.textContent = 'Disconnect';
    catStatusEl.textContent = `connected (${proto})`;
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
  if (!entries.length) { el.textContent = 'No QSOs'; return; }
  el.innerHTML = entries.slice(0, 50).map(e => {
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

    statusEl.textContent = 'Decoding...';
    await new Promise(r => setTimeout(r, 0));

    const t0 = performance.now();
    const results = runDecode(samples);
    const elapsed = performance.now() - t0;

    statusEl.textContent = `${results.length} decoded (${elapsed.toFixed(0)} ms) — ${file.name}`;
    chatList.innerHTML = '';

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.pass >= 4 && r.hard_errors >= 35) { r.free(); continue; }
      addChatMsg('rx', `${i+1}`, r.message, r.snr_db);
      r.free();
    }
  } catch (e) {
    statusEl.textContent = `Error: ${e.message || e}`;
  }
}

// ── WASM init ───────────────────────────────────────────────────────────────
statusEl.textContent = 'Loading...';
init().then(async () => {
  wasmReady = true;
  statusEl.textContent = 'Ready';
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
    outputDeviceSelect.innerHTML = '<option value="">-- default --</option>';
    for (const d of allDevices) {
      if (d.kind !== 'audiooutput') continue;
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Output ${d.deviceId.slice(0, 8)}`;
      outputDeviceSelect.appendChild(opt);
    }
  } catch (e) { console.warn('Audio devices:', e); }
  updateTxActions();
}).catch(e => { statusEl.textContent = `Load failed: ${e}`; });

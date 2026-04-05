import init, { decode_wav, decode_wav_subtract } from '../pkg/ft8_web.js';
import { Waterfall } from './waterfall.js';
import { AudioCapture } from './audio-capture.js';
import { FT8PeriodManager } from './ft8-period.js';

// ── Elements ────────────────────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const timingEl = document.getElementById('timing');
const resultsTable = document.getElementById('results');
const tbody = resultsTable.querySelector('tbody');
const subtractCheck = document.getElementById('subtract-mode');
const wfCanvas = document.getElementById('waterfall');
const deviceSelect = document.getElementById('audio-device');
const btnStart = document.getElementById('btn-start');
const timerEl = document.getElementById('period-timer');

// ── Waterfall setup ─────────────────────────────────────────────────────────
function resizeCanvas() {
  wfCanvas.width = wfCanvas.clientWidth;
  wfCanvas.height = wfCanvas.clientHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const waterfall = new Waterfall(wfCanvas);

// ── WASM init ───────────────────────────────────────────────────────────────
let wasmReady = false;
statusEl.textContent = 'Loading WASM module...';
init().then(async () => {
  wasmReady = true;
  statusEl.textContent = 'Ready. Drop a WAV file or select an audio device.';
  // Enumerate audio devices (non-fatal if it fails)
  try { await populateDevices(); } catch (e) { console.warn('Audio devices:', e); }
}).catch(e => {
  statusEl.textContent = `WASM load failed: ${e}`;
});

// ── Audio capture ───────────────────────────────────────────────────────────
const capture = new AudioCapture({
  onWaterfall: (samples) => {
    waterfall.pushSamples(samples);
  },
  onBufferFull: () => {
    // Buffer full — period manager will handle snapshot
  },
});

async function populateDevices() {
  try {
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
  } catch (e) {
    deviceSelect.innerHTML = '<option>No audio devices</option>';
  }
}

// ── Period manager ──────────────────────────────────────────────────────────
const periodMgr = new FT8PeriodManager({
  onTick: (remaining) => {
    timerEl.textContent = remaining.toFixed(1) + 's';
  },
  onPeriodEnd: async (periodIndex, isEven) => {
    if (!capture.running || !wasmReady) return;

    // Draw period boundary line on waterfall
    waterfall.drawPeriodLine();

    statusEl.textContent = 'Decoding...';
    const float32 = await capture.snapshot();

    if (float32.length < 12000) {
      statusEl.textContent = `Period ${periodIndex}: too few samples (${float32.length})`;
      return;
    }

    // Convert Float32 → Int16
    const samples = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      samples[i] = Math.round(Math.max(-32768, Math.min(32767, float32[i] * 32767)));
    }

    // Decode
    const useSubtract = subtractCheck.checked;
    const t0 = performance.now();
    const results = useSubtract ? decode_wav_subtract(samples) : decode_wav(samples);
    const elapsed = performance.now() - t0;

    const n = results.length;
    const utc = new Date(periodIndex * 15000).toISOString().substr(11, 5);
    const mode = useSubtract ? 'subtract' : 'single';
    statusEl.textContent = `Period ${utc} UTC: ${float32.length} samples`;
    timingEl.textContent = `Decoded ${n} message(s) in ${elapsed.toFixed(1)} ms (${mode})`;

    // Add results to table (newest first)
    const msgs = [];
    if (n > 0) {
      resultsTable.hidden = false;
      for (let i = 0; i < n; i++) {
        const r = results[i];
        msgs.push({ freq_hz: r.freq_hz, message: r.message });

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="num">${utc}</td>
          <td class="num">${r.freq_hz.toFixed(1)}</td>
          <td class="num">${r.dt_sec >= 0 ? '+' : ''}${r.dt_sec.toFixed(2)}</td>
          <td class="num">${r.snr_db >= 0 ? '+' : ''}${r.snr_db.toFixed(0)}</td>
          <td class="num">${r.hard_errors}</td>
          <td>${r.pass}</td>
          <td class="msg">${r.message}</td>
        `;
        tbody.insertBefore(tr, tbody.firstChild);
        r.free();
      }
    }
    waterfall.drawLabels(msgs);
    waterfall.drawFreqAxis();
  },
});

// ── Start / Stop button ─────────────────────────────────────────────────────
let liveMode = false;

btnStart.addEventListener('click', async () => {
  if (!liveMode) {
    // Start
    const deviceId = deviceSelect.value;
    if (!deviceId) {
      statusEl.textContent = 'Select an audio device first.';
      return;
    }
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
    // Stop
    periodMgr.stop();
    capture.stop();
    liveMode = false;
    btnStart.textContent = 'Start';
    btnStart.classList.remove('active');
    timerEl.textContent = '--';
    statusEl.textContent = 'Stopped.';
  }
});

// ── File handling (WAV drop, kept as fallback) ──────────────────────────────
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
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset+1),
      view.getUint8(offset+2), view.getUint8(offset+3)
    );
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

    const useSubtract = subtractCheck.checked;
    const t0 = performance.now();
    const results = useSubtract ? decode_wav_subtract(samples) : decode_wav(samples);
    const elapsed = performance.now() - t0;

    const n = results.length;
    const mode = useSubtract ? 'subtract' : 'single-pass';
    statusEl.textContent = `${file.name}: ${nSamples} samples (${duration} s)`;
    timingEl.textContent = `Decoded ${n} message(s) in ${elapsed.toFixed(1)} ms (${mode})`;

    const msgs = [];
    if (n > 0) {
      resultsTable.hidden = false;
      for (let i = 0; i < n; i++) {
        const r = results[i];
        msgs.push({ freq_hz: r.freq_hz, message: r.message });
        const tr = document.createElement('tr');
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

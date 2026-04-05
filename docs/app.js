import init, { decode_wav, decode_wav_subtract } from './ft8_web.js';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const timingEl = document.getElementById('timing');
const resultsTable = document.getElementById('results');
const tbody = resultsTable.querySelector('tbody');
const subtractCheck = document.getElementById('subtract-mode');

let wasmReady = false;

// ── Init WASM ───────────────────────────────────────────────────────────────
statusEl.textContent = 'Loading WASM module...';
init().then(() => {
  wasmReady = true;
  statusEl.textContent = 'Ready. Drop a WAV file.';
}).catch(e => {
  statusEl.textContent = `WASM load failed: ${e}`;
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

// ── WAV parse ───────────────────────────────────────────────────────────────
function parseWav(buf) {
  const view = new DataView(buf);
  // Validate RIFF header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a WAV file');

  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  if (sampleRate !== 12000) throw new Error(`Sample rate ${sampleRate} Hz (expected 12000)`);
  if (bitsPerSample !== 16) throw new Error(`${bitsPerSample}-bit (expected 16)`);
  if (numChannels !== 1) throw new Error(`${numChannels} channels (expected mono)`);

  // Find "data" chunk
  let offset = 12;
  while (offset < buf.byteLength - 8) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset+1),
      view.getUint8(offset+2), view.getUint8(offset+3)
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      return new Int16Array(buf, offset + 8, size / 2);
    }
    offset += 8 + size;
    if (offset % 2 !== 0) offset++; // word-align
  }
  throw new Error('No "data" chunk found');
}

// ── Decode ──────────────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!wasmReady) { statusEl.textContent = 'WASM not ready yet'; return; }
  statusEl.textContent = `Parsing ${file.name}...`;
  timingEl.textContent = '';
  tbody.innerHTML = '';
  resultsTable.hidden = true;

  try {
    const buf = await file.arrayBuffer();
    const samples = parseWav(buf);
    const nSamples = samples.length;
    const duration = (nSamples / 12000).toFixed(1);

    statusEl.textContent = `Decoding ${nSamples} samples (${duration} s)...`;

    // Yield to UI before heavy computation
    await new Promise(r => setTimeout(r, 0));

    const useSubtract = subtractCheck.checked;
    const t0 = performance.now();
    const results = useSubtract ? decode_wav_subtract(samples) : decode_wav(samples);
    const elapsed = performance.now() - t0;

    const n = results.length;
    const mode = useSubtract ? 'subtract' : 'single-pass';
    statusEl.textContent = `${file.name}: ${nSamples} samples (${duration} s)`;
    timingEl.textContent = `Decoded ${n} message(s) in ${elapsed.toFixed(1)} ms (${mode})`;

    if (n === 0) return;
    resultsTable.hidden = false;

    for (let i = 0; i < n; i++) {
      const r = results[i];
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
      r.free(); // release WASM memory
    }
  } catch (e) {
    statusEl.textContent = `Error: ${e.message || e}`;
  }
}

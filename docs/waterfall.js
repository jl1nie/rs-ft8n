// Waterfall spectrogram display for FT8 (200-2800 Hz band)
// Uses a self-contained radix-2 FFT — no external dependencies.

// ── Radix-2 Cooley-Tukey FFT ────────────────────────────────────────────────

function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation (manual swap — destructuring allocates a temp array)
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = i + j + half;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe;        im[a] += tIm;
        const tmp = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmp;
      }
    }
  }
}

// ── Hann window ─────────────────────────────────────────────────────────────

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  }
  return w;
}

// ── Color LUT ───────────────────────────────────────────────────────────────

function buildColorLut() {
  const lut = new Uint8Array(256 * 4); // RGBA
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r, g, b;
    if (t < 0.25) {
      // black → dark blue
      r = 0; g = 0; b = Math.round(t * 4 * 180);
    } else if (t < 0.5) {
      // dark blue → cyan
      const s = (t - 0.25) * 4;
      r = 0; g = Math.round(s * 255); b = 180 + Math.round(s * 75);
    } else if (t < 0.75) {
      // cyan → yellow
      const s = (t - 0.5) * 4;
      r = Math.round(s * 255); g = 255; b = Math.round((1 - s) * 255);
    } else {
      // yellow → red
      const s = (t - 0.75) * 4;
      r = 255; g = Math.round((1 - s) * 255); b = 0;
    }
    lut[i * 4 + 0] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

// ── Waterfall class ─────────────────────────────────────────────────────────

export class Waterfall {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts
   * @param {number} opts.sampleRate - input sample rate (default 12000)
   * @param {number} opts.fftSize - FFT size (default 2048, must be power of 2)
   * @param {number} opts.freqMin - lower display frequency (default 200)
   * @param {number} opts.freqMax - upper display frequency (default 2800)
   * @param {number} opts.dynRange - dynamic range in dB (default 50)
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sampleRate = opts.sampleRate || 12000;
    this.fftSize = opts.fftSize || 2048;
    this.freqMin = opts.freqMin || 100;
    this.freqMax = opts.freqMax || 3000;
    this.dynRange = opts.dynRange || 50;

    this.window = hannWindow(this.fftSize);
    this.colorLut = buildColorLut();

    // Pre-allocated FFT scratch buffers (reused across frames). Float32 is
    // plenty for visualization — Float64 was overkill and the per-frame
    // allocation was contributing GC pressure on slow CPUs.
    this._re = new Float32Array(this.fftSize);
    this._im = new Float32Array(this.fftSize);

    // Frequency bin indices for display range
    this.binMin = Math.floor(this.freqMin / this.sampleRate * this.fftSize);
    this.binMax = Math.ceil(this.freqMax / this.sampleRate * this.fftSize);
    this.numBins = this.binMax - this.binMin;

    // Auto-detect noise floor
    this.noiseFloor = -30; // dB, will be updated adaptively

    // DF line frequency (Hz) — null = no line
    this.dfLine = null;
    // Target line frequency (Hz) — green, for Snipe mode BPF center
    this.targetLine = null;
    // Frequency offset (Hz) — shifts FFT rendering position for VFO-shifted display
    this.freqOffset = 0;
    // Noise floor estimation window (Hz). null = full display range.
    // Set to { min, max } in BPF-narrow mode so stopband doesn't pull
    // the noise floor down and over-colour passband signals.
    this.noiseWindow = null;

    // Residual buffer for streaming
    this.residual = new Float32Array(0);

    // ── Overlay canvas for axis/lines (non-scrolling) ────────────────────
    // Axis labels and DF/target lines are drawn on a separate canvas that
    // sits on top of the spectrogram canvas.  Because this canvas is never
    // scrolled (only fully cleared + redrawn each frame), moving a line
    // leaves no trace in the spectrogram history.
    const ov = document.createElement('canvas');
    ov.style.cssText = 'position:absolute;bottom:0;left:0;width:100%;height:280px;pointer-events:none;';
    canvas.parentNode?.insertBefore(ov, canvas.nextSibling);
    this._overlayCanvas = ov;
    this._overlayCtx = ov.getContext('2d');
  }

  /** Update sample rate and recompute frequency bin mapping. */
  setSampleRate(rate) {
    if (rate === this.sampleRate) return;
    this.sampleRate = rate;
    this.binMin = Math.floor(this.freqMin / this.sampleRate * this.fftSize);
    this.binMax = Math.ceil(this.freqMax / this.sampleRate * this.fftSize);
    this.numBins = this.binMax - this.binMin;
  }

  /** Clear the waterfall display. */
  clear() {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.residual = new Float32Array(0);
  }

  /**
   * Feed audio samples and render new spectrogram rows.
   * Can be called with any chunk size; internal buffering handles alignment.
   * @param {Float32Array|Int16Array} samples
   */
  pushSamples(samples) {
    // Convert Int16Array to Float32Array if needed
    let floats;
    if (samples instanceof Int16Array) {
      floats = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
    } else {
      floats = samples;
    }

    // Concatenate with residual
    const combined = new Float32Array(this.residual.length + floats.length);
    combined.set(this.residual);
    combined.set(floats, this.residual.length);

    // Process overlapping windows (50% overlap = step by fftSize/2)
    const step = this.fftSize >> 1;
    let pos = 0;
    while (pos + this.fftSize <= combined.length) {
      this._renderRow(combined, pos);
      pos += step;
    }

    // Save residual
    this.residual = combined.slice(pos);
  }

  /**
   * Draw decoded message labels on the waterfall.
   * Labels are placed just above the period boundary line.
   * @param {Array} messages - array of { freq_hz, message }
   * @param {number} yOffset - vertical position (pixels from bottom, default 4)
   */
  drawLabels(messages, yOffset = 4) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const freqRange = this.freqMax - this.freqMin;

    ctx.font = '10px monospace';
    ctx.textBaseline = 'bottom';

    for (const msg of messages) {
      const x = ((msg.freq_hz - this.freqMin) / freqRange) * w;
      if (x < 0 || x > w) continue;

      const text = msg.message || '';
      if (!text) continue;
      const tw = ctx.measureText(text).width + 4;
      const y = h - yOffset;

      // Background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(x - 1, y - 12, tw, 12);

      // Text
      ctx.fillStyle = '#ffeb3b';
      ctx.fillText(text, x + 1, y);
    }
  }

  /**
   * Record current scroll position for label placement tracking.
   * Call this right after drawPeriodLine() to remember where the
   * period boundary is on the canvas.
   */
  get labelY() {
    return 4; // labels sit just above the period line at the bottom
  }

  /**
   * Draw a horizontal period boundary line at the bottom of the waterfall.
   */
  drawPeriodLine() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.strokeStyle = '#f44336';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Redraw the overlay (axis labels + DF/target lines) on top of the spectrogram. */
  drawFreqAxis() {
    this._refreshOverlay();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  _renderRow(samples, offset) {
    const n = this.fftSize;
    const re = this._re;
    const im = this._im;

    // Apply window and copy
    for (let i = 0; i < n; i++) {
      re[i] = samples[offset + i] * this.window[i];
      im[i] = 0;
    }

    fft(re, im);

    // Compute power spectrum (dB) for display range
    const power = new Float32Array(this.numBins);
    for (let i = 0; i < this.numBins; i++) {
      const bin = this.binMin + i;
      const mag = re[bin] * re[bin] + im[bin] * im[bin];
      power[i] = 10 * Math.log10(mag + 1e-20);
    }

    // Adaptive noise floor — estimate from passband only in narrow mode.
    // Mirrors WASM compute_snr_db which uses within-signal bins for noise.
    // +3 dB boost in narrow mode keeps weak stations visible (user pref).
    let noiseSlice;
    if (this.noiseWindow) {
      const bps = this.sampleRate / this.fftSize; // Hz per bin
      const lo = Math.max(0, Math.round((this.noiseWindow.min - this.freqMin) / bps));
      const hi = Math.min(this.numBins, Math.round((this.noiseWindow.max - this.freqMin) / bps));
      noiseSlice = (lo < hi) ? power.slice(lo, hi) : power;
    } else {
      noiseSlice = power;
    }
    const sorted = Float32Array.from(noiseSlice).sort();
    const median = sorted[sorted.length >> 1];
    const boost = this.noiseWindow ? -3 : 0; // lower threshold = show weaker signals
    this.noiseFloor = this.noiseFloor * 0.95 + (median + boost) * 0.05;

    // Scroll canvas up by 1 row
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.drawImage(this.canvas, 0, 1, w, h - 1, 0, 0, w, h - 1);

    // Draw new row at bottom
    const imgData = ctx.createImageData(w, 1);
    const data = imgData.data;
    const lut = this.colorLut;
    const dbMin = this.noiseFloor;
    const dbMax = dbMin + this.dynRange;

    // freqOffset: shift rendering position so VFO-shifted audio aligns
    // with the original (Watch-mode) frequency axis. Offset in bins.
    const offsetBins = this.freqOffset / (this.sampleRate / this.fftSize);

    for (let px = 0; px < w; px++) {
      // Map pixel to bin, applying frequency offset
      const binF = (px / w) * this.numBins - offsetBins;
      if (binF < 0 || binF >= this.numBins - 1) {
        // Outside audio data range → dark background
        data[px * 4 + 3] = 255;
        continue;
      }
      const bin0 = Math.floor(binF);
      const bin1 = Math.min(bin0 + 1, this.numBins - 1);
      const frac = binF - bin0;
      const db = power[bin0] * (1 - frac) + power[bin1] * frac;

      // Map dB to color index
      const norm = Math.max(0, Math.min(1, (db - dbMin) / (dbMax - dbMin)));
      const ci = Math.round(norm * 255) * 4;

      data[px * 4 + 0] = lut[ci + 0];
      data[px * 4 + 1] = lut[ci + 1];
      data[px * 4 + 2] = lut[ci + 2];
      data[px * 4 + 3] = 255;
    }

    ctx.putImageData(imgData, 0, h - 1);

    // Refresh non-scrolling overlay (axis labels + DF/target lines).
    // These are drawn on a separate canvas so they never leave traces
    // in the scrolling spectrogram history when moved.
    this._refreshOverlay();
  }

  // ── Overlay canvas helpers ───────────────────────────────────────────────

  /** Sync overlay canvas pixel dimensions to the main canvas. */
  _syncOverlaySize() {
    const ov = this._overlayCanvas;
    if (ov.width !== this.canvas.width) ov.width = this.canvas.width;
    if (ov.height !== this.canvas.height) ov.height = this.canvas.height;
  }

  /** Clear and redraw all overlay elements (axis, DF line, target line). */
  _refreshOverlay() {
    this._syncOverlaySize();
    const ctx = this._overlayCtx;
    const w = this._overlayCanvas.width;
    const h = this._overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);
    this._drawFreqAxisInternal(ctx, w);
    this._drawDfLine(ctx, w, h);
    this._drawTargetLine(ctx, w, h);
  }

  _drawFreqAxisInternal(ctx, w) {
    const freqRange = this.freqMax - this.freqMin;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, w, 16);

    ctx.font = '10px monospace';
    ctx.textBaseline = 'top';

    const ticks = [200, 500, 1000, 1500, 2000, 2500, 3000];
    for (const f of ticks) {
      const x = ((f - this.freqMin) / freqRange) * w;
      ctx.fillStyle = '#666';
      ctx.fillRect(x, 13, 1, 3);
      ctx.fillStyle = '#999';
      ctx.fillText(`${f}`, x + 2, 2);
    }
  }

  /** Draw a vertical DF line if set. */
  _drawDfLine(ctx, w, h) {
    if (this.dfLine == null) return;
    const x = ((this.dfLine - this.freqMin) / (this.freqMax - this.freqMin)) * w;
    if (x < 0 || x > w) return;

    ctx.strokeStyle = '#f44336';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 16);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Frequency label near top
    ctx.font = '10px monospace';
    ctx.fillStyle = '#f44336';
    ctx.textBaseline = 'top';
    ctx.fillText(`${this.dfLine}`, x + 3, 17);
  }

  /** Draw a vertical target line (green) for Snipe mode BPF center. */
  _drawTargetLine(ctx, w, h) {
    if (this.targetLine == null) return;
    const x = ((this.targetLine - this.freqMin) / (this.freqMax - this.freqMin)) * w;
    if (x < 0 || x > w) return;

    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 16);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '10px monospace';
    ctx.fillStyle = '#4caf50';
    ctx.textBaseline = 'top';
    ctx.fillText(`${this.targetLine}`, x + 3, 27);
  }
}

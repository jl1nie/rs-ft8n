// AudioWorklet processor for FT8 audio capture.
// Runs on the audio rendering thread — no ES module imports allowed.
//
// Dual-rate design (both target rates handled INSIDE the worklet so we
// never depend on Chrome's live MediaStream resampler, which slips on
// high-rate / weak-clock setups):
//
//   • Snapshot/period buffer: boxcar-decimated to `snapshotTargetRate`
//     (default 48 kHz). The decode pipeline (ft8-core) resamples this
//     offline to 12 kHz via resample_to_12k.
//   • Waterfall path: boxcar-decimated to `waterfallTargetRate`
//     (default 6 kHz) so the main-thread JS FFT load is independent of
//     the AudioContext native rate.
//
// If the AudioContext rate is below a target, we passthrough at native
// (boxcar can only decimate, not upsample).

class FT8AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.outputRate = sampleRate; // AudioWorklet global — actual AudioContext rate

    const opts = options?.processorOptions || {};
    const snapshotTargetRate  = opts.snapshotTargetRate  || 48000;
    const waterfallTargetRate = opts.waterfallTargetRate || 6000;

    // Effective rates: target unless native is lower (then passthrough).
    this.snapshotRate  = Math.min(this.outputRate, snapshotTargetRate);
    this.waterfallRate = Math.min(this.outputRate, waterfallTargetRate);

    // Snapshot/period buffer at the *snapshot* rate (15 seconds worth).
    this.bufferSize = Math.round(this.snapshotRate * 15);
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.recording = false;

    // Snapshot path decimator state (boxcar averager + phase accumulator).
    this.snapDecimRatio = this.outputRate / this.snapshotRate;  // 1.0 if native ≤ target
    this.snapDecimPhase = 0;
    this.snapBoxSum = 0;
    this.snapBoxN = 0;

    // Waterfall path decimator state (same approach).
    this.wfDecimRatio = this.outputRate / this.waterfallRate;
    this.wfDecimPhase = 0;
    this.wfBoxSum = 0;
    this.wfBoxN = 0;
    // Chunk size 512 at 6 kHz target → one chunk every ~85 ms, matching the
    // original 12k/1024 cadence so the waterfall scrolls at ~12 fps. Larger
    // chunks (e.g. 1024 here) bunch renders into 170 ms bursts which look
    // jerky and feel "heavy" even though the actual CPU work is lower.
    this.waterfallChunkSize = 512;
    this.waterfallAccum = new Float32Array(this.waterfallChunkSize);
    this.waterfallPos = 0;

    // Peak level tracking — based on native rate so cadence is rate-independent.
    this.peakLevel = 0;
    this.peakFrameCount = 0;
    this.peakReportInterval = Math.round(this.outputRate / 128 * 0.1); // ~100 ms

    this.port.onmessage = (e) => {
      if (e.data.type === 'start') {
        this.recording = true;
        this._resetState();
      } else if (e.data.type === 'stop') {
        this.recording = false;
      } else if (e.data.type === 'snapshot') {
        const snapshot = this.buffer.slice(0, this.writePos);
        this.port.postMessage({
          type: 'snapshot',
          samples: snapshot,
          length: this.writePos,
          sampleRate: this.snapshotRate,
        });
        this._resetState();
      }
    };

    // Report rates to main thread.
    // nativeRate    = what Chrome ended up using for the AudioContext
    // snapshotRate  = what we hand to the WASM decoder (boxcar-decimated)
    // waterfallRate = what the spectrogram FFT runs at
    this.port.postMessage({
      type: 'info',
      nativeRate: this.outputRate,
      snapshotRate: this.snapshotRate,
      waterfallRate: this.waterfallRate,
      bufferSize: this.bufferSize,
    });
  }

  _resetState() {
    this.writePos = 0;
    this.snapDecimPhase = 0;
    this.snapBoxSum = 0;
    this.snapBoxN = 0;
    this.wfDecimPhase = 0;
    this.wfBoxSum = 0;
    this.wfBoxN = 0;
    this.waterfallPos = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || !this.recording) return true;

    // Track peak level across the raw input (pre-decimation, so the meter
    // reflects what's actually arriving on the wire).
    for (let i = 0; i < input.length; i++) {
      const abs = Math.abs(input[i]);
      if (abs > this.peakLevel) this.peakLevel = abs;
    }
    this.peakFrameCount += input.length;
    if (this.peakFrameCount >= this.peakReportInterval) {
      this.port.postMessage({ type: 'peak', level: this.peakLevel });
      this.peakLevel = 0;
      this.peakFrameCount = 0;
    }

    // Hot-loop locals (V8 prefers these to repeated `this.` lookups).
    const buffer = this.buffer;
    const bufferSize = this.bufferSize;
    const wfAccum = this.waterfallAccum;
    const wfChunk = this.waterfallChunkSize;
    const snapDecimRatio = this.snapDecimRatio;
    const wfDecimRatio = this.wfDecimRatio;

    // Fast path: both ratios are 1.0 (native rate equals both targets,
    // i.e. native ≤ 6 kHz, which won't happen in practice but keep the
    // path consistent). Skipped — fall through to general path.

    // Fast path: snapshot ratio == 1.0 (native equals snapshot target,
    // typical for 48 kHz mics). memcpy snapshot, per-sample boxcar for
    // waterfall.
    if (snapDecimRatio === 1.0) {
      const remaining = bufferSize - this.writePos;
      const copyLen = Math.min(input.length, remaining);
      if (copyLen > 0) {
        buffer.set(input.subarray(0, copyLen), this.writePos);
        this.writePos += copyLen;
      }
      // Waterfall boxcar decim
      for (let i = 0; i < input.length; i++) {
        const sample = input[i];
        this.wfBoxSum += sample;
        this.wfBoxN++;
        this.wfDecimPhase += 1;
        if (this.wfDecimPhase >= wfDecimRatio) {
          this.wfDecimPhase -= wfDecimRatio;
          const avg = this.wfBoxSum / this.wfBoxN;
          this.wfBoxSum = 0;
          this.wfBoxN = 0;
          if (this.waterfallPos < wfChunk) {
            wfAccum[this.waterfallPos++] = avg;
          }
          if (this.waterfallPos >= wfChunk) {
            this.port.postMessage({
              type: 'waterfall',
              samples: new Float32Array(wfAccum),
            });
            this.waterfallPos = 0;
          }
        }
      }
    } else {
      // General path: dual boxcar decimators (snapshot AND waterfall).
      // Used when AudioContext is at a high native rate (e.g. 384 kHz on
      // a system with a high-end DAC) and we need to fold it down to the
      // 48 kHz snapshot target.
      for (let i = 0; i < input.length; i++) {
        const sample = input[i];

        // Snapshot decimation
        this.snapBoxSum += sample;
        this.snapBoxN++;
        this.snapDecimPhase += 1;
        if (this.snapDecimPhase >= snapDecimRatio) {
          this.snapDecimPhase -= snapDecimRatio;
          const avg = this.snapBoxSum / this.snapBoxN;
          this.snapBoxSum = 0;
          this.snapBoxN = 0;
          if (this.writePos < bufferSize) {
            buffer[this.writePos++] = avg;
          }
        }

        // Waterfall decimation
        this.wfBoxSum += sample;
        this.wfBoxN++;
        this.wfDecimPhase += 1;
        if (this.wfDecimPhase >= wfDecimRatio) {
          this.wfDecimPhase -= wfDecimRatio;
          const avg = this.wfBoxSum / this.wfBoxN;
          this.wfBoxSum = 0;
          this.wfBoxN = 0;
          if (this.waterfallPos < wfChunk) {
            wfAccum[this.waterfallPos++] = avg;
          }
          if (this.waterfallPos >= wfChunk) {
            this.port.postMessage({
              type: 'waterfall',
              samples: new Float32Array(wfAccum),
            });
            this.waterfallPos = 0;
          }
        }
      }
    }

    if (this.writePos >= bufferSize) {
      this.port.postMessage({ type: 'buffer-full' });
    }

    return true;
  }
}

registerProcessor('ft8-audio-processor', FT8AudioProcessor);

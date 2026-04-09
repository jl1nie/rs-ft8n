// AudioWorklet processor for FT8 audio capture.
// Runs on the audio rendering thread — no ES module imports allowed.
//
// AudioContext is forced to 12 kHz on the JS side, so the worklet sees
// 12 kHz samples directly. The two output paths are:
//
//   • Snapshot/period buffer — kept at 12 kHz (no decimation, no boxcar).
//     Handed to the WASM decoder verbatim. Touching this path is what
//     broke earlier iterations; it MUST stay a simple per-sample copy.
//
//   • Waterfall chunks — boxcar-decimated 12 kHz → 6 kHz (factor 2 by
//     default) so the main-thread JS FFT can run at fftSize=1024 with
//     the same 5.86 Hz/bin resolution as the old 12k/2048 setup, at
//     about half the CPU cost. Visually identical for FT8.
//
// The 6 kHz target is configurable via processorOptions.waterfallTargetRate.
// Falls back to passthrough if the worklet rate is at or below the target.

class FT8AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.outputRate = sampleRate; // AudioWorklet global — should be 12000

    const opts = options?.processorOptions || {};
    const waterfallTargetRate = opts.waterfallTargetRate || 6000;

    // Snapshot/period buffer — 15 seconds at outputRate (12k → 180000 samples)
    this.bufferSize = Math.round(this.outputRate * 15);
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.recording = false;

    // Waterfall path: boxcar averager + phase-accumulator decimator.
    // At outputRate=12k and waterfallTargetRate=6k, decimRatio is exactly 2.
    this.waterfallRate = Math.min(this.outputRate, waterfallTargetRate);
    this.wfDecimRatio = this.outputRate / this.waterfallRate;
    this.wfDecimPhase = 0;
    this.wfBoxSum = 0;
    this.wfBoxN = 0;

    // 512 samples at 6 kHz → 85 ms per chunk → ~12 fps render cadence,
    // matching the original 12k/1024 cadence.
    this.waterfallChunkSize = 512;
    this.waterfallAccum = new Float32Array(this.waterfallChunkSize);
    this.waterfallPos = 0;

    // Peak level tracking
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
          sampleRate: this.outputRate,
        });
        this._resetState();
      }
    };

    // Report rates to main thread
    this.port.postMessage({
      type: 'info',
      nativeRate: this.outputRate,
      outputRate: this.outputRate,    // legacy alias = snapshot rate
      snapshotRate: this.outputRate,
      waterfallRate: this.waterfallRate,
      bufferSize: this.bufferSize,
    });
  }

  _resetState() {
    this.writePos = 0;
    this.waterfallPos = 0;
    this.wfBoxSum = 0;
    this.wfBoxN = 0;
    this.wfDecimPhase = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || !this.recording) return true;

    // Track peak level
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

    // Hot-loop locals
    const buffer = this.buffer;
    const bufferSize = this.bufferSize;
    const wfAccum = this.waterfallAccum;
    const wfChunk = this.waterfallChunkSize;
    const wfDecimRatio = this.wfDecimRatio;

    for (let i = 0; i < input.length; i++) {
      const sample = input[i];

      // (1) Snapshot/period buffer — UNCHANGED, simple per-sample copy.
      //     This path goes straight to the WASM decoder.
      if (this.writePos < bufferSize) {
        buffer[this.writePos++] = sample;
      }

      // (2) Waterfall path — boxcar accumulate, emit one decimated sample
      //     whenever the phase accumulator crosses the ratio. Snapshot
      //     path is independent of this; only the visualization is
      //     downsampled.
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

    if (this.writePos >= bufferSize) {
      this.port.postMessage({ type: 'buffer-full' });
    }

    return true;
  }
}

registerProcessor('ft8-audio-processor', FT8AudioProcessor);

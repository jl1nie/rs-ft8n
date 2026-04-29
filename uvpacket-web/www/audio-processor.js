// SPDX-License-Identifier: GPL-3.0-or-later
// AudioWorklet processor for uvpacket capture. Adapted from ft8-web's
// `ft8-audio-processor` (the 12 kHz / 6 kHz path that is empirically
// the most stable across Chromium / Firefox / Safari and across mic
// rates from 16 kHz built-in to 384 kHz pro DAC).
//
// Key differences from ft8-web:
//   • Snapshot path uses a *ring buffer* rather than fill-then-flush,
//     because uvpacket bursts arrive at any time (unlike FT8's 15 s
//     slot grid). `snapshot(seconds)` returns the most-recent N seconds
//     without resetting state.
//   • Buffer size shrunk 15 s → 8 s — even Express mode at 32 blocks
//     fits in well under 4 s of audio, so 8 s gives 2× safety margin.
//
// The waterfall path is taken verbatim from ft8-web: boxcar decimate
// 12 k → 6 k at the AudioWorklet thread, post 512-sample chunks every
// ~85 ms. The main thread runs ft8-web's `Waterfall` class on those
// chunks at fftSize=1024 → 5.86 Hz/bin resolution.

class UvAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // `sampleRate` is the AudioWorkletGlobalScope global = AudioContext
    // sample rate. Posted up so the JS side can compare against the
    // requested 12 kHz and resample / warn if Chrome ignored it
    // (rare but possible on some mobile / Bluetooth combos).
    this.outputRate = sampleRate;

    const opts = options?.processorOptions || {};
    const waterfallTargetRate = opts.waterfallTargetRate || 6000;
    this.bufferSeconds = opts.bufferSeconds || 8;

    // Snapshot buffer: ring at outputRate.
    this.bufferSize = Math.round(this.outputRate * this.bufferSeconds);
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;

    // Waterfall path: boxcar averager + phase-accumulator decimator,
    // exactly the ft8-web pattern.
    this.waterfallRate = Math.min(this.outputRate, waterfallTargetRate);
    this.wfDecimRatio = this.outputRate / this.waterfallRate;
    this.wfDecimPhase = 0;
    this.wfBoxSum = 0;
    this.wfBoxN = 0;
    this.waterfallChunkSize = 512;
    this.waterfallAccum = new Float32Array(this.waterfallChunkSize);
    this.waterfallPos = 0;

    // Peak meter
    this.peakLevel = 0;
    this.peakFrameCount = 0;
    this.peakReportInterval = Math.round(this.outputRate * 0.1);

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'snapshot') {
        const wantSamples = Math.min(
          this.bufferSize,
          Math.round((m.seconds || this.bufferSeconds) * this.outputRate),
        );
        const snap = new Float32Array(wantSamples);
        const start = (this.writePos - wantSamples + this.bufferSize) % this.bufferSize;
        for (let i = 0; i < wantSamples; i++) {
          snap[i] = this.buffer[(start + i) % this.bufferSize];
        }
        this.port.postMessage({ type: 'snapshot', samples: snap }, [snap.buffer]);
      } else if (m.type === 'reset') {
        this.writePos = 0;
        this.buffer.fill(0);
      }
    };

    // Inform the main thread of the actual rates.
    this.port.postMessage({
      type: 'info',
      nativeRate: this.outputRate,
      snapshotRate: this.outputRate,
      waterfallRate: this.waterfallRate,
      bufferSize: this.bufferSize,
    });
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    // Peak meter
    for (let i = 0; i < input.length; i++) {
      const a = Math.abs(input[i]);
      if (a > this.peakLevel) this.peakLevel = a;
    }
    this.peakFrameCount += input.length;
    if (this.peakFrameCount >= this.peakReportInterval) {
      this.port.postMessage({ type: 'peak', level: this.peakLevel });
      this.peakLevel = 0;
      this.peakFrameCount = 0;
    }

    const buf = this.buffer;
    const bufSize = this.bufferSize;
    const wfAccum = this.waterfallAccum;
    const wfChunk = this.waterfallChunkSize;
    const wfDecim = this.wfDecimRatio;

    for (let i = 0; i < input.length; i++) {
      const s = input[i];

      // Snapshot ring buffer.
      buf[this.writePos] = s;
      this.writePos = (this.writePos + 1) % bufSize;

      // Waterfall: boxcar accumulate + phase-accumulator decimate.
      this.wfBoxSum += s;
      this.wfBoxN++;
      this.wfDecimPhase += 1;
      if (this.wfDecimPhase >= wfDecim) {
        this.wfDecimPhase -= wfDecim;
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
    return true;
  }
}

registerProcessor('uv-audio-processor', UvAudioProcessor);

// SPDX-License-Identifier: GPL-3.0-or-later
// AudioWorklet processor for uvpacket capture.
//
// AudioContext is forced to 12 kHz on the JS side (matching mfsk-core's
// uvpacket sample rate), so this worklet sees 12 kHz samples directly
// and just hands them up to the main thread.
//
// Two output paths:
//   • snapshot — rolling ring buffer at 12 kHz (the WASM decoder reads
//     a window from the latest tail). 8 seconds is enough to fully
//     contain even an Express 32-block frame (≈ 2.0 s at 1200 baud)
//     plus generous slack for preamble drift.
//   • waterfall — short chunks (256 samples ≈ 21 ms) posted as-is to
//     the main thread for an inline FFT-based waterfall.
//
// All ports / messages go through `port.postMessage`, no SharedArrayBuffer.

class UvAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.outputRate = sampleRate;
    const opts = options?.processorOptions || {};
    this.bufferSeconds = opts.bufferSeconds || 8;
    this.bufferSize = Math.round(this.outputRate * this.bufferSeconds);
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.totalSamples = 0;

    this.waterfallChunkSize = 256;
    this.waterfallChunk = new Float32Array(this.waterfallChunkSize);
    this.waterfallChunkPos = 0;

    this.peak = 0;
    this.peakSamples = 0;
    this.peakReportInterval = Math.round(this.outputRate * 0.1);

    this.port.onmessage = (e) => {
      if (e.data?.type === 'snapshot') {
        // Caller wants the most recent N seconds. Default = full buffer.
        const wantSamples = Math.min(
          this.bufferSize,
          Math.round((e.data.seconds || this.bufferSeconds) * this.outputRate),
        );
        const snap = new Float32Array(wantSamples);
        // Read from oldest to newest within the requested window.
        const start = (this.writePos - wantSamples + this.bufferSize) % this.bufferSize;
        for (let i = 0; i < wantSamples; i++) {
          snap[i] = this.buffer[(start + i) % this.bufferSize];
        }
        this.port.postMessage({ type: 'snapshot', samples: snap }, [snap.buffer]);
      } else if (e.data?.type === 'reset') {
        this.writePos = 0;
        this.totalSamples = 0;
        this.buffer.fill(0);
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = channel[i];
      // Ring buffer write
      this.buffer[this.writePos] = s;
      this.writePos = (this.writePos + 1) % this.bufferSize;
      this.totalSamples++;

      // Waterfall chunk accumulation
      this.waterfallChunk[this.waterfallChunkPos++] = s;
      if (this.waterfallChunkPos >= this.waterfallChunkSize) {
        this.port.postMessage({ type: 'waterfall', samples: this.waterfallChunk.slice() });
        this.waterfallChunkPos = 0;
      }

      // Peak tracking
      const a = Math.abs(s);
      if (a > this.peak) this.peak = a;
      this.peakSamples++;
      if (this.peakSamples >= this.peakReportInterval) {
        this.port.postMessage({ type: 'peak', value: this.peak });
        this.peak = 0;
        this.peakSamples = 0;
      }
    }
    return true;
  }
}

registerProcessor('uv-audio-processor', UvAudioProcessor);

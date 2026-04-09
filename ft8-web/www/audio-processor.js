// AudioWorklet processor for FT8 audio capture.
// Runs on the audio rendering thread — no ES module imports allowed.
// AudioContext is forced to 12 kHz by the JS side, so the worklet sees
// 12 kHz samples directly. Both the snapshot/period buffer and the
// waterfall accumulator are filled at this rate; no decimation here.

class FT8AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.outputRate = sampleRate; // AudioWorklet global — should be 12000

    this.bufferSize = Math.round(this.outputRate * 15); // 15 seconds
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.recording = false;
    this.waterfallChunkSize = 1024;
    this.waterfallAccum = new Float32Array(this.waterfallChunkSize);
    this.waterfallPos = 0;

    // Peak level tracking
    this.peakLevel = 0;
    this.peakFrameCount = 0;
    this.peakReportInterval = Math.round(this.outputRate / 128 * 0.1); // ~100 ms

    this.port.onmessage = (e) => {
      if (e.data.type === 'start') {
        this.recording = true;
        this.writePos = 0;
        this.waterfallPos = 0;
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
        this.writePos = 0;
        this.waterfallPos = 0;
      }
    };

    // Report rate to main thread
    this.port.postMessage({
      type: 'info',
      nativeRate: this.outputRate,
      outputRate: this.outputRate,
      bufferSize: this.bufferSize,
    });
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

    // Write samples to both buffers
    for (let i = 0; i < input.length; i++) {
      const sample = input[i];

      // Period buffer
      if (this.writePos < this.bufferSize) {
        this.buffer[this.writePos++] = sample;
      }

      // Waterfall chunk
      if (this.waterfallPos < this.waterfallChunkSize) {
        this.waterfallAccum[this.waterfallPos++] = sample;
      }
      if (this.waterfallPos >= this.waterfallChunkSize) {
        this.port.postMessage({
          type: 'waterfall',
          samples: new Float32Array(this.waterfallAccum),
        });
        this.waterfallPos = 0;
      }
    }

    // Notify when buffer is full
    if (this.writePos >= this.bufferSize) {
      this.port.postMessage({ type: 'buffer-full' });
    }

    return true;
  }
}

registerProcessor('ft8-audio-processor', FT8AudioProcessor);

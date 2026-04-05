// AudioWorklet processor for FT8 audio capture.
// Runs on the audio rendering thread — no ES module imports allowed.
// Handles resampling from native rate to 12kHz and accumulates 15-second buffers.

class FT8AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = 12000;
    this.nativeRate = sampleRate; // AudioWorklet global 'sampleRate'
    this.decimation = Math.round(this.nativeRate / this.targetRate);
    // Actual output rate after integer decimation
    this.outputRate = this.nativeRate / this.decimation;

    this.bufferSize = Math.round(this.outputRate * 15); // 15 seconds at output rate
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.recording = false;
    this.waterfallChunkSize = 1024;
    this.waterfallAccum = new Float32Array(this.waterfallChunkSize);
    this.waterfallPos = 0;

    // Simple decimation counter
    this.decimCounter = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'start') {
        this.recording = true;
        this.writePos = 0;
        this.waterfallPos = 0;
        this.decimCounter = 0;
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
        this.decimCounter = 0;
      }
    };

    // Report actual rates to main thread
    this.port.postMessage({
      type: 'info',
      nativeRate: this.nativeRate,
      outputRate: this.outputRate,
      decimation: this.decimation,
      bufferSize: this.bufferSize,
    });
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || !this.recording) return true;

    // Decimate: take every Nth sample (simple, works well for integer ratios)
    for (let i = 0; i < input.length; i++) {
      this.decimCounter++;
      if (this.decimCounter >= this.decimation) {
        this.decimCounter = 0;
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
    }

    // Notify when buffer is full
    if (this.writePos >= this.bufferSize) {
      this.port.postMessage({ type: 'buffer-full' });
    }

    return true;
  }
}

registerProcessor('ft8-audio-processor', FT8AudioProcessor);

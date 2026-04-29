// SPDX-License-Identifier: GPL-3.0-or-later
// Microphone capture into a 12-kHz rolling buffer for uvpacket decode.
//
// Forces AudioContext to 12 kHz (Chrome's polyphase resampler does the
// 48 k → 12 k conversion server-side). The WASM decoder consumes 12 kHz
// f32 PCM verbatim; this class hides the worklet plumbing and exposes
// `snapshot(seconds)` + a `onWaterfall` chunk callback.

export class UvAudioCapture {
  /**
   * @param {Object} cb
   * @param {function(Float32Array)} cb.onWaterfall - per-chunk samples
   * @param {function(number)} [cb.onPeak] - 0..1 input level for VU meter
   */
  constructor(cb) {
    this.cb = cb || {};
    this.ctx = null;
    this.stream = null;
    this.workletNode = null;
    this.running = false;
  }

  async listInputDevices() {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch {
      return [];
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  async start(deviceId) {
    if (this.running) await this.stop();
    this.ctx = new AudioContext({ sampleRate: 12000 });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('audio-processor.js');

    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.ctx, 'uv-audio-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { bufferSeconds: 8 },
    });
    this.workletNode.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'waterfall' && this.cb.onWaterfall) {
        this.cb.onWaterfall(m.samples);
      } else if (m.type === 'peak' && this.cb.onPeak) {
        this.cb.onPeak(m.value);
      } else if (m.type === 'snapshot') {
        if (this._pendingSnapshot) {
          this._pendingSnapshot(m.samples);
          this._pendingSnapshot = null;
        }
      }
    };
    source.connect(this.workletNode);
    this.running = true;
  }

  /** Take a snapshot of the most recent `seconds` of audio. */
  async snapshot(seconds = 4) {
    if (!this.workletNode) return new Float32Array(0);
    return new Promise((resolve) => {
      this._pendingSnapshot = resolve;
      this.workletNode.port.postMessage({ type: 'snapshot', seconds });
    });
  }

  reset() {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'reset' });
    }
  }

  async stop() {
    this.running = false;
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {}
      this.ctx = null;
    }
  }
}

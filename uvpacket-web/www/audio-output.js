// SPDX-License-Identifier: GPL-3.0-or-later
// Play a 12-kHz f32 waveform produced by the WASM uvpacket encoder.

export class UvAudioOutput {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.gainNode = null;
    this.gain = 1.0;
  }

  /**
   * @param {Float32Array} samples - 12 kHz f32 PCM, peak ≤ 1.0
   * @param {string} [deviceId]    - output device ID (Chromium only)
   * @returns {Promise<void>} resolves when playback completes
   */
  async play(samples, deviceId) {
    this.stop();
    this.ctx = new AudioContext({ sampleRate: 12000 });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    if (deviceId && this.ctx.setSinkId) {
      try {
        await this.ctx.setSinkId(deviceId);
      } catch {}
    }

    const buf = this.ctx.createBuffer(1, samples.length, 12000);
    buf.copyToChannel(samples, 0);

    this.source = this.ctx.createBufferSource();
    this.source.buffer = buf;
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.gain;
    this.source.connect(this.gainNode).connect(this.ctx.destination);

    return new Promise((resolve) => {
      this.source.onended = () => {
        this.stop();
        resolve();
      };
      this.source.start();
    });
  }

  setGain(g) {
    this.gain = Math.max(0, Math.min(1, g));
    if (this.gainNode) this.gainNode.gain.value = this.gain;
  }

  stop() {
    if (this.source) {
      try {
        this.source.stop();
      } catch {}
      this.source.disconnect();
      this.source = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {}
      this.ctx = null;
    }
  }
}

// FT8 audio waveform playback via Web Audio API.
// Plays the encoded FT8 signal through the selected audio output device.

export class AudioOutput {
  constructor() {
    this.ctx = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.playing = false;
    this.gain = 1.0;
  }

  /**
   * Play an FT8 waveform through the specified audio output.
   * @param {Float32Array} samples — 12 kHz f32 PCM (from encode_ft8)
   * @param {string} [deviceId] — output device ID (optional)
   * @returns {Promise} resolves when playback completes
   */
  async play(samples, deviceId) {
    this.stop();

    const sampleRate = 12000;
    this.ctx = new AudioContext({ sampleRate });

    // Android Chrome suspends AudioContext without user gesture — resume it
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // Set output device if supported and specified
    if (deviceId && this.ctx.setSinkId) {
      try { await this.ctx.setSinkId(deviceId); } catch (e) {
        console.warn('setSinkId failed:', e);
      }
    }

    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = buffer;
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.gain;
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);

    return new Promise((resolve) => {
      this.playing = true;
      this.sourceNode.onended = () => {
        this.playing = false;
        this.ctx.close();
        this.ctx = null;
        resolve();
      };
      this.sourceNode.start();
    });
  }

  /** Set output gain (0.0 - 2.0). */
  setGain(value) {
    this.gain = value;
    if (this.gainNode) this.gainNode.gain.value = value;
  }

  /** Compute peak level of samples (for meter display before playback). */
  static peakLevel(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > peak) peak = abs;
    }
    return peak;
  }

  /** Stop playback immediately. */
  stop() {
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch (e) {}
      this.sourceNode = null;
    }
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.playing = false;
  }
}

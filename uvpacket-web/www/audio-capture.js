// SPDX-License-Identifier: GPL-3.0-or-later
// Microphone capture for uvpacket — adapted from ft8-web AudioCapture.
// Forces AudioContext to 12 kHz (most stable across Chrome / Firefox /
// Safari per ft8-web's empirical history); the worklet boxcar-decimates
// to 6 kHz for the waterfall path while the snapshot path stays at
// 12 kHz, ready to hand to mfsk-core's uvpacket decoder verbatim.

export class UvAudioCapture {
  /**
   * @param {Object} cb
   * @param {function(Float32Array)} cb.onWaterfall
   * @param {function(number)}        [cb.onPeak]
   * @param {function(number)}        [cb.onSampleRate]  — called with
   *        the waterfall sample rate (typically 6000 Hz) so the main
   *        thread can configure its Waterfall instance accordingly.
   * @param {function(number)}        [cb.onSnapshotRate] — called with
   *        the snapshot sample rate (typically 12000 Hz). If anything
   *        other than 12000 the main thread must resample before
   *        feeding the WASM decoder.
   */
  constructor(cb) {
    this.cb = cb || {};
    this.audioCtx = null;
    this.stream = null;
    this.workletNode = null;
    this.gainNode = null;
    this.running = false;
    this.snapshotRate = 12000;
    this.waterfallRate = 6000;
    this._pendingSnapshot = null;
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

    this.audioCtx = new AudioContext({ sampleRate: 12000 });
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    console.log(
      '[uvpacket-web] capture AudioContext.sampleRate =',
      this.audioCtx.sampleRate,
    );

    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const tracks = this.stream.getAudioTracks();
    const trackSettings = tracks[0]?.getSettings?.() || {};
    console.log(
      '[uvpacket-web] mic device reports',
      trackSettings.sampleRate || 'unknown',
      'Hz; AudioContext =',
      this.audioCtx.sampleRate,
      'Hz',
    );

    const source = this.audioCtx.createMediaStreamSource(this.stream);

    const processorUrl = new URL('audio-processor.js', import.meta.url).href;
    await this.audioCtx.audioWorklet.addModule(processorUrl);

    this.workletNode = new AudioWorkletNode(this.audioCtx, 'uv-audio-processor', {
      processorOptions: { bufferSeconds: 8, waterfallTargetRate: 6000 },
    });

    this.workletNode.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'info') {
        this.snapshotRate = m.snapshotRate;
        this.waterfallRate = m.waterfallRate;
        console.log(
          '[uvpacket-web] worklet snapshot=',
          m.snapshotRate,
          'Hz waterfall=',
          m.waterfallRate,
          'Hz',
        );
        if (this.cb.onSnapshotRate) this.cb.onSnapshotRate(m.snapshotRate);
        if (this.cb.onSampleRate) this.cb.onSampleRate(m.waterfallRate);
      } else if (m.type === 'waterfall' && this.cb.onWaterfall) {
        this.cb.onWaterfall(m.samples);
      } else if (m.type === 'peak' && this.cb.onPeak) {
        this.cb.onPeak(m.level);
      } else if (m.type === 'snapshot' && this._pendingSnapshot) {
        this._pendingSnapshot(m.samples);
        this._pendingSnapshot = null;
      }
    };

    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = 1.0;
    source.connect(this.gainNode);
    this.gainNode.connect(this.workletNode);

    this.running = true;
  }

  /** Take a snapshot of the most recent `seconds` of audio. */
  async snapshot(seconds = 6) {
    if (!this.workletNode) return new Float32Array(0);
    if (this.audioCtx?.state === 'suspended') {
      await this.audioCtx.resume().catch(() => {});
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingSnapshot = null;
        resolve(new Float32Array(0));
      }, 5000);
      this._pendingSnapshot = (samples) => {
        clearTimeout(timer);
        resolve(samples);
      };
      this.workletNode.port.postMessage({ type: 'snapshot', seconds });
    });
  }

  reset() {
    this.workletNode?.port.postMessage({ type: 'reset' });
  }

  setGain(value) {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, value);
  }

  async stop() {
    this.running = false;
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'reset' });
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch {}
      this.audioCtx = null;
    }
  }
}

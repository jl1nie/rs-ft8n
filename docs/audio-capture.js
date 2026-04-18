// Audio device capture for FT8 decoding.
// Handles getUserMedia, AudioContext setup, and resampling to 12kHz.

export class AudioCapture {
  /**
   * @param {Object} callbacks
   * @param {function(Float32Array)} callbacks.onWaterfall - small audio chunks for waterfall
   * @param {function()} callbacks.onBufferFull - 15-second buffer is full
   */
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.audioCtx = null;
    this.stream = null;
    this.workletNode = null;
    this.gainNode = null;
    this.running = false;
    this.actualSampleRate = 12000;
    this._onDisconnect = null; // callback when device disconnects
    this.onPeak = null; // callback(level: 0-1) for input level meter
    this.onSampleRate = null; // callback(rate) when actual sample rate is determined
  }

  /** Enumerate available audio input devices. */
  async enumerateDevices() {
    // Need a temporary getUserMedia call to get device labels
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach(t => t.stop());
    } catch (e) {
      // Permission denied — return empty list
      return [];
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(d => d.kind === 'audioinput')
      .map(d => ({ id: d.deviceId, label: d.label || `Device ${d.deviceId.slice(0, 8)}` }));
  }

  /**
   * Start capturing audio from the specified device.
   * @param {string} deviceId - audio device ID (from enumerateDevices)
   */
  async start(deviceId) {
    if (this.running) return;

    // Force AudioContext to 12 kHz. Empirically (across Atom tablets, Ryzen 9
    // with high-end DAC at 384 kHz mixer, and a generic 48 kHz mic input),
    // this is the *least bad* configuration: Chrome's polyphase resampler
    // produces a clean 48k → 12k stream, while every other rate combination
    // we tried (native rate, mic rate, in-worklet boxcar at 48 kHz) produced
    // a wavy/sinusoidal spectrum. The 12 kHz path engages Chrome's offline
    // SINC resampler which smooths out source-side clock jitter, whereas a
    // matched rate just hands us whatever the source delivers (jitter and all).
    this.audioCtx = new AudioContext({ sampleRate: 12000 });
    this.actualSampleRate = this.audioCtx.sampleRate;

    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const tracks = this.stream.getAudioTracks();
    const trackSettings = tracks[0]?.getSettings?.() || {};
    const micRate = trackSettings.sampleRate || 'unknown';
    console.log(
      `AudioCapture: mic device reports ${micRate} Hz, AudioContext = ${this.actualSampleRate} Hz`
    );

    // Detect device disconnection
    for (const track of tracks) {
      track.onended = () => {
        if (this.running) {
          this.stop();
          if (this._onDisconnect) this._onDisconnect();
        }
      };
    }

    const source = this.audioCtx.createMediaStreamSource(this.stream);

    // Load AudioWorklet
    const processorUrl = new URL('audio-processor.js', import.meta.url).href;
    await this.audioCtx.audioWorklet.addModule(processorUrl);

    // Worklet boxcar-decimates the waterfall path to 6 kHz internally
    // (snapshot path stays at 12 kHz). Halves the main-thread FFT cost
    // while keeping bin width identical to the old 12k/2048 setup.
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'ft8-audio-processor', {
      processorOptions: { waterfallTargetRate: 6000 },
    });

    // Handle messages from worklet
    this.workletNode.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'info') {
        // Snapshot rate (= AudioContext rate) is what runDecode uses;
        // waterfall rate is what the spectrogram FFT runs at.
        this.actualSampleRate = msg.snapshotRate || msg.outputRate;
        this.waterfallRate = msg.waterfallRate || msg.outputRate;
        console.log(
          `Audio: native=${msg.nativeRate} Hz, snapshot=${this.actualSampleRate} Hz, waterfall=${this.waterfallRate} Hz`
        );
        if (this.onSampleRate) this.onSampleRate(this.waterfallRate);
      } else if (msg.type === 'waterfall' && this.callbacks.onWaterfall) {
        this.callbacks.onWaterfall(msg.samples);
      } else if (msg.type === 'buffer-full' && this.callbacks.onBufferFull) {
        this.callbacks.onBufferFull();
      } else if (msg.type === 'peak' && this.onPeak) {
        this.onPeak(msg.level);
      } else if (msg.type === 'snapshot' && this._snapshotResolve) {
        this._snapshotResolve(msg.samples);
        this._snapshotResolve = null;
      }
    };

    // Insert gain node for input level control
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = 1.0;
    source.connect(this.gainNode);
    this.gainNode.connect(this.workletNode);
    // Don't connect to destination (we don't want to play back)

    this.workletNode.port.postMessage({ type: 'start' });
    this.running = true;
  }

  /** Stop capturing. */
  stop() {
    if (!this.running) return;
    this.workletNode?.port.postMessage({ type: 'stop' });
    this.stream?.getTracks().forEach(t => t.stop());
    this.audioCtx?.close();
    this.workletNode = null;
    this.stream = null;
    this.audioCtx = null;
    this.running = false;
  }

  /**
   * Request a snapshot of the current buffer for decoding.
   * Returns a Promise<Float32Array> with the accumulated samples.
   *
   * Automatically resumes the AudioContext if Chrome auto-suspended it
   * (happens after a period of no user interaction).  Without this,
   * the worklet stops processing and the snapshot promise never resolves,
   * stalling _scheduleBoundary() and halting decode entirely.
   * A 5-second timeout ensures the period loop always continues even if
   * the worklet fails to respond (returns empty array as fallback).
   */
  snapshot() {
    // Resume if browser auto-suspended the AudioContext.
    if (this.audioCtx?.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._snapshotResolve = null;
        resolve(new Float32Array(0));
      }, 5000);
      this._snapshotResolve = (samples) => {
        clearTimeout(timer);
        resolve(samples);
      };
      this.workletNode?.port.postMessage({ type: 'snapshot' });
    });
  }

  /** Set input gain (0.0 - 2.0). */
  setGain(value) {
    if (this.gainNode) this.gainNode.gain.value = value;
  }

  /** Get the actual sample rate of the AudioContext. */
  getSampleRate() {
    return this.actualSampleRate;
  }
}

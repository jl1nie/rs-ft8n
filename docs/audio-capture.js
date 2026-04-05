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
    this.running = false;
    this.actualSampleRate = 12000;
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

    // Use native AudioContext — AudioWorklet handles decimation to 12kHz
    this.audioCtx = new AudioContext();
    this.actualSampleRate = 12000; // will be updated by worklet info message

    // Get audio stream — disable all processing for clean radio audio
    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: 12000 },
      }
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const source = this.audioCtx.createMediaStreamSource(this.stream);

    // Load AudioWorklet
    const processorUrl = new URL('audio-processor.js', import.meta.url).href;
    await this.audioCtx.audioWorklet.addModule(processorUrl);

    // If we need resampling (native rate != 12kHz), insert an OfflineAudioContext
    // resampler. For simplicity, we handle 48kHz → 12kHz (factor 4) in the worklet.
    // For now, if AudioContext is at 12kHz, the worklet gets 12kHz samples directly.

    this.workletNode = new AudioWorkletNode(this.audioCtx, 'ft8-audio-processor');

    // Handle messages from worklet
    this.workletNode.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'info') {
        this.actualSampleRate = msg.outputRate;
        console.log(`Audio: native=${msg.nativeRate} Hz, output=${msg.outputRate} Hz, decimation=${msg.decimation}`);
      } else if (msg.type === 'waterfall' && this.callbacks.onWaterfall) {
        this.callbacks.onWaterfall(msg.samples);
      } else if (msg.type === 'buffer-full' && this.callbacks.onBufferFull) {
        this.callbacks.onBufferFull();
      } else if (msg.type === 'snapshot' && this._snapshotResolve) {
        this._snapshotResolve(msg.samples);
        this._snapshotResolve = null;
      }
    };

    source.connect(this.workletNode);
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
   */
  snapshot() {
    return new Promise((resolve) => {
      this._snapshotResolve = resolve;
      this.workletNode?.port.postMessage({ type: 'snapshot' });
    });
  }

  /** Get the actual sample rate of the AudioContext. */
  getSampleRate() {
    return this.actualSampleRate;
  }
}

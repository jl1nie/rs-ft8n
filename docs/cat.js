// CAT (Computer Aided Transceiver) control via Web Serial API.
// Currently supports Icom CI-V protocol for PTT control.

export class CatController {
  constructor() {
    this.port = null;
    this.writer = null;
    this.connected = false;
    this.protocol = 'civ'; // 'civ' (Icom) for now
    this.civAddress = 0x94; // Default Icom address (IC-7300)
  }

  /** Check if Web Serial API is available. */
  static isSupported() {
    return 'serial' in navigator;
  }

  /** Enumerate available serial ports (requires user gesture). */
  async requestPort() {
    if (!CatController.isSupported()) {
      throw new Error('Web Serial API not supported in this browser');
    }
    this.port = await navigator.serial.requestPort();
    return this.port;
  }

  /**
   * Connect to the serial port.
   * @param {Object} opts
   * @param {number} opts.baudRate — baud rate (default 19200 for Icom)
   * @param {number} [opts.civAddress] — CI-V address (default 0x94 for IC-7300)
   */
  async connect(opts = {}) {
    if (!this.port) throw new Error('No port selected');
    const baudRate = opts.baudRate || 19200;
    if (opts.civAddress !== undefined) this.civAddress = opts.civAddress;

    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this.connected = true;
  }

  /** Disconnect. */
  async disconnect() {
    if (this.writer) {
      this.writer.releaseLock();
      this.writer = null;
    }
    if (this.port) {
      await this.port.close();
    }
    this.connected = false;
  }

  /**
   * Set PTT state.
   * @param {boolean} on — true = transmit, false = receive
   */
  async ptt(on) {
    if (!this.connected) throw new Error('Not connected');

    if (this.protocol === 'civ') {
      await this._civSend(0x1C, 0x00, on ? [0x01] : [0x00]);
    }
  }

  /**
   * Set VFO frequency (Hz).
   * @param {number} freqHz — frequency in Hz (e.g. 14074000)
   */
  async setFreq(freqHz) {
    if (!this.connected) throw new Error('Not connected');

    if (this.protocol === 'civ') {
      // CI-V frequency format: 5 bytes BCD, LSB first
      // e.g. 14074000 Hz → 00 40 07 14 00
      const bcd = [];
      let f = Math.round(freqHz);
      for (let i = 0; i < 5; i++) {
        const lo = f % 10; f = Math.floor(f / 10);
        const hi = f % 10; f = Math.floor(f / 10);
        bcd.push((hi << 4) | lo);
      }
      await this._civSend(0x05, null, bcd);
    }
  }

  // ── CI-V protocol internals ──────────────────────────────────────────

  async _civSend(cmd, subCmd, data = []) {
    // CI-V frame: FE FE <to> <from> <cmd> [<sub>] [<data>...] FD
    const frame = [0xFE, 0xFE, this.civAddress, 0xE0, cmd];
    if (subCmd !== null && subCmd !== undefined) frame.push(subCmd);
    frame.push(...data);
    frame.push(0xFD);

    await this.writer.write(new Uint8Array(frame));
  }
}

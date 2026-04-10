// CAT (Computer Aided Transceiver) control via Web Serial API.
// Rig profiles loaded from rig-profiles.json (editable/extensible).

let rigProfiles = {};

/** Load rig profiles from JSON file. */
export async function loadRigProfiles() {
  try {
    const url = new URL('rig-profiles.json', import.meta.url).href;
    const res = await fetch(url);
    rigProfiles = await res.json();
  } catch (e) {
    console.warn('Failed to load rig-profiles.json:', e);
  }
  return rigProfiles;
}

/** Get loaded profiles. */
export function getRigProfiles() { return rigProfiles; }

// ── Hex string helpers ──────────────────────────────────────────────────────

function hexToBytes(hexStr) {
  return new Uint8Array(hexStr.trim().split(/\s+/).map(h => parseInt(h, 16)));
}

function parseAddr(s) {
  if (typeof s === 'number') return s;
  return parseInt(s, 16);
}

// ── CAT Controller ──────────────────────────────────────────────────────────

export class CatController {
  constructor() {
    this.port = null;
    this.writer = null;
    this._reader = null;
    this._readLoopDone = null;
    this.connected = false;
    this.rig = null;
    this.rigId = '';
    this.pttOn = false;
    this.narrowOn = false;
    this.onDisconnect = null;
  }

  static isSupported() { return 'serial' in navigator; }

  async requestPort() {
    if (!CatController.isSupported()) throw new Error('Web Serial API not supported');
    this.port = await navigator.serial.requestPort();
    return this.port;
  }

  async connect(rigId) {
    if (!this.port) throw new Error('No port selected');
    const rig = rigProfiles[rigId];
    if (!rig) throw new Error(`Unknown rig: ${rigId}`);

    this.rig = rig;
    this.rigId = rigId;
    try {
      await this.port.open({ baudRate: rig.baud });
      this.writer = this.port.writable.getWriter();
      if (this.port.readable) {
        this._reader = this.port.readable.getReader();
        this._readLoopDone = this._readLoop();
      }
      this.connected = true;
      this.pttOn = false;
      this.narrowOn = false;
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }

  async disconnect() {
    this.connected = false;
    await this.safePttOff();

    // 1. Cancel reader (terminates read loop)
    if (this._reader) {
      try { await this._reader.cancel(); } catch (_) {}
    }
    // Wait for read loop to finish and releaseLock
    if (this._readLoopDone) {
      try { await this._readLoopDone; } catch (_) {}
      this._readLoopDone = null;
    }

    // 2. Release writer lock
    if (this.writer) {
      try { this.writer.releaseLock(); } catch (_) {}
      this.writer = null;
    }

    // 3. Close port (safe now — all locks released)
    try { if (this.port) await this.port.close(); } catch (_) {}

    this.pttOn = false;
    this.narrowOn = false;
  }

  async ptt(on) {
    if (!this.connected || !this.rig) return;
    try {
      const cmd = on ? this.rig.pttOn : this.rig.pttOff;
      if (this.rig.protocol === 'civ') {
        await this._civSendHex(cmd);
      } else {
        await this._sendText(cmd);
      }
      this.pttOn = on;
    } catch (e) {
      this._handleDisconnect();
      throw e;
    }
  }

  async safePttOff() {
    if (!this.connected || !this.pttOn) return;
    try { await this.ptt(false); } catch (_) { this.pttOn = false; }
  }

  async setFilter(narrow) {
    if (!this.connected || !this.rig) return;
    try {
      const cmd = narrow ? this.rig.filterNarrow : this.rig.filterWide;
      if (!cmd) return;
      if (this.rig.protocol === 'civ') {
        await this._civSendHex(cmd);
      } else {
        await this._sendText(cmd);
      }
      this.narrowOn = narrow;
    } catch (e) {
      this._handleDisconnect();
    }
  }

  async setFreq(freqHz) {
    if (!this.connected || !this.rig) return;
    try {
      if (this.rig.protocol === 'civ') {
        await this._civSetFreq(freqHz);
      } else {
        const hz = String(Math.round(freqHz)).padStart(9, '0');
        await this._sendText(`FA${hz};`);
      }
    } catch (e) {
      this._handleDisconnect();
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  async _readLoop() {
    try {
      while (true) {
        const { done } = await this._reader.read();
        if (done) break;
        // CI-V response parsing can be added here in the future
      }
    } catch (_) {
      // Port disconnect or reader.cancel() lands here
    } finally {
      try { this._reader.releaseLock(); } catch (_) {}
      this._reader = null;
    }
  }

  _handleDisconnect() {
    this.connected = false;
    this.pttOn = false;
    this.narrowOn = false;
    // Best-effort cleanup of stream locks
    if (this._reader) {
      try { this._reader.cancel(); } catch (_) {}
    }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch (_) {}
      this.writer = null;
    }
    if (this.onDisconnect) this.onDisconnect();
  }

  async _sendText(cmd) {
    await this.writer.write(new TextEncoder().encode(cmd));
  }

  async _civSendHex(hexStr) {
    const addr = parseAddr(this.rig.civAddr || '0x94');
    const data = hexToBytes(hexStr);
    const frame = new Uint8Array([0xFE, 0xFE, addr, 0xE0, ...data, 0xFD]);
    await this.writer.write(frame);
  }

  async _civSetFreq(freqHz) {
    const bcd = [];
    let f = Math.round(freqHz);
    for (let i = 0; i < 5; i++) {
      const lo = f % 10; f = Math.floor(f / 10);
      const hi = f % 10; f = Math.floor(f / 10);
      bcd.push((hi << 4) | lo);
    }
    const addr = parseAddr(this.rig.civAddr || '0x94');
    const frame = new Uint8Array([0xFE, 0xFE, addr, 0xE0, 0x05, ...bcd, 0xFD]);
    await this.writer.write(frame);
  }
}

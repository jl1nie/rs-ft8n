// CAT (Computer Aided Transceiver) control via Web Serial / Web Bluetooth / Tauri.
// Rig profiles loaded from rig-profiles.json (editable/extensible).
// In Tauri desktop mode, serial access uses native OS APIs via invoke().

import { BleTransport } from './ble-transport.js';

let rigProfiles = {};

// ── Tauri detection ────────────────────────────────────────────────────────
const isTauri = !!(window.__TAURI_INTERNALS__);

async function tauriInvoke(cmd, args) {
  const { invoke } = await import('https://unpkg.com/@tauri-apps/api@2/core');
  return invoke(cmd, args);
}

// Lazy-load Tauri invoke if available
if (isTauri) {
  // Override invoke with direct __TAURI_INTERNALS__ call for bundled builds
  // (unpkg import is fallback for dev mode)
  try {
    const ti = window.__TAURI_INTERNALS__;
    if (ti && ti.invoke) {
      // Use the built-in invoke directly
      const _origInvoke = tauriInvoke;
      // @ts-ignore
      globalThis.__tauriInvoke = (cmd, args) => ti.invoke(cmd, args);
    }
  } catch (_) {}
}

async function invokeCmd(cmd, args) {
  if (globalThis.__tauriInvoke) return globalThis.__tauriInvoke(cmd, args);
  return tauriInvoke(cmd, args);
}

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

/** Check if running in Tauri desktop mode. */
export function isTauriMode() { return isTauri; }

/** List available serial ports (Tauri only). */
export async function listSerialPorts() {
  if (!isTauri) return [];
  return invokeCmd('serial_list_ports');
}

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
    this.transport = null;  // { write(Uint8Array), disconnect() }
    this.transportType = ''; // 'serial' | 'ble' | 'tauri'
    this.port = null;       // Web Serial port (serial mode only)
    this.writer = null;     // Web Serial writer (serial mode only)
    this.ble = null;        // BleTransport instance (ble mode only)
    this.connected = false;
    this.rig = null;
    this.rigId = '';
    this.pttOn = false;
    this.narrowOn = false;
    this.onDisconnect = null;
  }

  static isSerialSupported() { return isTauri || ('serial' in navigator); }
  static isBleSupported() { return BleTransport.isSupported(); }
  /** @deprecated Use isSerialSupported() */
  static isSupported() { return CatController.isSerialSupported(); }

  async requestPort() {
    if (isTauri) {
      // Tauri mode — port selection handled by connectTauri()
      this.transportType = 'tauri';
      return null;
    }
    if (!('serial' in navigator)) throw new Error('Web Serial API not supported');
    this.port = await navigator.serial.requestPort();
    this.transportType = 'serial';
    return this.port;
  }

  /** Connect via Tauri native serial.
   * @param {string} rigId - rig profile key
   * @param {string} portName - COM port name (e.g. "COM5")
   */
  async connectTauri(rigId, portName) {
    const rig = rigProfiles[rigId];
    if (!rig) throw new Error(`Unknown rig: ${rigId}`);

    await invokeCmd('serial_open', {
      portName,
      baudRate: rig.baud,
      stopBits: rig.stopBits || null,
    });

    this.rig = rig;
    this.rigId = rigId;
    this.transportType = 'tauri';
    this.transport = {
      write: async (data) => {
        await invokeCmd('serial_write', { data: Array.from(data) });
      },
    };
    this.connected = true;
    this.pttOn = false;
    this.narrowOn = false;
    console.log(`[CAT] Tauri serial connected: ${portName} @ ${rig.baud} baud`);
  }

  async connectBle(rigId) {
    const rig = rigProfiles[rigId];
    if (!rig) throw new Error(`Unknown rig: ${rigId}`);
    if (!rig.ble) throw new Error(`${rig.label} does not support BLE`);

    const ble = new BleTransport();
    ble.onDisconnect = () => this._handleDisconnect();
    await ble.connect();

    this.transport = ble;
    this.ble = ble;        // direct reference for GPS/CI-V callbacks
    this.transportType = 'ble';
    this.rig = rig;
    this.rigId = rigId;
    this.connected = true;
    this.pttOn = false;
    this.narrowOn = false;
  }

  async connect(rigId) {
    if (this.transportType === 'ble') {
      // BLE path — already connected via connectBle()
      return;
    }
    if (this.transportType === 'tauri') {
      // Tauri path — already connected via connectTauri()
      return;
    }
    // Web Serial path
    if (!this.port) throw new Error('No port selected');
    const rig = rigProfiles[rigId];
    if (!rig) throw new Error(`Unknown rig: ${rigId}`);

    this.rig = rig;
    this.rigId = rigId;
    // If the port was left open by a previous session (e.g. tab crash, PWA
    // close without disconnect), close it first so the next open() succeeds.
    if (this.port.readable || this.port.writable) {
      try { await this.port.close(); } catch (_) {}
    }

    const info = this.port.getInfo();
    console.log('[CAT] port info:', JSON.stringify(info),
                'baud:', rig.baud, 'rig:', rigId);
    console.log('[CAT] port state before open: readable=', this.port.readable,
                'writable=', this.port.writable);

    const openOpts = { baudRate: rig.baud };
    if (rig.stopBits) openOpts.stopBits = rig.stopBits;
    console.log('[CAT] calling port.open() with:', JSON.stringify(openOpts));

    // port.open() can hang indefinitely on Windows when another application
    // (e.g. WSJT-X) is holding the same COM port. Race against a 10-second
    // timeout so the UI never gets permanently wedged.
    const timeout = (ms) => new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`open timeout after ${ms}ms`)), ms));
    try {
      await Promise.race([
        this.port.open(openOpts),
        timeout(10000),
      ]);
      console.log('[CAT] port.open() succeeded, readable=', this.port.readable,
                  'writable=', this.port.writable);
      this.writer = this.port.writable.getWriter();
      console.log('[CAT] writer acquired');
      this.transportType = 'serial';
      this.transport = { write: (data) => this.writer.write(data) };
      this.connected = true;
      this.pttOn = false;
      this.narrowOn = false;
    } catch (e) {
      console.error('[CAT] open failed:', e.name, e.message, e);
      // Clean up partially-opened port and force fresh requestPort() next time
      if (this.writer) {
        try { this.writer.releaseLock(); } catch (_) {}
        this.writer = null;
      }
      try { if (this.port) await this.port.close(); } catch (_) {}
      this.port = null;
      this.transport = null;
      this.transportType = '';
      const pi = info ? `VID:${info.usbVendorId} PID:${info.usbProductId}` : 'unknown';
      throw new Error(
        `port open failed [${pi}, ${rig.baud} baud] (${e.name}: ${e.message}). Check: (1) rig is powered on and USB cable connected, (2) no other CAT app (WSJT-X etc.) is using the port.`
      );
    }
  }

  async disconnect() {
    this.connected = false;
    await this.safePttOff();

    if (this.transportType === 'tauri') {
      try { await invokeCmd('serial_close'); } catch (_) {}
    } else if (this.transportType === 'ble') {
      if (this.transport) await this.transport.disconnect();
    } else {
      // Release writer lock, then close port
      if (this.writer) {
        try { this.writer.releaseLock(); } catch (_) {}
        this.writer = null;
      }
      try { if (this.port) await this.port.close(); } catch (_) {}
      this.port = null;
    }
    this.transport = null;
    this.transportType = '';
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

  async setModeData() {
    if (!this.connected || !this.rig) return;
    try {
      const cmd = this.rig.modeData;
      if (!cmd) return;
      if (this.rig.protocol === 'civ') {
        await this._civSendHex(cmd);
      } else {
        await this._sendText(cmd);
      }
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

  _handleDisconnect() {
    // BLE: if the physical GATT link is still alive, this is a transient CI-V
    // write error (e.g., IC-705 not ready right after pairing grant), NOT a
    // true disconnect.  The gattserverdisconnected event handles real drops.
    if (this.transportType === 'ble' && this.ble?.device?.gatt?.connected) {
      console.warn('[CAT] BLE CI-V write error (transient) — physical link alive, not disconnecting');
      return;
    }
    this.connected = false;
    this.pttOn = false;
    this.narrowOn = false;
    if (this.writer) {
      try { this.writer.releaseLock(); } catch (_) {}
      this.writer = null;
    }
    this.ble = null;
    if (this.onDisconnect) this.onDisconnect();
  }

  async _sendText(cmd) {
    await this.transport.write(new TextEncoder().encode(cmd));
  }

  async _civSendHex(hexStr) {
    const addr = parseAddr(this.rig.civAddr || '0x94');
    const data = hexToBytes(hexStr);
    const frame = new Uint8Array([0xFE, 0xFE, addr, 0xE0, ...data, 0xFD]);
    await this.transport.write(frame);
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
    await this.transport.write(frame);
  }
}

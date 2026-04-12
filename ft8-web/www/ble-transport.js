// BLE Transport for Icom IC-705 CI-V over Web Bluetooth API.
// GATT protocol based on K7MDL2/IC-705-BLE-Serial-Example.

const SERVICE_UUID = '14cf8001-1ec2-d408-1b04-2eb270f14203';
const CHAR_UUID    = '14cf8002-1ec2-d408-1b04-2eb270f14203';

// Pairing constants
const DEVICE_UUID = '00001101-0000-1000-8000-00805F9B34FB'; // 36 chars ASCII
const DEVICE_NAME = 'WebFT8 BLE\x00\x00\x00\x00\x00\x00';    // 16 chars padded
const PAIR_TOKEN  = [0xEE, 0x39, 0x09, 0x10];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

export class BleTransport {
  constructor() {
    this.device = null;
    this.server = null;
    this.char = null;
    this.connected = false;
    this.onDisconnect = null;
    this.onGpsTime = null;       // callback(offsetSec) — set by app before connect
    this._grantResolve = null;
    this._pairState = { uuid: false, name: false, token: false, granted: false };
    this._gpsQueryTimer = null;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  async connect() {
    // Request device — IC-705 may not include service UUID in advertisement,
    // so filter by name prefix and declare the service as optional.
    this.device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'ICOM' },
        { namePrefix: 'IC-705' },
        { services: [SERVICE_UUID] },
      ],
      optionalServices: [SERVICE_UUID],
    });

    this.device.addEventListener('gattserverdisconnected', () => {
      this.connected = false;
      if (this.onDisconnect) this.onDisconnect();
    });

    // Connect GATT
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(SERVICE_UUID);
    this.char = await service.getCharacteristic(CHAR_UUID);

    // Enable notifications for receiving responses
    this.char.addEventListener('characteristicvaluechanged', (e) => this._onNotify(e));
    await this.char.startNotifications();

    // Run pairing sequence
    await this._pair();
    // IC-705 needs a moment after the CI-V bus access grant (0x64) before it
    // is ready to accept CI-V commands.  Without this delay, the first write
    // in rigSetup() can fail with a transient GATT error.
    await delay(300);
    this.connected = true;

    // Start periodic GPS UTC query (IC-705 CI-V command 0x23 0x00)
    if (this.onGpsTime) this._startGpsQuery();
  }

  async write(data) {
    if (!this.char) throw new Error('BLE not connected');
    // data is Uint8Array
    await this.char.writeValueWithoutResponse(data);
  }

  async disconnect() {
    this.connected = false;
    clearInterval(this._gpsQueryTimer);
    this._gpsQueryTimer = null;
    try {
      if (this.device && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
    } catch (_) {}
    this.device = null;
    this.server = null;
    this.char = null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  _onNotify(event) {
    const data = new Uint8Array(event.target.value.buffer);
    if (data.length < 4) return;

    // Pairing response: FE F1 00 xx [data] FD
    if (data[0] === 0xFE && data[1] === 0xF1 && data[2] === 0x00) {
      const code = data[3];
      if (code === 0x61) this._pairState.uuid = true;
      else if (code === 0x62) this._pairState.name = true;
      else if (code === 0x63) this._pairState.token = true;
      else if (code === 0x64) {
        this._pairState.granted = true;
        if (this._grantResolve) this._grantResolve();
      }
    }

    // CI-V position response: FE FE E0 xx 23 00 [data] FD
    if (data[0] === 0xFE && data[1] === 0xFE &&
        data[2] === 0xE0 && data[4] === 0x23 && data[5] === 0x00) {
      this._parseCivGpsTime(data);
    }
  }

  // ── GPS UTC sync ────────────────────────────────────────────────────────

  /** Send MY_POSIT_READ (CI-V 0x23 0x00) immediately and every 30 s. */
  _startGpsQuery() {
    const send = () => {
      if (!this.connected || !this.char) return;
      this.char.writeValueWithoutResponse(
        new Uint8Array([0xFE, 0xFE, 0x94, 0xE0, 0x23, 0x00, 0xFD])
      ).catch(() => {});
    };
    send();
    this._gpsQueryTimer = setInterval(send, 30000);
  }

  /**
   * Parse CI-V position response and extract UTC time.
   * Response payload (after FE FE E0 xx 23 00): 27 bytes (with altitude)
   * or 23 bytes (without altitude). UTC fields are at the end.
   *
   * Layout (27-byte variant, BCD encoded):
   *   [0..14]  lat/lon   [15..18] altitude   [19..20] heading
   *   [21] year2  [22] month  [23] day  [24] hour  [25] min  [26] sec
   *
   * 23-byte variant (no altitude/heading): UTC starts at offset 17.
   */
  _parseCivGpsTime(data) {
    // payload = everything between the 6-byte header and trailing FD
    const payload = data.slice(6, data.length - 1);
    const len = payload.length;
    if (len !== 27 && len !== 23) return;
    const off = len === 27 ? 21 : 17;
    const bcd = b => ((b >> 4) * 10) + (b & 0x0F);
    const year  = 2000 + bcd(payload[off]);
    const month = bcd(payload[off + 1]) - 1;  // JS Date: 0-indexed months
    const day   = bcd(payload[off + 2]);
    const hh    = bcd(payload[off + 3]);
    const mm    = bcd(payload[off + 4]);
    const ss    = bcd(payload[off + 5]);
    if (year < 2020 || month < 0 || month > 11) return;  // GPS not fixed
    const gpsMs = Date.UTC(year, month, day, hh, mm, ss);
    const offsetSec = (Date.now() - gpsMs) / 1000;
    if (Math.abs(offsetSec) > 10) return;  // implausible — GPS not acquired
    if (this.onGpsTime) this.onGpsTime(offsetSec);
  }

  async _pair() {
    this._pairState = { uuid: false, name: false, token: false, granted: false };

    // Message 1: UUID (41 bytes)
    const uuidBytes = new TextEncoder().encode(DEVICE_UUID);
    const msg1 = new Uint8Array([0xFE, 0xF1, 0x00, 0x61, ...uuidBytes, 0xFD]);
    await this.char.writeValueWithoutResponse(msg1);
    await delay(20);

    // Message 2: Device name (21 bytes)
    const nameBytes = new TextEncoder().encode(DEVICE_NAME);
    const msg2 = new Uint8Array([0xFE, 0xF1, 0x00, 0x62, ...nameBytes, 0xFD]);
    await this.char.writeValueWithoutResponse(msg2);
    await delay(20);

    // Message 3: Token (9 bytes)
    const msg3 = new Uint8Array([0xFE, 0xF1, 0x00, 0x63, ...PAIR_TOKEN, 0xFD]);
    await this.char.writeValueWithoutResponse(msg3);

    // Wait for CI-V bus access grant (0x64)
    if (!this._pairState.granted) {
      await new Promise((resolve, reject) => {
        this._grantResolve = resolve;
        setTimeout(() => reject(new Error('BLE pairing timeout (no CI-V grant)')), 5000);
      });
    }
  }
}

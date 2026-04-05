// QSO log + RX decode log — stores in localStorage, exports as ZIP.

const QSO_KEY = 'rs-ft8n-qso-log';
const RX_KEY = 'rs-ft8n-rx-log';

export class QsoLog {
  constructor() {
    this.entries = JSON.parse(localStorage.getItem(QSO_KEY) || '[]');
    this.rxLog = JSON.parse(localStorage.getItem(RX_KEY) || '[]');
  }

  /**
   * Add a QSO (completed or incomplete).
   * @param {Object} qso
   * @param {string} qso.dxCall
   * @param {string} qso.dxGrid
   * @param {string} qso.txReport
   * @param {string} qso.rxReport
   * @param {number} qso.freq
   * @param {string} qso.state — QSO state at time of logging (e.g. IDLE=complete, CALLING/REPORT/FINAL=incomplete)
   */
  add(qso) {
    const entry = {
      utc: new Date().toISOString(),
      dxCall: qso.dxCall || '',
      dxGrid: qso.dxGrid || '',
      txReport: qso.txReport || '',
      rxReport: qso.rxReport || '',
      freq: qso.freq || 0,
      bandMHz: qso.bandMHz || '',
      state: qso.state || 'IDLE',
    };
    this.entries.unshift(entry);
    this._saveQso();
    return entry;
  }

  /**
   * Add a decoded RX message to the log.
   * @param {Object} rx
   * @param {string} rx.message
   * @param {number} rx.freq_hz
   * @param {number} rx.snr_db
   */
  addRx(rx) {
    this.rxLog.push({
      utc: new Date().toISOString(),
      message: rx.message,
      freq: Math.round(rx.freq_hz),
      snr: Math.round(rx.snr_db),
    });
    // Keep max 10000 entries to avoid localStorage overflow
    if (this.rxLog.length > 10000) {
      this.rxLog = this.rxLog.slice(-8000);
    }
    this._saveRx();
  }

  getAll() { return this.entries; }
  getRxLog() { return this.rxLog; }

  clear() {
    this.entries = [];
    this.rxLog = [];
    this._saveQso();
    this._saveRx();
  }

  /**
   * Export QSO log as ADIF string.
   * @param {Object} opts
   * @param {boolean} opts.completeOnly — if true, only include completed QSOs (state=IDLE)
   */
  toAdif({ completeOnly = false } = {}) {
    const label = completeOnly ? 'Complete QSOs' : 'All QSOs (incl. incomplete)';
    let adif = `ADIF Export from rs-ft8n — ${label}\n<EOH>\n\n`;
    for (const e of this.entries) {
      if (!e.dxCall) continue;
      if (completeOnly && e.state && e.state !== 'IDLE') continue;
      const d = new Date(e.utc);
      const date = d.toISOString().slice(0, 10).replace(/-/g, '');
      const time = d.toISOString().slice(11, 15).replace(/:/g, '');
      adif += `<CALL:${e.dxCall.length}>${e.dxCall}`;
      if (e.dxGrid) adif += ` <GRIDSQUARE:${e.dxGrid.length}>${e.dxGrid}`;
      adif += ` <MODE:3>FT8`;
      if (e.bandMHz) {
        const fstr = e.bandMHz;
        adif += ` <FREQ:${fstr.length}>${fstr}`;
      }
      adif += ` <QSO_DATE:8>${date}`;
      adif += ` <TIME_ON:4>${time}`;
      if (e.rxReport) adif += ` <RST_RCVD:${e.rxReport.length}>${e.rxReport}`;
      if (e.txReport) adif += ` <RST_SENT:${e.txReport.length}>${e.txReport}`;
      if (e.state && e.state !== 'IDLE') {
        const comment = `incomplete:${e.state}`;
        adif += ` <COMMENT:${comment.length}>${comment}`;
      }
      adif += ` <EOR>\n`;
    }
    return adif;
  }

  /** Export RX log as CSV string. */
  toRxCsv() {
    let csv = 'UTC,Freq(Hz),SNR(dB),Message\n';
    for (const r of this.rxLog) {
      // Escape message for CSV
      const msg = r.message.replace(/"/g, '""');
      csv += `${r.utc},${r.freq},${r.snr},"${msg}"\n`;
    }
    return csv;
  }

  /**
   * Export ADIF + RX CSV as a ZIP file and trigger download.
   * Uses a minimal ZIP builder (no external deps).
   */
  async exportZip() {
    const adifComplete = this.toAdif({ completeOnly: true });
    const adifAll = this.toAdif({ completeOnly: false });
    const rxCsv = this.toRxCsv();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    const files = [
      { name: `qso_complete_${dateStr}.adi`, data: adifComplete },
      { name: `qso_all_${dateStr}.adi`, data: adifAll },
      { name: `rx_${dateStr}.csv`, data: rxCsv },
    ];

    const zipBlob = buildZip(files);
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rs-ft8n_${dateStr}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  _saveQso() { localStorage.setItem(QSO_KEY, JSON.stringify(this.entries)); }
  _saveRx() { localStorage.setItem(RX_KEY, JSON.stringify(this.rxLog)); }
}

// ── Minimal ZIP builder (no dependencies) ──────────────────────────────────

function buildZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const dataBytes = enc.encode(f.data);
    const crc = crc32(dataBytes);

    // Local file header (30 + name + data)
    const local = new ArrayBuffer(30 + nameBytes.length + dataBytes.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true);  // signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // compression (store)
    lv.setUint16(10, 0, true);           // mod time
    lv.setUint16(12, 0, true);           // mod date
    lv.setUint32(14, crc, true);         // crc32
    lv.setUint32(18, dataBytes.length, true); // compressed size
    lv.setUint32(22, dataBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // name length
    lv.setUint16(28, 0, true);           // extra length
    new Uint8Array(local, 30).set(nameBytes);
    new Uint8Array(local, 30 + nameBytes.length).set(dataBytes);
    parts.push(new Uint8Array(local));

    // Central directory entry
    const cd = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(cd);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);       // local header offset
    new Uint8Array(cd, 46).set(nameBytes);
    centralDir.push(new Uint8Array(cd));

    offset += local.byteLength;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centralDir) cdSize += c.length;

  // End of central directory
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...parts, ...centralDir, new Uint8Array(eocd)], { type: 'application/zip' });
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

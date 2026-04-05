// FT8 QSO state machine.
//
// Minimal states — even/odd timing is handled by the period manager,
// not the state machine.
//
// IDLE → CALLING → REPORT → FINAL → IDLE
//
// CALLING: first message sent (CQ or response), waiting for reply
// REPORT:  report exchange in progress
// FINAL:   73/RR73 sent, waiting for confirmation or done

export const QSO_STATE = {
  IDLE: 'IDLE',
  CALLING: 'CALLING',
  REPORT: 'REPORT',
  FINAL: 'FINAL',
};

export class QsoManager {
  /**
   * @param {Object} opts
   * @param {string} opts.myCall
   * @param {string} opts.myGrid
   * @param {function(string)} opts.onStateChange
   * @param {function(Object)} opts.onTxReady — callback({ call1, call2, report })
   */
  constructor(opts) {
    this.myCall = opts.myCall?.toUpperCase() || '';
    this.myGrid = opts.myGrid?.toUpperCase() || '';
    this.onStateChange = opts.onStateChange || (() => {});
    this.onTxReady = opts.onTxReady || (() => {});

    this.state = QSO_STATE.IDLE;
    this.dxCall = '';
    this.dxGrid = '';
    this.txReport = '';
    this.rxReport = '';
    this.rxSnr = -10;
    this.retryCount = 0;
    this.maxRetries = 15;
  }

  setMyInfo(call, grid) {
    this.myCall = call.toUpperCase();
    this.myGrid = grid.toUpperCase();
  }

  reset() {
    this.state = QSO_STATE.IDLE;
    this.dxCall = '';
    this.dxGrid = '';
    this.txReport = '';
    this.rxReport = '';
    this.onStateChange(this.state);
  }

  setRxSnr(snr) {
    this.rxSnr = Math.round(snr);
  }

  /** Start calling CQ. */
  callCq() {
    this.state = QSO_STATE.CALLING;
    this.dxCall = '';
    this.dxGrid = '';
    this.onStateChange(this.state);
    return this._tx('CQ', this.myCall, this.myGrid);
  }

  /** Call a specific station. */
  callStation(dxCall) {
    this.dxCall = dxCall.toUpperCase();
    this.state = QSO_STATE.CALLING;
    this.onStateChange(this.state);
    return this._tx(this.dxCall, this.myCall, this.myGrid);
  }

  /**
   * Process a decoded message. Returns TX message if we should respond, null otherwise.
   * @param {string} message — decoded text
   * @returns {Object|null} { call1, call2, report } or null
   */
  processMessage(message) {
    const words = message.trim().split(/\s+/);
    if (words.length < 2 || !this.myCall) return null;

    switch (this.state) {
      case QSO_STATE.IDLE:
        return this._onIdle(words);
      case QSO_STATE.CALLING:
        return this._onCalling(words);
      case QSO_STATE.REPORT:
        return this._onReport(words);
      case QSO_STATE.FINAL:
        return this._onFinal(words);
      default:
        return null;
    }
  }

  /** Get the current TX message (for manual TX). */
  getNextTx() {
    switch (this.state) {
      case QSO_STATE.CALLING:
        return this.dxCall
          ? { call1: this.dxCall, call2: this.myCall, report: this.myGrid }
          : { call1: 'CQ', call2: this.myCall, report: this.myGrid };
      case QSO_STATE.REPORT:
        return { call1: this.dxCall, call2: this.myCall, report: this.txReport };
      case QSO_STATE.FINAL:
        return { call1: this.dxCall, call2: this.myCall, report: '73' };
      default:
        return null;
    }
  }

  formatTx(tx) {
    if (!tx) return '';
    return `${tx.call1} ${tx.call2} ${tx.report}`.trim();
  }

  /**
   * Called when a period ends with no relevant response from the DX station.
   * Returns the same TX message for retry, or null if max retries exceeded.
   */
  retry() {
    if (this.state === QSO_STATE.IDLE) return null;
    if (this.retryCount >= this.maxRetries) {
      this.reset();
      return null;
    }
    this.retryCount++;
    return this.getNextTx();
  }

  /** Get retry count info string. */
  retryInfo() {
    if (this.state === QSO_STATE.IDLE || this.retryCount === 0) return '';
    return `retry ${this.retryCount}/${this.maxRetries}`;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _autoReport() {
    const snr = Math.max(-50, Math.min(49, this.rxSnr));
    return (snr >= 0 ? '+' : '') + String(snr).padStart(2, '0');
  }

  _tx(call1, call2, report) {
    this.retryCount = 0; // reset on successful state transition
    const tx = { call1, call2, report };
    this.onTxReady(tx);
    return tx;
  }

  _onIdle(words) {
    // "CQ [DX] CALL GRID" — someone calling CQ
    if (words[0] === 'CQ' && this.dxCall) {
      const callPos = words[1] === 'DX' ? 2 : 1;
      if (words[callPos] === this.dxCall) {
        if (words.length > callPos + 1) this.dxGrid = words[callPos + 1];
        return this.callStation(this.dxCall);
      }
    }

    // "MYCALL DXCALL GRID" — someone responding to us or calling us
    if (words[0] === this.myCall && words.length >= 3) {
      this.dxCall = words[1];
      this.dxGrid = words[2];
      this.txReport = this._autoReport();
      this.state = QSO_STATE.REPORT;
      this.onStateChange(this.state);
      return this._tx(this.dxCall, this.myCall, this.txReport);
    }

    return null;
  }

  _onCalling(words) {
    // Waiting for: "MYCALL DXCALL REPORT/GRID"
    if (words[0] === this.myCall && words.length >= 3) {
      const responder = words[1];
      const field = words[2];

      // If already locked to a specific station (directed call, not CQ),
      // only accept that station
      if (this.dxCall && this.dxCall !== responder) {
        return null;
      }

      this.dxCall = responder;
      this.dxGrid = field;

      // Is this a report? (e.g., "-12", "+05", "R-12")
      if (field.match(/^R?[+-]\d{2}$/)) {
        this.rxReport = field;
        const rpt = field.startsWith('R') ? field : `R${field}`;
        this.txReport = rpt;
        this.state = QSO_STATE.REPORT;
        this.onStateChange(this.state);
        return this._tx(this.dxCall, this.myCall, this.txReport);
      }

      // Grid response — send our report
      this.txReport = this._autoReport();
      this.state = QSO_STATE.REPORT;
      this.onStateChange(this.state);
      return this._tx(this.dxCall, this.myCall, this.txReport);
    }
    return null;
  }

  _onReport(words) {
    if (words[0] !== this.myCall || words[1] !== this.dxCall) return null;
    if (words.length < 3) return null;

    const field = words[2];

    // RRR or RR73 — move to final
    if (field === 'RRR' || field === 'RR73') {
      this.state = QSO_STATE.FINAL;
      this.onStateChange(this.state);
      return this._tx(this.dxCall, this.myCall, '73');
    }

    // R+report — they confirmed, send RR73
    if (field.match(/^R[+-]\d{2}$/)) {
      this.rxReport = field;
      this.state = QSO_STATE.FINAL;
      this.onStateChange(this.state);
      return this._tx(this.dxCall, this.myCall, 'RR73');
    }

    // Plain report — send R+report
    if (field.match(/^[+-]\d{2}$/)) {
      this.rxReport = field;
      this.txReport = `R${field}`;
      this.onStateChange(this.state);
      return this._tx(this.dxCall, this.myCall, this.txReport);
    }

    return null;
  }

  _onFinal(words) {
    if (words[0] === this.myCall && words.length >= 3 && words[1] === this.dxCall) {
      if (words[2] === '73' || words[2] === 'RR73') {
        // QSO complete
        const result = {
          dxCall: this.dxCall, dxGrid: this.dxGrid,
          txReport: this.txReport, rxReport: this.rxReport,
        };
        this.state = QSO_STATE.IDLE;
        this.onStateChange(this.state);
        return null; // No more TX — return null but state changed
      }
    }
    return null;
  }
}

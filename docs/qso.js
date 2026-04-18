// FT8 QSO state machine.
//
// IDLE → CALLING → REPORT → FINAL → IDLE
//
// Each state has its own retry limit:
//   CALLING: maxRetries (default 15) — waiting for any response
//   REPORT:  maxRetries — waiting for report confirmation
//   FINAL:   3 retries — 73 sent, just need confirmation (or give up)

export const QSO_STATE = {
  IDLE: 'IDLE',
  CALLING: 'CALLING',
  REPORT: 'REPORT',
  FINAL: 'FINAL',
};

export class QsoManager {
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
    this.maxRetries = 5;      // 5 × 15 s = 75 s before auto-reset
    this.finalMaxRetries = 3; // FINAL state needs fewer retries
    this.cqSuffix = '';  // e.g. "POTA", "SOTA", "DX"
    this.freeText = '';  // Tx5 free text (replaces RR73/73 in FINAL)
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
    this.retryCount = 0;
    this.onStateChange(this.state);
  }

  setRxSnr(snr) {
    this.rxSnr = Math.round(snr);
  }

  /** Start calling CQ, optionally with a suffix (POTA, SOTA, DX, etc.). */
  callCq(suffix) {
    this.cqSuffix = (suffix || '').toUpperCase();
    this.state = QSO_STATE.CALLING;
    this.dxCall = '';
    this.dxGrid = '';
    this.retryCount = 0;
    this.onStateChange(this.state);
    const call1 = this.cqSuffix ? `CQ ${this.cqSuffix}` : 'CQ';
    return this._tx(call1, this.myCall, this.myGrid);
  }

  /** Call a specific station. */
  callStation(dxCall) {
    this.dxCall = dxCall.toUpperCase();
    this.state = QSO_STATE.CALLING;
    this.retryCount = 0;
    this.onStateChange(this.state);
    return this._tx(this.dxCall, this.myCall, this.myGrid);
  }

  /**
   * Process a decoded message. Returns TX message if we should respond, null otherwise.
   */
  processMessage(message) {
    const words = message.trim().split(/\s+/).filter(Boolean);
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
        if (this.dxCall) {
          return { call1: this.dxCall, call2: this.myCall, report: this.myGrid };
        } else {
          const call1 = this.cqSuffix ? `CQ ${this.cqSuffix}` : 'CQ';
          return { call1, call2: this.myCall, report: this.myGrid };
        }
      case QSO_STATE.REPORT:
        return { call1: this.dxCall, call2: this.myCall, report: this.txReport };
      case QSO_STATE.FINAL:
        if (this.freeText) {
          return { call1: '__FREE__', call2: '', report: this.freeText };
        }
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
   * Called when a period ends with no relevant response.
   * Returns TX message for retry, or null if max retries exceeded.
   * FINAL state uses a shorter retry limit (3).
   */
  retry() {
    if (this.state === QSO_STATE.IDLE) return null;
    const limit = this.state === QSO_STATE.FINAL ? this.finalMaxRetries : this.maxRetries;
    if (this.retryCount >= limit) {
      // FINAL timeout: treat as completed (73 was sent, good enough)
      if (this.state === QSO_STATE.FINAL) {
        this.state = QSO_STATE.IDLE;
        this.onStateChange(this.state); // triggers QSO log
        return null;
      }
      this.reset();
      return null;
    }
    this.retryCount++;
    return this.getNextTx();
  }

  /**
   * Manually force a state transition (recovery from desync).
   * Returns the TX object appropriate for the new state, or null.
   */
  forceState(targetState) {
    this.state = targetState;
    this.retryCount = 0;
    this.onStateChange(targetState);
    return this.getNextTx();
  }

  retryInfo() {
    if (this.state === QSO_STATE.IDLE || this.retryCount === 0) return '';
    const limit = this.state === QSO_STATE.FINAL ? this.finalMaxRetries : this.maxRetries;
    return `retry ${this.retryCount}/${limit}`;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _autoReport() {
    const snr = Math.max(-50, Math.min(49, this.rxSnr));
    return (snr >= 0 ? '+' : '') + String(snr).padStart(2, '0');
  }

  _tx(call1, call2, report) {
    this.retryCount = 0;
    const tx = { call1, call2, report };
    this.onTxReady(tx);
    return tx;
  }

  _onIdle(words) {
    // "CQ [DX] CALL GRID" — someone calling CQ (only if we have a target)
    if (words[0] === 'CQ' && this.dxCall) {
      const callPos = words[1] === 'DX' ? 2 : 1;
      if (words[callPos] === this.dxCall) {
        if (words.length > callPos + 1) this.dxGrid = words[callPos + 1];
        return this.callStation(this.dxCall);
      }
    }

    // "MYCALL DXCALL GRID" — someone calling us
    // If dxCall is already set (AP target), only accept from that station
    if (words[0] === this.myCall && words.length >= 3) {
      if (this.dxCall && words[1] !== this.dxCall) return null;
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
    if (words[0] === this.myCall && words.length >= 3) {
      const responder = words[1];
      const field = words[2];

      // Directed call: only accept the target station
      if (this.dxCall && this.dxCall !== responder) {
        return null;
      }

      this.dxCall = responder;
      this.dxGrid = field;

      if (field.match(/^R?[+-]\d{2}$/)) {
        this.rxReport = field;
        const rpt = field.startsWith('R') ? field : `R${field}`;
        this.txReport = rpt;
        this.state = QSO_STATE.REPORT;
        this.onStateChange(this.state);
        return this._tx(this.dxCall, this.myCall, this.txReport);
      }

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

    if (field === 'RRR' || field === 'RR73') {
      this.state = QSO_STATE.FINAL;
      this.onStateChange(this.state);
      return this._tx(this.dxCall, this.myCall, '73');
    }

    if (field.match(/^R[+-]\d{2}$/)) {
      this.rxReport = field;
      this.state = QSO_STATE.FINAL;
      this.onStateChange(this.state);
      return this._tx(this.dxCall, this.myCall, 'RR73');
    }

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
        this.state = QSO_STATE.IDLE;
        this.onStateChange(this.state);
        return null;
      }
    }
    return null;
  }
}

// FT8 QSO state machine.
//
// Standard QSO sequence (responding to CQ):
//   RX: CQ DX_CALL DX_GRID       → state: IDLE → CALLING
//   TX: DX_CALL MY_CALL MY_GRID  → state: CALLING
//   RX: MY_CALL DX_CALL REPORT   → state: ROGER
//   TX: DX_CALL MY_CALL R+REPORT → state: ROGER
//   RX: MY_CALL DX_CALL RRR/RR73 → state: FINAL
//   TX: DX_CALL MY_CALL 73       → state: COMPLETE
//
// Standard QSO sequence (calling CQ):
//   TX: CQ MY_CALL MY_GRID       → state: CQ_SENT
//   RX: MY_CALL DX_CALL DX_GRID  → state: REPORT
//   TX: DX_CALL MY_CALL REPORT   → state: REPORT
//   RX: MY_CALL DX_CALL R+REPORT → state: FINAL
//   TX: DX_CALL MY_CALL RR73     → state: COMPLETE

export const QSO_STATE = {
  IDLE: 'IDLE',
  CQ_SENT: 'CQ_SENT',
  CALLING: 'CALLING',
  ROGER: 'ROGER',
  REPORT: 'REPORT',
  FINAL: 'FINAL',
  COMPLETE: 'COMPLETE',
};

export class QsoManager {
  /**
   * @param {Object} opts
   * @param {string} opts.myCall — my callsign
   * @param {string} opts.myGrid — my grid locator
   * @param {function(string)} opts.onStateChange — callback(state)
   * @param {function(string, string, string)} opts.onTxReady — callback(call1, call2, report)
   */
  constructor(opts) {
    this.myCall = opts.myCall?.toUpperCase() || '';
    this.myGrid = opts.myGrid?.toUpperCase() || '';
    this.onStateChange = opts.onStateChange || (() => {});
    this.onTxReady = opts.onTxReady || (() => {});

    this.state = QSO_STATE.IDLE;
    this.dxCall = '';
    this.dxGrid = '';
    this.txReport = '';   // report we send
    this.rxReport = '';   // report we received
    this.txEven = null;   // true = TX on even periods, false = odd
    this.autoMode = false;
  }

  /** Update my callsign and grid. */
  setMyInfo(call, grid) {
    this.myCall = call.toUpperCase();
    this.myGrid = grid.toUpperCase();
  }

  /** Reset QSO state. */
  reset() {
    this.state = QSO_STATE.IDLE;
    this.dxCall = '';
    this.dxGrid = '';
    this.txReport = '';
    this.rxReport = '';
    this.txEven = null;
    this.onStateChange(this.state);
  }

  /** Start calling CQ. Returns the TX message fields. */
  callCq() {
    this.state = QSO_STATE.CQ_SENT;
    this.dxCall = '';
    this.dxGrid = '';
    this.onStateChange(this.state);
    return { call1: 'CQ', call2: this.myCall, report: this.myGrid };
  }

  /** Manually initiate a call to a specific station. */
  callStation(dxCall, freq) {
    this.dxCall = dxCall.toUpperCase();
    this.state = QSO_STATE.CALLING;
    this.onStateChange(this.state);
    return { call1: this.dxCall, call2: this.myCall, report: this.myGrid };
  }

  /**
   * Process a decoded message and advance the QSO state.
   * @param {string} message — decoded message text (e.g. "CQ 3Y0Z JD34")
   * @param {boolean} isEven — true if this was decoded in an even period
   * @returns {Object|null} — TX message fields if we should transmit, null if no action
   */
  processMessage(message, isEven) {
    const words = message.trim().split(/\s+/);
    if (words.length < 2) return null;

    const myCallUp = this.myCall;
    if (!myCallUp) return null;

    switch (this.state) {
      case QSO_STATE.IDLE:
        return this._handleIdle(words, isEven);

      case QSO_STATE.CQ_SENT:
        return this._handleCqSent(words, isEven);

      case QSO_STATE.CALLING:
        return this._handleCalling(words, isEven);

      case QSO_STATE.ROGER:
        return this._handleRoger(words, isEven);

      case QSO_STATE.REPORT:
        return this._handleReport(words, isEven);

      case QSO_STATE.FINAL:
        return this._handleFinal(words, isEven);

      default:
        return null;
    }
  }

  /** Get the next TX message for the current state (for manual TX). */
  getNextTx() {
    switch (this.state) {
      case QSO_STATE.CQ_SENT:
        return { call1: 'CQ', call2: this.myCall, report: this.myGrid };
      case QSO_STATE.CALLING:
        return { call1: this.dxCall, call2: this.myCall, report: this.myGrid };
      case QSO_STATE.ROGER:
        return { call1: this.dxCall, call2: this.myCall, report: this.txReport };
      case QSO_STATE.REPORT:
        return { call1: this.dxCall, call2: this.myCall, report: this.txReport || '-10' };
      case QSO_STATE.FINAL:
        return { call1: this.dxCall, call2: this.myCall, report: '73' };
      default:
        return null;
    }
  }

  /** Format TX message as display string. */
  formatTx(tx) {
    if (!tx) return '';
    return `${tx.call1} ${tx.call2} ${tx.report}`.trim();
  }

  // ── State handlers ──────────────────────────────────────────────────

  _handleIdle(words, isEven) {
    // Look for "CQ <DX_CALL> <GRID>" directed at anyone
    if (words[0] === 'CQ' && this.dxCall && words.length >= 2) {
      // We have a target DX — check if this is their CQ
      if (words[1] === this.dxCall || (words.length >= 3 && words[1] === 'DX' && words[2] === this.dxCall)) {
        return this.callStation(this.dxCall);
      }
    }
    return null;
  }

  _handleCqSent(words, isEven) {
    // Look for "<MY_CALL> <DX_CALL> <GRID>"
    if (words[0] === this.myCall && words.length >= 3) {
      this.dxCall = words[1];
      this.dxGrid = words[2];
      this.txReport = '-10'; // default report
      this.state = QSO_STATE.REPORT;
      this.txEven = !isEven; // TX on the opposite slot
      this.onStateChange(this.state);
      const tx = { call1: this.dxCall, call2: this.myCall, report: this.txReport };
      this.onTxReady(tx.call1, tx.call2, tx.report);
      return tx;
    }
    return null;
  }

  _handleCalling(words, isEven) {
    // Look for "<MY_CALL> <DX_CALL> <REPORT>"
    if (words[0] === this.myCall && words.length >= 3) {
      if (words[1] === this.dxCall) {
        this.rxReport = words[2]; // e.g. "-12"
        // Send R+report
        const rpt = this.rxReport.startsWith('R') ? this.rxReport : `R${this.rxReport}`;
        this.txReport = rpt;
        this.state = QSO_STATE.ROGER;
        this.txEven = !isEven;
        this.onStateChange(this.state);
        const tx = { call1: this.dxCall, call2: this.myCall, report: this.txReport };
        this.onTxReady(tx.call1, tx.call2, tx.report);
        return tx;
      }
    }
    return null;
  }

  _handleRoger(words, isEven) {
    // Look for "<MY_CALL> <DX_CALL> RRR" or "RR73"
    if (words[0] === this.myCall && words.length >= 3 && words[1] === this.dxCall) {
      if (words[2] === 'RRR' || words[2] === 'RR73') {
        this.state = QSO_STATE.FINAL;
        this.onStateChange(this.state);
        const tx = { call1: this.dxCall, call2: this.myCall, report: '73' };
        this.onTxReady(tx.call1, tx.call2, tx.report);
        return tx;
      }
    }
    return null;
  }

  _handleReport(words, isEven) {
    // Look for "<MY_CALL> <DX_CALL> R<REPORT>"
    if (words[0] === this.myCall && words.length >= 3 && words[1] === this.dxCall) {
      const w2 = words[2];
      if (w2.startsWith('R+') || w2.startsWith('R-')) {
        this.rxReport = w2;
        this.state = QSO_STATE.FINAL;
        this.onStateChange(this.state);
        const tx = { call1: this.dxCall, call2: this.myCall, report: 'RR73' };
        this.onTxReady(tx.call1, tx.call2, tx.report);
        return tx;
      }
    }
    return null;
  }

  _handleFinal(words, isEven) {
    // Look for 73 or RR73 — QSO complete
    if (words[0] === this.myCall && words.length >= 3 && words[1] === this.dxCall) {
      if (words[2] === '73' || words[2] === 'RR73') {
        this.state = QSO_STATE.COMPLETE;
        this.onStateChange(this.state);
        return null; // No more TX
      }
    }
    return null;
  }
}

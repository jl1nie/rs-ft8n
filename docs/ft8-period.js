// FT8 15-second period manager.
// Tracks UTC-aligned periods and fires callbacks at boundaries.
// Supports TX queueing with even/odd slot control.

export class FT8PeriodManager {
  /**
   * @param {Object} callbacks
   * @param {function(number, boolean)} callbacks.onPeriodStart — (periodIndex, isEven) fires at period START
   * @param {function(number, boolean)} callbacks.onPeriodEnd — (periodIndex, isEven) fires at period END
   * @param {function(number)} callbacks.onTick — seconds remaining in current period
   */
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.tickInterval = null;
    this.boundaryTimeout = null;
    this.running = false;

    // TX queue: { call1, call2, report, freq, txEven }
    this.txQueue = null;

    // Estimated PC clock offset relative to real UTC (ms).
    // Positive = Date.now() is ahead of real UTC (clock fast).
    // Updated by app.js from decoded DT statistics each period.
    // Applied to all Date.now() calls so the period timer fires at
    // the correct real-UTC boundary regardless of NTP jumps.
    this.clockOffsetMs = 0;
  }

  /** Returns the estimated real-UTC time in ms (Date.now() minus clock offset). */
  _now() {
    return Date.now() - this.clockOffsetMs;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tickInterval = setInterval(() => this._tick(), 100);
    this._scheduleBoundary();
  }

  stop() {
    this.running = false;
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    if (this.boundaryTimeout) { clearTimeout(this.boundaryTimeout); this.boundaryTimeout = null; }
    this.txQueue = null;
  }

  getCurrentPeriod() {
    const now = this._now();
    const periodIndex = Math.floor(now / 15000);
    const isEven = periodIndex % 2 === 0;
    const periodStartMs = periodIndex * 15000;
    const elapsed = (now - periodStartMs) / 1000;
    const remaining = 15 - elapsed;
    return { periodIndex, isEven, elapsed, remaining };
  }

  /**
   * Queue a TX message for the next appropriate period.
   * @param {Object} tx — { call1, call2, report, freq }
   * @param {boolean|null} txEven — true=TX on even, false=odd, null=next period
   */
  queueTx(tx, txEven) {
    this.txQueue = { ...tx, txEven };
  }

  /** Cancel queued TX. */
  cancelTx() {
    this.txQueue = null;
  }

  /** Check if TX is queued. */
  hasTxQueued() {
    return this.txQueue !== null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  _tick() {
    const { remaining } = this.getCurrentPeriod();
    if (this.callbacks.onTick) {
      this.callbacks.onTick(Math.max(0, remaining));
    }
  }

  _scheduleBoundary() {
    if (!this.running) return;
    const now = this._now();
    const currentPeriod = Math.floor(now / 15000);
    // nextBoundaryMs is in adjusted (real-UTC) time; convert back to wall-clock
    // setTimeout delay so the timer fires at the correct real moment.
    const nextBoundaryMs = (currentPeriod + 1) * 15000;
    const delay = nextBoundaryMs - now;

    this.boundaryTimeout = setTimeout(async () => {
      if (!this.running) return;

      const { periodIndex, isEven } = this.getCurrentPeriod();
      const endedPeriod = periodIndex - 1;
      const endedIsEven = endedPeriod % 2 === 0;

      // Fire period END (await decode to complete before TX check)
      if (this.callbacks.onPeriodEnd) {
        try {
          await this.callbacks.onPeriodEnd(endedPeriod, endedIsEven);
        } catch (e) {
          console.error('Decode error:', e);
        }
      }

      // Fire period START
      if (this.callbacks.onPeriodStart) {
        this.callbacks.onPeriodStart(periodIndex, isEven);
      }

      // Check TX queue — fire if this is the right slot
      if (this.txQueue) {
        const { txEven } = this.txQueue;
        if (txEven === null || txEven === isEven) {
          const tx = this.txQueue;
          this.txQueue = null;
          if (this.callbacks.onTxFire) {
            this.callbacks.onTxFire(tx);
          }
        }
      }

      this._scheduleBoundary();
    }, delay);
  }
}

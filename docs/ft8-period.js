// WSJT slot period manager. Tracks UTC-aligned periods and fires callbacks
// at boundaries. Supports TX queueing with even/odd slot control.
//
// Slot length is configurable: 15 000 ms for FT8, 7 500 ms for FT4.
// Name retained as `FT8PeriodManager` for historical call-sites; an alias
// `SlotPeriodManager` is exported for new code.

export class FT8PeriodManager {
  /**
   * @param {Object} callbacks
   * @param {function(number, boolean)} callbacks.onPeriodStart — (periodIndex, isEven) fires at period START
   * @param {function(number, boolean)} callbacks.onPeriodEnd — (periodIndex, isEven) fires at period END
   * @param {function(number)} callbacks.onTick — seconds remaining in current period
   * @param {number} [slotMs=15000] — period length in milliseconds (15 000 for FT8, 7 500 for FT4)
   */
  constructor(callbacks, slotMs = 15000) {
    this.callbacks = callbacks;
    this.slotMs = slotMs;
    this.slotSec = slotMs / 1000;
    this.tickInterval = null;
    this.boundaryTimeout = null;
    this.running = false;

    // TX queue: { call1, call2, report, freq, txEven }
    this.txQueue = null;
    // Period index when TX was queued — skip firing on the same boundary.
    this._txQueuedPeriod = -1;
  }

  /** Change the slot length on the fly (e.g. switching FT8 ↔ FT4). */
  setSlotMs(slotMs) {
    if (this.slotMs === slotMs) return;
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.slotMs = slotMs;
    this.slotSec = slotMs / 1000;
    if (wasRunning) this.start();
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
    const now = Date.now();
    const periodIndex = Math.floor(now / this.slotMs);
    const isEven = periodIndex % 2 === 0;
    const periodStartMs = periodIndex * this.slotMs;
    const elapsed = (now - periodStartMs) / 1000;
    const remaining = this.slotSec - elapsed;
    return { periodIndex, isEven, elapsed, remaining };
  }

  /**
   * Queue a TX message for the next appropriate period.
   * @param {Object} tx — { call1, call2, report, freq }
   * @param {boolean|null} txEven — true=TX on even, false=odd, null=next period
   */
  queueTx(tx, txEven) {
    this.txQueue = { ...tx, txEven };
    // Remember current period so _scheduleBoundary won't fire TX at the
    // same boundary where it was queued (the slot parity matches the
    // *current* period, which is the one that just started — TX should
    // wait for the *next* matching slot, i.e. the next boundary).
    this._txQueuedPeriod = this.getCurrentPeriod().periodIndex;
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
    const now = Date.now();
    const currentPeriod = Math.floor(now / this.slotMs);
    // Schedule setTimeout so it fires at the next UTC-aligned boundary.
    const nextBoundaryMs = (currentPeriod + 1) * this.slotMs;
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

      // Check TX queue — fire if this is the right slot.
      // Skip if TX was queued during this same boundary's onPeriodEnd
      // callback (the slot parity coincidentally matches the period that
      // just started, but we need to wait for the NEXT matching slot).
      if (this.txQueue) {
        const { txEven } = this.txQueue;
        const slotMatch = txEven === null || txEven === isEven;
        const queuedThisBoundary = this._txQueuedPeriod === periodIndex;
        if (slotMatch && !queuedThisBoundary) {
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

// Backwards-compatible alias for code that imports by the newer name.
export { FT8PeriodManager as SlotPeriodManager };

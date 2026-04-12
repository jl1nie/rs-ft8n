// FT8 15-second period manager.
// Tracks UTC-aligned periods and fires callbacks at boundaries.
// Supports TX queueing with even/odd slot control.
// Supports automatic clock-offset correction via observed DT values.

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
    // Period index when TX was queued — skip firing on the same boundary.
    this._txQueuedPeriod = -1;

    // ── DT auto-correction ──────────────────────────────────────────────────
    // clockOffsetMs: how much to delay the period boundary beyond the raw UTC
    // alignment.  Positive = our clock is fast (ahead) — we fire the boundary
    // later so the capture window slides right and signals appear near DT=0.
    //
    // Estimation: decoded DT values are accumulated each period.  After
    // MIN_SAMPLES are collected the median is used to update the offset.
    // The update is smoothed (EMA) to avoid jumps from spurious outliers.
    this.clockOffsetMs = 0;
    this._nextFireMs = 0;          // absolute ms when next boundary will fire (set by _scheduleBoundary)
    this._dtSamples = [];          // DT values collected this period
    this._dtHistory  = [];         // smoothed estimates, capped at HIST_LEN
    this._MIN_SAMPLES = 1;         // minimum decoded signals per period
    this._HIST_LEN   = 6;          // rolling history length (≈ 90 s)
    this._EMA_ALPHA  = 0.4;        // EMA smoothing factor
    this._dtAutoCorrect = true;    // FT8-signal-based correction enabled by default
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

  /**
   * Feed decoded DT values for clock-offset estimation.
   * Call once per period with the dt_sec of every successfully decoded signal.
   * @param {number[]} dtValues — array of dt_sec from decoded results
   */
  addDtSamples(dtValues) {
    this._dtSamples.push(...dtValues);
  }

  /** Return current clock offset estimate in seconds (positive = clock fast). */
  get clockOffsetSec() {
    return this.clockOffsetMs / 1000;
  }

  /**
   * Directly set the clock offset (e.g. from NTP measurement).
   * Overrides any FT8-signal-based estimate accumulated so far.
   * @param {number} offsetSec — positive = local clock is fast (ahead of UTC)
   */
  setClockOffset(offsetSec) {
    // Clamp to ±10 s (anything larger is likely a measurement error)
    const clamped = Math.max(-10, Math.min(10, offsetSec));
    this.clockOffsetMs = Math.round(clamped * 1000);
    // Discard any samples collected under the old timing — they're stale
    this._dtSamples = [];
    // Seed the FT8-based history so EMA starts from the new offset
    this._dtHistory = Array(this._HIST_LEN).fill(clamped);
    if (this.callbacks.onClockOffset) {
      this.callbacks.onClockOffset(clamped);
    }
  }

  /** Enable or disable FT8-signal-based DT auto-correction. */
  setDtAutoCorrect(enabled) {
    this._dtAutoCorrect = enabled;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  _tick() {
    // Use actual scheduled fire time so countdown reaches 0 exactly when the
    // boundary fires, regardless of clockOffsetMs direction or magnitude.
    const remaining = this._nextFireMs
      ? Math.max(0, (this._nextFireMs - Date.now()) / 1000)
      : Math.max(0, this.getCurrentPeriod().remaining);
    if (this.callbacks.onTick) {
      this.callbacks.onTick(remaining);
    }
  }

  /** Update clock offset from accumulated DT samples, then clear them. */
  _updateClockOffset() {
    const samples = this._dtSamples;
    this._dtSamples = [];
    if (!this._dtAutoCorrect) return;

    if (samples.length < this._MIN_SAMPLES) return;

    // Median DT of this period — robust to outliers from weak/partial decodes
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Clamp: ignore implausible values (> ±5 s are measurement errors)
    if (Math.abs(median) > 5) return;

    // EMA update — smooths period-to-period jitter
    const prev = this._dtHistory.length > 0
      ? this._dtHistory[this._dtHistory.length - 1]
      : median;
    const smoothed = prev + this._EMA_ALPHA * (median - prev);

    this._dtHistory.push(smoothed);
    if (this._dtHistory.length > this._HIST_LEN) {
      this._dtHistory.shift();
    }

    // Use the mean of the recent history as the offset estimate.
    // decoded DT > 0  →  our clock is fast (ahead)  →  clockOffsetMs > 0
    const estimate = this._dtHistory.reduce((a, b) => a + b, 0) / this._dtHistory.length;
    this.clockOffsetMs = Math.round(estimate * 1000);

    if (this.callbacks.onClockOffset) {
      this.callbacks.onClockOffset(estimate);
    }
  }

  _scheduleBoundary() {
    if (!this.running) return;
    const now = Date.now();
    const currentPeriod = Math.floor(now / 15000);
    // Schedule so it fires at the next UTC-aligned 15 s boundary,
    // shifted by clockOffsetMs to compensate for local clock error.
    const nextBoundaryMs = (currentPeriod + 1) * 15000;
    const delay = Math.max(0, nextBoundaryMs - now + this.clockOffsetMs);
    this._nextFireMs = now + delay;  // track actual fire time for accurate countdown

    this.boundaryTimeout = setTimeout(async () => {
      if (!this.running) return;

      const { periodIndex, isEven } = this.getCurrentPeriod();
      const endedPeriod = periodIndex - 1;
      const endedIsEven = endedPeriod % 2 === 0;

      // ── Fire TX FIRST, at the period boundary, before decode ──────────────
      // TX must start within ~2.4 s of the boundary (FT8 signal = 12.64 s;
      // must fit inside the 15 s receive window).  Decode can take 1–3 s,
      // so we fire TX immediately and decode concurrently.
      if (this.txQueue) {
        const { txEven } = this.txQueue;
        const slotMatch = txEven === null || txEven === isEven;
        const queuedThisBoundary = this._txQueuedPeriod === periodIndex;
        if (slotMatch && !queuedThisBoundary) {
          const tx = this.txQueue;
          this.txQueue = null;
          if (this.callbacks.onTxFire) {
            this.callbacks.onTxFire(tx);  // fire-and-forget (async TX)
          }
        }
      }

      // ── Period START callback ─────────────────────────────────────────────
      if (this.callbacks.onPeriodStart) {
        this.callbacks.onPeriodStart(periodIndex, isEven);
      }

      // ── Decode previous period (concurrently with TX) ─────────────────────
      if (this.callbacks.onPeriodEnd) {
        try {
          await this.callbacks.onPeriodEnd(endedPeriod, endedIsEven);
        } catch (e) {
          console.error('Decode error:', e);
        }
      }

      // ── Update clock offset from DT samples collected during decode ────────
      this._updateClockOffset();

      this._scheduleBoundary();
    }, delay);
  }
}

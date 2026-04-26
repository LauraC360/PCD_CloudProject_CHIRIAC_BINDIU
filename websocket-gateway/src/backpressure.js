'use strict';

/**
 * Backpressure module for the WebSocket Gateway.
 *
 * Maintains a sliding-window event counter (1-second window). When the
 * incoming notification rate exceeds 100 events/second, backpressure is
 * activated: a 1-second interval timer coalesces all pending updates into a
 * single flush callback invocation per second.
 *
 * Deactivation: if the rate drops to ≤ 100 for 3 consecutive seconds, the
 * interval timer is cancelled and backpressure is deactivated.
 *
 * Usage:
 *   const bp = createBackpressure();
 *   bp.onFlush((pendingUpdate) => connectionManager.broadcast(...));
 *   bp.record(notificationPayload);
 *   bp.isActive(); // true when throttling
 */
function createBackpressure() {
  // --- state ---
  let backpressureActive = false;

  // Sliding-window counter: number of record() calls in the current 1-second window
  let windowCount = 0;

  // The most recent pending update payload (coalesced — only the latest matters)
  let pendingUpdate = null;

  // Number of consecutive 1-second windows where rate was ≤ 100
  let consecutiveLowSeconds = 0;

  // Interval handle for the 1-second window counter reset
  let windowResetTimer = null;

  // Interval handle for the 1-second flush timer (active only when backpressure is on)
  let flushTimer = null;

  // Registered flush callback
  let flushCallback = null;

  // --- internal helpers ---

  /**
   * Start the 1-second sliding-window counter reset timer.
   * Runs continuously so we always know the current rate.
   */
  function startWindowTimer() {
    if (windowResetTimer !== null) return;

    windowResetTimer = setInterval(() => {
      if (backpressureActive) {
        if (windowCount <= 100) {
          consecutiveLowSeconds += 1;
          if (consecutiveLowSeconds >= 3) {
            deactivate();
          }
        } else {
          // Rate is still high — reset the consecutive-low counter
          consecutiveLowSeconds = 0;
        }
      } else {
        // Not active — check if we should activate
        if (windowCount > 100) {
          activate();
        }
      }

      // Reset the window counter for the next second
      windowCount = 0;
    }, 1000);
  }

  /**
   * Activate backpressure: start the flush interval.
   */
  function activate() {
    backpressureActive = true;
    consecutiveLowSeconds = 0;

    if (flushTimer !== null) return; // already running

    flushTimer = setInterval(() => {
      if (flushCallback !== null && pendingUpdate !== null) {
        flushCallback(pendingUpdate);
      }
    }, 1000);
  }

  /**
   * Deactivate backpressure: cancel the flush interval and reset counters.
   */
  function deactivate() {
    backpressureActive = false;
    consecutiveLowSeconds = 0;

    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  // Start the window timer immediately so the rate is always tracked
  startWindowTimer();

  // --- public API ---

  /**
   * Record an incoming notification event.
   *
   * Increments the sliding-window counter and stores the latest update
   * payload for coalesced flushing when backpressure is active.
   *
   * @param {*} update - The notification payload (most recent wins).
   */
  function record(update) {
    windowCount += 1;
    pendingUpdate = update;
  }

  /**
   * Returns true when backpressure is currently active (rate > 100/s).
   *
   * @returns {boolean}
   */
  function isActive() {
    return backpressureActive;
  }

  /**
   * Register a callback to be invoked on each coalesced flush (once per
   * second while backpressure is active). The callback receives the latest
   * pending update payload.
   *
   * @param {function(*): void} callback
   */
  function onFlush(callback) {
    flushCallback = callback;
  }

  /**
   * Reset all state. Intended for use in tests.
   */
  function reset() {
    backpressureActive = false;
    windowCount = 0;
    pendingUpdate = null;
    consecutiveLowSeconds = 0;

    if (windowResetTimer !== null) {
      clearInterval(windowResetTimer);
      windowResetTimer = null;
    }

    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }

    flushCallback = null;

    // Restart the window timer so the instance remains usable after reset
    startWindowTimer();
  }

  return { record, isActive, onFlush, reset };
}

module.exports = { createBackpressure };

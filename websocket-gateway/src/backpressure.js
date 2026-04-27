'use strict';

/**
 * Backpressure module for the WebSocket Gateway.
 *
 * Tracks the incoming notification rate using a 1-second sliding window.
 * When the rate exceeds 100 events/s, backpressure is activated:
 *   - Pending updates are coalesced into a single consolidated push per second.
 *   - A `setInterval` timer fires the consolidated push at most once per second.
 *
 * Backpressure deactivates automatically when the rate drops to ≤ 100 for
 * 3 consecutive seconds, at which point the interval timer is cancelled.
 *
 * Usage:
 *   const bp = createBackpressure(broadcastFn);
 *   bp.record(update);   // call on every incoming /internal/notify
 *   bp.isActive();       // true when throttling is in effect
 */

const RATE_THRESHOLD = 100;       // events/s that triggers backpressure
const DEACTIVATION_WINDOW = 3;    // consecutive quiet seconds before deactivation
const PUSH_INTERVAL_MS = 1000;    // coalesced push interval when active

/**
 * Creates a backpressure controller.
 *
 * @param {function(object): void} broadcastFn
 *   Called with the latest coalesced update object when the interval fires.
 *   The caller is responsible for querying DynamoDB and constructing the
 *   full stats_update payload before passing it to broadcastFn.
 *
 * @returns {{ record: function(object): void, isActive: function(): boolean, destroy: function(): void }}
 */
function createBackpressure(broadcastFn) {
  // --- sliding-window state ---
  let windowCount = 0;          // events recorded in the current 1-second window
  let windowTimer = null;       // setTimeout handle that resets windowCount each second

  // --- backpressure state ---
  let active = false;
  let consecutiveQuietSeconds = 0;
  let pendingUpdate = null;     // most-recent coalesced update (last-write-wins)
  let pushTimer = null;         // setInterval handle for the coalesced push

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Resets the sliding-window counter every second and evaluates whether
   * backpressure should be deactivated.
   */
  function startWindowTimer() {
    if (windowTimer !== null) return; // already running

    windowTimer = setInterval(() => {
      const count = windowCount;
      windowCount = 0; // reset for the next window

      if (active) {
        if (count <= RATE_THRESHOLD) {
          consecutiveQuietSeconds += 1;
          if (consecutiveQuietSeconds >= DEACTIVATION_WINDOW) {
            deactivate();
          }
        } else {
          // still above threshold — reset the quiet counter
          consecutiveQuietSeconds = 0;
        }
      }
    }, PUSH_INTERVAL_MS);
  }

  /** Activates backpressure and starts the coalesced-push interval. */
  function activate() {
    active = true;
    consecutiveQuietSeconds = 0;
    console.warn(`[backpressure] WARN: backpressure ACTIVATED windowCount=${windowCount} threshold=${RATE_THRESHOLD}`);

    if (pushTimer === null) {
      pushTimer = setInterval(() => {
        if (pendingUpdate !== null) {
          const update = pendingUpdate;
          pendingUpdate = null;
          console.info(`[backpressure] INFO: flushing coalesced update`);
          broadcastFn(update);
        }
      }, PUSH_INTERVAL_MS);
    }
  }

  /** Deactivates backpressure and cancels the coalesced-push interval. */
  function deactivate() {
    active = false;
    consecutiveQuietSeconds = 0;
    console.warn(`[backpressure] WARN: backpressure DEACTIVATED after ${DEACTIVATION_WINDOW} quiet seconds`);

    if (pushTimer !== null) {
      clearInterval(pushTimer);
      pushTimer = null;
    }

    // Flush any remaining pending update immediately on deactivation
    if (pendingUpdate !== null) {
      const update = pendingUpdate;
      pendingUpdate = null;
      console.info(`[backpressure] INFO: flushing pending update on deactivation`);
      broadcastFn(update);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Records an incoming notification event.
   *
   * - Increments the sliding-window counter.
   * - If the counter exceeds the threshold, activates backpressure.
   * - When backpressure is active, stores `update` as the pending coalesced
   *   payload (last-write-wins within the current window).
   * - When backpressure is NOT active, calls `broadcastFn(update)` immediately.
   *
   * @param {object} update - The notification payload to broadcast.
   */
  function record(update) {
    windowCount += 1;

    // Ensure the window-reset timer is running
    startWindowTimer();

    if (!active && windowCount > RATE_THRESHOLD) {
      activate();
    }

    if (active) {
      // Coalesce: keep only the most recent update
      pendingUpdate = update;
    } else {
      broadcastFn(update);
    }
  }

  /**
   * Returns `true` when backpressure is currently active.
   *
   * @returns {boolean}
   */
  function isActive() {
    return active;
  }

  /**
   * Cleans up all timers. Call this when shutting down the gateway to avoid
   * keeping the Node.js event loop alive.
   */
  function destroy() {
    if (windowTimer !== null) {
      clearInterval(windowTimer);
      windowTimer = null;
    }
    if (pushTimer !== null) {
      clearInterval(pushTimer);
      pushTimer = null;
    }
    pendingUpdate = null;
    active = false;
    windowCount = 0;
    consecutiveQuietSeconds = 0;
  }

  return { record, isActive, destroy };
}

module.exports = { createBackpressure };

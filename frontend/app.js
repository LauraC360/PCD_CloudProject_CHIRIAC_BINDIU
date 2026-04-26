/**
 * app.js — WebSocket client for the Realtime Analytics Dashboard
 *
 * Responsibilities:
 *  - Connect to the WebSocket Gateway on page load
 *  - Dispatch incoming messages to dashboard.js and latencyChart.js
 *  - Manage connection status badge in the header
 *  - Implement exponential backoff reconnection (up to 10 attempts)
 */

(function () {
  'use strict';

  // ─── Configuration ────────────────────────────────────────────────────────

  /** WebSocket URL — set by the <script> config block in index.html */
  const WS_URL = window.GATEWAY_WS_URL || 'ws://localhost:8080/ws';

  const RECONNECT_INITIAL_DELAY = 1000; // ms
  const RECONNECT_MULTIPLIER    = 2;
  const RECONNECT_CAP           = 30000; // ms
  const RECONNECT_MAX_ATTEMPTS  = 10;

  // ─── State ────────────────────────────────────────────────────────────────

  let socket          = null;
  let attemptCount    = 0;
  let reconnectTimer  = null;

  // ─── DOM helpers ──────────────────────────────────────────────────────────

  /**
   * Update the connection status badge in the page header.
   *
   * @param {'connecting'|'connected'|'reconnecting'|'lost'} state
   * @param {number} [attempt] - current attempt number (used for 'reconnecting')
   */
  function setConnectionStatus(state, attempt) {
    const dot    = document.getElementById('connection-dot');
    const label  = document.getElementById('connection-status');

    if (!dot || !label) return;

    // Remove all possible colour classes before applying the new one
    dot.classList.remove('bg-gray-500', 'bg-green-400', 'bg-amber-400', 'bg-red-500');

    switch (state) {
      case 'connecting':
        dot.classList.add('bg-gray-500');
        label.textContent = 'Connecting…';
        break;

      case 'connected':
        dot.classList.add('bg-green-400');
        label.textContent = 'Connected';
        break;

      case 'reconnecting':
        dot.classList.add('bg-amber-400');
        label.textContent = `Reconnecting… (attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS})`;
        break;

      case 'lost':
        dot.classList.add('bg-red-500');
        label.textContent = 'Connection lost. Please refresh the page.';
        break;
    }
  }

  // ─── Message handlers ─────────────────────────────────────────────────────

  /**
   * Compute the sum of all viewCount values in the top10 array.
   *
   * @param {Array<{viewCount: number}>} top10
   * @returns {number}
   */
  function sumViewCounts(top10) {
    if (!Array.isArray(top10)) return 0;
    return top10.reduce(function (acc, item) {
      return acc + (Number(item.viewCount) || 0);
    }, 0);
  }

  /**
   * Update the shared stat tiles (#last-update, #total-views) that are
   * common to both initial_state and stats_update messages.
   *
   * @param {object} msg - parsed WebSocket message
   */
  function updateStatTiles(msg) {
    const lastUpdateEl = document.getElementById('last-update');
    const totalViewsEl = document.getElementById('total-views');

    if (lastUpdateEl) {
      // Prefer deliveredAt; fall back to publishedAt if absent (initial_state has no publishedAt)
      const ts = msg.deliveredAt || msg.publishedAt;
      if (ts) {
        lastUpdateEl.textContent = new Date(ts).toLocaleTimeString();
      }
    }

    if (totalViewsEl) {
      totalViewsEl.textContent = sumViewCounts(msg.top10).toLocaleString();
    }
  }

  /**
   * Handle an `initial_state` message from the Gateway.
   * Performs a full dashboard refresh; no latency sample (no publishedAt).
   *
   * @param {object} msg
   */
  function handleInitialState(msg) {
    if (typeof window.dashboard?.renderTop10 === 'function') {
      window.dashboard.renderTop10(msg.top10);
    }

    if (typeof window.dashboard?.renderConnectedClients === 'function') {
      window.dashboard.renderConnectedClients(msg.connectedClients);
    }

    updateStatTiles(msg);
  }

  /**
   * Handle a `stats_update` message from the Gateway.
   * Updates the dashboard and records a latency sample for the chart.
   *
   * @param {object} msg
   */
  function handleStatsUpdate(msg) {
    if (typeof window.dashboard?.renderTop10 === 'function') {
      window.dashboard.renderTop10(msg.top10);
    }

    if (typeof window.dashboard?.renderConnectedClients === 'function') {
      window.dashboard.renderConnectedClients(msg.connectedClients);
    }

    if (typeof window.dashboard?.renderActivityFeed === 'function') {
      window.dashboard.renderActivityFeed(msg);
    }

    // Record latency sample only when both timestamps are present
    if (msg.publishedAt && msg.deliveredAt) {
      if (typeof window.latencyChart?.addSample === 'function') {
        window.latencyChart.addSample(msg.publishedAt, msg.deliveredAt);
      }

      const chartCanvas = document.getElementById('latency-chart');
      if (chartCanvas && typeof window.latencyChart?.renderChart === 'function') {
        window.latencyChart.renderChart(chartCanvas);
      }
    }

    updateStatTiles(msg);
  }

  /**
   * Route a raw WebSocket message to the appropriate handler.
   * Malformed JSON is logged and silently ignored.
   *
   * @param {MessageEvent} event
   */
  function onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      console.error('[app.js] Failed to parse WebSocket message:', err, event.data);
      return;
    }

    switch (msg.type) {
      case 'initial_state':
        handleInitialState(msg);
        break;

      case 'stats_update':
        handleStatsUpdate(msg);
        break;

      default:
        console.warn('[app.js] Unknown message type:', msg.type);
    }
  }

  // ─── Reconnection logic ───────────────────────────────────────────────────

  /**
   * Calculate the next reconnect delay using exponential backoff.
   *
   * delay = min(initialDelay * multiplier^attempt, cap)
   *
   * @param {number} attempt - zero-based attempt index
   * @returns {number} delay in milliseconds
   */
  function calcDelay(attempt) {
    return Math.min(
      RECONNECT_INITIAL_DELAY * Math.pow(RECONNECT_MULTIPLIER, attempt),
      RECONNECT_CAP
    );
  }

  /**
   * Schedule a reconnection attempt after the appropriate backoff delay.
   * Stops scheduling once RECONNECT_MAX_ATTEMPTS is reached.
   */
  function scheduleReconnect() {
    // Clear any pending timer to avoid double-scheduling
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (attemptCount >= RECONNECT_MAX_ATTEMPTS) {
      setConnectionStatus('lost');
      console.error('[app.js] Max reconnection attempts reached. Giving up.');
      return;
    }

    const delay = calcDelay(attemptCount);
    attemptCount += 1;

    setConnectionStatus('reconnecting', attemptCount);
    console.info(`[app.js] Reconnecting in ${delay}ms (attempt ${attemptCount}/${RECONNECT_MAX_ATTEMPTS})`);

    reconnectTimer = setTimeout(connect, delay);
  }

  // ─── WebSocket lifecycle ──────────────────────────────────────────────────

  /**
   * Open a new WebSocket connection to the Gateway.
   * Called on page load and on each reconnect attempt.
   */
  function connect() {
    reconnectTimer = null;

    // Close any stale socket before opening a new one
    if (socket !== null) {
      socket.onopen  = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      socket = null;
    }

    setConnectionStatus('connecting');
    console.info('[app.js] Connecting to', WS_URL);

    socket = new WebSocket(WS_URL);

    socket.onopen = function () {
      console.info('[app.js] Connected');
      attemptCount = 0; // reset backoff counter on successful connection
      setConnectionStatus('connected');
    };

    socket.onmessage = onMessage;

    socket.onclose = function (event) {
      console.warn('[app.js] Connection closed:', event.code, event.reason);
      scheduleReconnect();
    };

    socket.onerror = function (err) {
      // onerror is always followed by onclose; log here, reconnect in onclose
      console.error('[app.js] WebSocket error:', err);
    };
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  // Connect as soon as the DOM is ready (scripts are deferred to end of <body>
  // so the DOM is already parsed when this runs, but we guard anyway).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connect);
  } else {
    connect();
  }
}());

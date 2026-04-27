// app.js — WebSocket client for the Realtime Analytics Dashboard

(function () {
  'use strict';

  // config

  // websocket url
  const WS_URL = window.GATEWAY_WS_URL || 'ws://localhost:8080/ws';

  const RECONNECT_INITIAL_DELAY = 1000; // ms
  const RECONNECT_MULTIPLIER    = 2;
  const RECONNECT_CAP           = 30000; // ms
  const RECONNECT_MAX_ATTEMPTS  = 10;
 
  // state

  let socket          = null;
  let attemptCount    = 0;
  let reconnectTimer  = null;

  // update connection status badge
  function setConnectionStatus(state, attempt) {
    const dot    = document.getElementById('connection-dot');
    const label  = document.getElementById('connection-status');

    if (!dot || !label) return;
    
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

  // message handler
  function sumViewCounts(top10) {
    if (!Array.isArray(top10)) return 0;
    return top10.reduce(function (acc, item) {
      return acc + (Number(item.viewCount) || 0);
    }, 0);
  }

  // update stat titles
  function updateStatTiles(msg) {
    const lastUpdateEl = document.getElementById('last-update');
    const totalViewsEl = document.getElementById('total-views');

    if (lastUpdateEl) {
      const ts = msg.deliveredAt || msg.publishedAt;
      if (ts) {
        lastUpdateEl.textContent = new Date(ts).toLocaleTimeString();
      }
    }

    if (totalViewsEl) {
      totalViewsEl.textContent = sumViewCounts(msg.top10).toLocaleString();
    }
  }

  // handling initial state message from gateway
  function handleInitialState(msg) {
    if (typeof window.dashboard?.renderTop10 === 'function') {
      window.dashboard.renderTop10(msg.top10);
    }

    if (typeof window.dashboard?.renderConnectedClients === 'function') {
      window.dashboard.renderConnectedClients(msg.connectedClients);
    }

    updateStatTiles(msg);
  }

  // handling stats update from gateway
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

    // record latency sample only when both timestamps are present
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

  // jsonify message
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
        console.info('[app.js] INFO: initial_state received connectedClients=' + msg.connectedClients);
        handleInitialState(msg);
        break;

      case 'stats_update':
        console.info('[app.js] INFO: stats_update received connectedClients=' + msg.connectedClients);
        handleStatsUpdate(msg);
        break;

      case 'connected_clients_update':
        // Only updates the connected users counter — does NOT touch top10 or activity feed
        console.info('[app.js] INFO: connected_clients_update received connectedClients=' + msg.connectedClients);
        if (typeof window.dashboard?.renderConnectedClients === 'function') {
          window.dashboard.renderConnectedClients(msg.connectedClients);
        }
        break;

      default:
        console.warn('[app.js] WARN: unknown message type:', msg.type);
    }
  }

  // reconnection logic
  function calcDelay(attempt) {
    return Math.min(
      RECONNECT_INITIAL_DELAY * Math.pow(RECONNECT_MULTIPLIER, attempt),
      RECONNECT_CAP
    );
  }

  function scheduleReconnect() {
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

  // websocket connection handling
  function connect() {
    reconnectTimer = null;

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
      attemptCount = 0; // reset counter on successful connection
      setConnectionStatus('connected');
    };

    socket.onmessage = onMessage;

    socket.onclose = function (event) {
      console.warn('[app.js] Connection closed:', event.code, event.reason);
      scheduleReconnect();
    };

    socket.onerror = function (err) {
      // onerror is always followed by onclose
      console.error('[app.js] WebSocket error:', err);
    };
  }

  // entry point
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connect);
  } else {
    connect();
  }
}());
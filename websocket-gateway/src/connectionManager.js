'use strict';

const WebSocket = require('ws');

/**
 * ConnectionManager wraps the native `wss.clients` Set from the `ws` library,
 * providing broadcast and connection count utilities.
 *
 * Usage:
 *   const manager = createConnectionManager(wss);
 *   manager.broadcast(JSON.stringify({ type: 'stats_update', ... }));
 *   manager.getCount(); // number of open connections
 */
function createConnectionManager(wss) {
  /**
   * Broadcast a message string to all currently open WebSocket clients.
   * Clients whose readyState is not OPEN are silently skipped.
   *
   * @param {string} message - Serialised message to send (typically JSON).
   */
  function broadcast(message) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  /**
   * Returns the total number of clients tracked by the ws server,
   * regardless of their readyState.
   *
   * @returns {number}
   */
  function getCount() {
    return wss.clients.size;
  }

  return { broadcast, getCount };
}

module.exports = { createConnectionManager };

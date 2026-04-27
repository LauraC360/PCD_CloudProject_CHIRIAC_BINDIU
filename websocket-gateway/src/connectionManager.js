'use strict';

const WebSocket = require('ws');

// ConnectionManager wraps the native provides broadcast and connection count utilities
function createConnectionManager(wss) {
  // broadcast message to all sockets
  function broadcast(message) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // Returns the total number of clients tracked by the ws server
  function getCount() {
    return wss.clients.size;
  }

  return { broadcast, getCount };
}

module.exports = { createConnectionManager };
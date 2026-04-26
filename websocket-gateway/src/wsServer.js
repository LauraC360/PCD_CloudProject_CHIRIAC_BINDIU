'use strict';

const WebSocket = require('ws');
const { createConnectionManager } = require('./connectionManager');
const { queryTop10 } = require('./statsQuery');

// Builds a stats_update message payload for broadcasting connectedClients changes
// Used on connect and on disconnect.
function buildConnectedClientsUpdate(connectedClients) {
  return JSON.stringify({
    type: 'stats_update',
    deliveredAt: new Date().toISOString(),
    connectedClients,
    top10: [],
  });
}

// create ws server and lifecycle
function createWsServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
  const connectionManager = createConnectionManager(wss);

  wss.on('connection', async (ws) => {
    const total = connectionManager.getCount();
    console.log(`INFO: client connected, total: ${total}`);

    // Query top-10 from DynamoDB; fall back to empty array on error.
    let top10 = [];
    try {
      top10 = await queryTop10();
    } catch (err) {
      console.error('ERROR: queryTop10 failed on connection:', err);
    }

    // Send initial_state to the newly connected client only.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'initial_state',
          deliveredAt: new Date().toISOString(),
          connectedClients: total,
          top10,
        })
      );
    }

    // Broadcast updated connectedClients count to all OTHER clients
    const countUpdate = buildConnectedClientsUpdate(total);
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(countUpdate);
      }
    });

    // handles client disconnect
    function onDisconnect(reason) {
      console.log(`INFO: client ${reason}, total: ${connectionManager.getCount()}`);
      connectionManager.broadcast(buildConnectedClientsUpdate(connectionManager.getCount()));
    }

    ws.on('close', () => onDisconnect('close'));
    ws.on('error', (err) => {
      console.error('WARN: client error:', err);
      onDisconnect('error');
    });
  });

  return { wss, connectionManager };
}

module.exports = { createWsServer };

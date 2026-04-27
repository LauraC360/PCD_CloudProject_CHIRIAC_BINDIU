'use strict';

const WebSocket = require('ws');
const { createConnectionManager } = require('./connectionManager');
const { queryTop10 } = require('./statsQuery');

// Builds a connected_clients_update payload — used on connect/disconnect
// to notify other clients of the new count WITHOUT touching top10.
function buildConnectedClientsUpdate(connectedClients) {
  return JSON.stringify({
    type: 'connected_clients_update',
    deliveredAt: new Date().toISOString(),
    connectedClients,
  });
}

// create ws server and lifecycle
function createWsServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
  const connectionManager = createConnectionManager(wss);

  wss.on('connection', async (ws) => {
    const total = connectionManager.getCount();
    console.info(`[wsServer] INFO: client connected connectedClients=${total}`);

    // Query top-10 from DynamoDB; fall back to empty array on error.
    let top10 = [];
    try {
      console.info(`[wsServer] INFO: querying top10 for initial_state connectedClients=${total}`);
      top10 = await queryTop10();
      console.info(`[wsServer] INFO: top10 query ok count=${top10.length}`);
    } catch (err) {
      console.error(`[wsServer] ERROR: queryTop10 failed on connection message=${err.message}`);
    }

    // Send initial_state to the newly connected client only.
    if (ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        type: 'initial_state',
        deliveredAt: new Date().toISOString(),
        connectedClients: total,
        top10,
      });
      ws.send(payload);
      console.info(`[wsServer] INFO: initial_state sent connectedClients=${total} top10Count=${top10.length}`);
    } else {
      console.warn(`[wsServer] WARN: client disconnected before initial_state could be sent readyState=${ws.readyState}`);
    }

    // Broadcast updated connectedClients count to all OTHER clients
    const countUpdate = buildConnectedClientsUpdate(total);
    let broadcastCount = 0;
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(countUpdate);
        broadcastCount++;
      }
    });
    console.info(`[wsServer] INFO: connectedClients update broadcast to otherClients=${broadcastCount}`);

    // handles client disconnect
    function onDisconnect(reason) {
      const remaining = connectionManager.getCount();
      console.info(`[wsServer] INFO: client disconnected reason=${reason} connectedClients=${remaining}`);
      connectionManager.broadcast(buildConnectedClientsUpdate(remaining));
    }

    ws.on('close', () => onDisconnect('close'));
    ws.on('error', (err) => {
      console.error(`[wsServer] ERROR: client socket error message=${err.message}`);
      onDisconnect('error');
    });
  });

  return { wss, connectionManager };
}

module.exports = { createWsServer };

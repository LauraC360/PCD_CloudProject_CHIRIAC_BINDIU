'use strict';

const http = require('http');
const { createWsServer } = require('./wsServer');
const { createBackpressure } = require('./backpressure');
const { createHttpServer } = require('./httpServer');
const { queryTop10 } = require('./statsQuery');

const PORT = parseInt(process.env.PORT || '8080', 10);
const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT || '8081', 10);

// WebSocket server (port PORT, default 8080)
// The raw http.createServer handles both WS upgrades AND a /health GET
const wsHttpServer = http.createServer((req, res) => {
  // Health check endpoint on port 8080 for ALB
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      connectedClients: connectionManager ? connectionManager.getCount() : 0,
      backpressureActive: backpressure ? backpressure.isActive() : false,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }
  // All other non-WS HTTP requests get 404
  res.writeHead(404);
  res.end();
});

const { connectionManager } = createWsServer(wsHttpServer);

// Backpressure — wired to connectionManager.broadcast
const backpressure = createBackpressure(connectionManager.broadcast);

// Internal HTTP server (port INTERNAL_PORT, default 8081)
const app = createHttpServer({ connectionManager, backpressure, queryTop10 });
const internalHttpServer = http.createServer(app);


// Start both servers
wsHttpServer.listen(PORT, () => {
  console.log(`INFO: WebSocket server listening on port ${PORT} (path /ws)`);
});

internalHttpServer.listen(INTERNAL_PORT, () => {
  console.log(`INFO: Internal HTTP server listening on port ${INTERNAL_PORT}`);
});


// Graceful shutdown
function shutdown(signal) {
  console.log(`INFO: received ${signal}, shutting down gracefully`);

  backpressure.destroy();

  wsHttpServer.close(() => {
    console.log('INFO: WebSocket server closed');
  });

  internalHttpServer.close(() => {
    console.log('INFO: Internal HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 s if servers haven't closed cleanly
  setTimeout(() => {
    console.error('ERROR: forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

'use strict';

// Placeholder HTTP server — responds 200 to /health so the ALB health check
// passes while the real gateway image is being built and pushed.
// Replace this by pushing the real websocket-gateway image to ECR.

const http = require('http');

const PORT = parseInt(process.env.PORT || '8080', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'placeholder', connectedClients: 0, backpressureActive: false }));
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'placeholder image — real gateway not deployed yet' }));
  }
});

server.listen(PORT, () => {
  console.log(`INFO: placeholder server listening on port ${PORT}`);
});

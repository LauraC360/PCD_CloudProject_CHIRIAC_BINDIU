'use strict';

// Placeholder HTTP server — responds 200 to /health so App Runner health check
// passes while the real Service A image is being built and pushed.
// Replace this by pushing the real service-a image to ECR.

const http = require('http');

const PORT = parseInt(process.env.APP_PORT || '3000', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'placeholder' }));
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'placeholder image - real service-a not deployed yet' }));
  }
});

server.listen(PORT, () => {
  console.log(`INFO: placeholder server listening on port ${PORT}`);
});

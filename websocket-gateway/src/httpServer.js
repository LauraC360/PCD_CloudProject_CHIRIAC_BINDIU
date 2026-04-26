'use strict';

const express = require('express');

function createHttpServer({ connectionManager, backpressure, queryTop10 }) {
  const app = express();

  app.use(express.json());

  // GET /health
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      connectedClients: connectionManager.getCount(),
      backpressureActive: backpressure.isActive(),
    });
  });

  // POST /internal/notify
  app.post('/internal/notify', async (req, res) => {
    const { movieId, viewCount, publishedAt } = req.body || {};

    // Validate required fields
    if (
      typeof movieId !== 'string' || movieId.trim() === '' ||
      viewCount === undefined || viewCount === null ||
      typeof publishedAt !== 'string' || publishedAt.trim() === ''
    ) {
      console.warn('[httpServer] Invalid /internal/notify payload:', req.body);
      return res.status(400).json({
        error: 'Invalid payload: movieId, viewCount, and publishedAt are required',
      });
    }

    // Query DynamoDB for the current top 10 to include in the broadcast
    // This runs on every notify call; when backpressure is active the result
    let top10 = [];
    try {
      top10 = await queryTop10();
    } catch (err) {
      console.error('[httpServer] DynamoDB queryTop10 failed:', err.message);
    }

    const deliveredAt = new Date().toISOString();

    // Warn if end-to-end latency exceeds 2 seconds
    const latencyMs = Date.parse(deliveredAt) - Date.parse(publishedAt);
    if (latencyMs > 2000) {
      console.warn(
        `[httpServer] High end-to-end latency: ${latencyMs}ms for movieId=${movieId}`,
      );
    }

    const statsUpdate = JSON.stringify({
      type: 'stats_update',
      publishedAt,
      deliveredAt,
      connectedClients: connectionManager.getCount(),
      top10,
    });

    // backpressure.record() either calls broadcastFn(statsUpdate) immediately
    // (not throttled) or coalesces it for the next 1-second interval push
    backpressure.record(statsUpdate);

    res.status(200).json({ ok: true });
  });

  return app;
}

module.exports = { createHttpServer };

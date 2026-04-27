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

    console.info(
      `[httpServer] INFO: /internal/notify received movieId=${movieId} viewCount=${viewCount} publishedAt=${publishedAt}`
    );

    // Validate required fields
    if (
      typeof movieId !== 'string' || movieId.trim() === '' ||
      viewCount === undefined || viewCount === null ||
      typeof publishedAt !== 'string' || publishedAt.trim() === ''
    ) {
      console.warn('[httpServer] WARN: invalid /internal/notify payload — rejecting 400:', JSON.stringify(req.body));
      return res.status(400).json({
        error: 'Invalid payload: movieId, viewCount, and publishedAt are required',
      });
    }

    // Query DynamoDB for the current top 10 to include in the broadcast
    let top10 = [];
    try {
      console.info(`[httpServer] INFO: querying top10 for broadcast movieId=${movieId}`);
      top10 = await queryTop10();
      console.info(`[httpServer] INFO: top10 query ok count=${top10.length}`);
    } catch (err) {
      console.error(`[httpServer] ERROR: DynamoDB queryTop10 failed movieId=${movieId} message=${err.message}`);
    }

    const deliveredAt = new Date().toISOString();

    // Warn if end-to-end latency exceeds 2 seconds
    const latencyMs = Date.parse(deliveredAt) - Date.parse(publishedAt);
    console.info(
      `[httpServer] INFO: latency computed movieId=${movieId} latencyMs=${latencyMs} publishedAt=${publishedAt} deliveredAt=${deliveredAt}`
    );
    if (latencyMs > 2000) {
      console.warn(
        `[httpServer] WARN: high end-to-end latency latencyMs=${latencyMs} movieId=${movieId}`
      );
    }

    const statsUpdate = JSON.stringify({
      type: 'stats_update',
      publishedAt,
      deliveredAt,
      connectedClients: connectionManager.getCount(),
      top10,
    });

    console.info(
      `[httpServer] INFO: broadcasting stats_update movieId=${movieId} connectedClients=${connectionManager.getCount()} top10Count=${top10.length} backpressureActive=${backpressure.isActive()}`
    );

    backpressure.record(statsUpdate);

    res.status(200).json({ ok: true });
    console.info(`[httpServer] INFO: /internal/notify handled ok movieId=${movieId}`);
  });

  return app;
}

module.exports = { createHttpServer };

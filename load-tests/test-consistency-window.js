'use strict';

/**
 * Test 1 — Consistency Window Measurement
 *
 * Adapted from assignment section 4.4 (Part 1).
 * Measures how long it takes from GET /movies/:id (which publishes a View_Event
 * to SQS) until the stats_update arrives over WebSocket.
 *
 * Runs 5 iterations, reports per-run latency and average consistency window.
 */

const WebSocket = require('ws');
const config = require('./config');
const { getMovie, sleep, writeResult } = require('./helpers');

const RUNS = 5;
const WS_TIMEOUT_MS = 30_000; // max wait per run

async function waitForStatsUpdate(movieId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${config.WS_GATEWAY_URL}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout: no stats_update for ${movieId} within ${WS_TIMEOUT_MS}ms`));
    }, WS_TIMEOUT_MS);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Accept initial_state (contains top10 which may already include our movie)
        // but we specifically wait for a stats_update that arrives AFTER our request.
        if (msg.type === 'stats_update') {
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Test 1: Consistency Window Measurement');
  console.log('═══════════════════════════════════════════════════\n');

  const results = [];

  for (let i = 0; i < RUNS; i++) {
    const movieId = config.MOVIE_IDS[i % config.MOVIE_IDS.length];
    console.log(`Run ${i + 1}/${RUNS}: movieId=${movieId}`);

    // Start listening BEFORE the GET so we don't miss the update
    const wsPromise = waitForStatsUpdate(movieId);

    // Small delay to let WS connect
    await sleep(500);

    const start = Date.now();
    const { status, latencyMs: httpLatency } = await getMovie(movieId);
    console.log(`  GET /movies/${movieId} → ${status} (${httpLatency}ms)`);

    if (status !== 200) {
      console.log(`  ⚠ Skipping — HTTP ${status}`);
      continue;
    }

    try {
      const msg = await wsPromise;
      const consistencyMs = Date.now() - start;
      const e2eFromPublished = msg.deliveredAt && msg.publishedAt
        ? Date.parse(msg.deliveredAt) - Date.parse(msg.publishedAt)
        : null;

      results.push({ run: i + 1, consistencyMs, httpLatency, e2eFromPublished });
      console.log(`  ✓ stats_update received after ${consistencyMs}ms (e2e: ${e2eFromPublished ?? '?'}ms)\n`);
    } catch (err) {
      console.log(`  ✗ ${err.message}\n`);
      results.push({ run: i + 1, consistencyMs: null, httpLatency, error: err.message });
    }

    // Brief pause between runs
    await sleep(2000);
  }

  // Summary
  console.log('─── Summary ───');
  const successful = results.filter((r) => r.consistencyMs !== null);
  if (successful.length > 0) {
    const windows = successful.map((r) => r.consistencyMs);
    const avg = Math.round(windows.reduce((a, b) => a + b, 0) / windows.length);
    const min = Math.min(...windows);
    const max = Math.max(...windows);
    console.log(`Successful runs: ${successful.length}/${RUNS}`);
    console.log(`Consistency window: avg=${avg}ms, min=${min}ms, max=${max}ms`);
    console.log(`\nFactors affecting variability:`);
    console.log(`  - SQS delivery latency`);
    console.log(`  - Lambda cold start (if scaled to 0)`);
    console.log(`  - DynamoDB write latency`);
    console.log(`  - HTTP POST from Lambda → WebSocket Gateway`);
    console.log(`  - WebSocket broadcast latency`);
  } else {
    console.log('No successful runs — check service URLs and connectivity.');
  }

  console.log('\nRaw results:', JSON.stringify(results, null, 2));
  writeResult('consistency-window', {
    runs: RUNS,
    results,
    summary: successful.length > 0 ? {
      successfulRuns: successful.length,
      avgMs: Math.round(successful.map(r => r.consistencyMs).reduce((a, b) => a + b, 0) / successful.length),
      minMs: Math.min(...successful.map(r => r.consistencyMs)),
      maxMs: Math.max(...successful.map(r => r.consistencyMs)),
    } : null,
  });
  return results;
}

run().catch(console.error);

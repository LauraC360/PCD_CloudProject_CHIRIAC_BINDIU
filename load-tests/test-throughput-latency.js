'use strict';

/**
 * Test 3 — Throughput & Latency Under Variable Load
 *
 * From assignment: "Performanta si scalabilitate — rezultate ale testelor de
 * incarcare (grafice cu latenta, throughput), identificarea bottleneck-urilor"
 *
 * Ramps through increasing concurrency levels, measuring:
 *   - HTTP response latency (p50, p95, p99)
 *   - Throughput (requests/second)
 *   - Error rate
 *   - End-to-end latency via WebSocket (publishedAt → deliveredAt)
 */

const WebSocket = require('ws');
const config = require('./config');
const { getMovie, computeStats, sleep, writeResult } = require('./helpers');

// Concurrency levels to test
const LEVELS = [1, 5, 10, 20, 50];
const REQUESTS_PER_LEVEL = 50;

async function runLevel(concurrency) {
  const latencies = [];
  let errors = 0;
  let completed = 0;

  const start = Date.now();

  async function worker() {
    while (completed + errors < REQUESTS_PER_LEVEL) {
      const movieId = config.MOVIE_IDS[Math.floor(Math.random() * config.MOVIE_IDS.length)];
      try {
        const { status, latencyMs } = await getMovie(movieId);
        if (status === 200) {
          latencies.push(latencyMs);
          completed++;
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
  }

  // Launch workers
  const workers = Array.from({ length: Math.min(concurrency, REQUESTS_PER_LEVEL) }, () => worker());
  await Promise.all(workers);

  const durationMs = Date.now() - start;
  const throughput = ((completed / durationMs) * 1000).toFixed(2);
  const stats = computeStats(latencies);

  return {
    concurrency,
    totalRequests: REQUESTS_PER_LEVEL,
    completed,
    errors,
    durationMs,
    throughputRps: parseFloat(throughput),
    errorRate: `${((errors / REQUESTS_PER_LEVEL) * 100).toFixed(1)}%`,
    latency: stats,
  };
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Test 3: Throughput & Latency Under Variable Load');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`Requests per level: ${REQUESTS_PER_LEVEL}`);
  console.log(`Concurrency levels: ${LEVELS.join(', ')}\n`);

  // Also collect end-to-end latencies from WebSocket
  const e2eLatencies = [];
  let ws;
  try {
    ws = new WebSocket(`${config.WS_GATEWAY_URL}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS connect timeout')), 5000);
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'stats_update' && msg.publishedAt && msg.deliveredAt) {
          const e2e = Date.parse(msg.deliveredAt) - Date.parse(msg.publishedAt);
          if (e2e > 0) e2eLatencies.push(e2e);
        }
      } catch { /* ignore */ }
    });
  } catch (err) {
    console.log(`⚠ WebSocket not available (${err.message}) — skipping e2e latency collection\n`);
    ws = null;
  }

  const results = [];

  for (const level of LEVELS) {
    console.log(`── Concurrency: ${level} ──`);
    const result = await runLevel(level);
    results.push(result);

    console.log(`  Completed: ${result.completed}/${result.totalRequests} (errors: ${result.errors})`);
    console.log(`  Duration: ${result.durationMs}ms`);
    console.log(`  Throughput: ${result.throughputRps} req/s`);
    console.log(`  Latency: p50=${result.latency.p50}ms p95=${result.latency.p95}ms p99=${result.latency.p99}ms`);
    console.log(`  Error rate: ${result.errorRate}\n`);

    // Brief cooldown between levels
    await sleep(3000);
  }

  if (ws) ws.close();

  // Summary table
  console.log('─── Summary Table ───');
  console.log('Concurrency | Throughput | p50    | p95    | p99    | Errors');
  console.log('------------|------------|--------|--------|--------|-------');
  for (const r of results) {
    console.log(
      `${String(r.concurrency).padStart(11)} | ` +
      `${String(r.throughputRps).padStart(8)} r/s | ` +
      `${String(r.latency.p50).padStart(5)}ms | ` +
      `${String(r.latency.p95).padStart(5)}ms | ` +
      `${String(r.latency.p99).padStart(5)}ms | ` +
      `${r.errorRate}`
    );
  }

  // E2E latency from WebSocket
  if (e2eLatencies.length > 0) {
    const e2eStats = computeStats(e2eLatencies);
    console.log(`\n─── End-to-End Latency (via WebSocket) ───`);
    console.log(`Samples: ${e2eStats.count}`);
    console.log(`p50=${e2eStats.p50}ms  p95=${e2eStats.p95}ms  p99=${e2eStats.p99}ms`);
    console.log(`min=${e2eStats.min}ms  max=${e2eStats.max}ms  avg=${e2eStats.avg}ms`);
  }

  console.log('\nRaw results:', JSON.stringify(results, null, 2));

  const e2eStats = e2eLatencies.length > 0 ? computeStats(e2eLatencies) : null;
  writeResult('throughput-latency', {
    requestsPerLevel: REQUESTS_PER_LEVEL,
    levels: results,
    e2eLatency: e2eStats,
  });

  return results;
}

run().catch(console.error);

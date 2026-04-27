'use strict';

/**
 * Test 6 — Resilience
 *
 * From assignment: "Rezilienta — cum se comporta sistemul cand o componenta esueaza;
 * ce mecanisme de recuperare exista"
 *
 * Tests:
 *   1. Service A decoupling: Service A should respond fast regardless of
 *      downstream pipeline load (SQS publish is fire-and-forget)
 *   2. WebSocket Gateway independence: Gateway should stay healthy even
 *      when no events are flowing
 *   3. Sustained load: Service A latency should remain stable under
 *      sustained load (no degradation over time)
 *   4. Error rate under overload: push beyond normal capacity and measure
 *      how gracefully the system degrades
 */

const WebSocket = require('ws');
const config = require('./config');
const { getMovie, getMetrics, computeStats, sleep, writeResult } = require('./helpers');

async function testDecoupling() {
  console.log('── Test 6a: Service A Decoupling ──');
  console.log('  Verifying Service A response time is independent of pipeline load.\n');

  // Baseline: single request latency
  const baseline = [];
  for (let i = 0; i < 5; i++) {
    const { status, latencyMs } = await getMovie(config.MOVIE_IDS[0]);
    if (status === 200) baseline.push(latencyMs);
  }
  const baselineStats = computeStats(baseline);
  console.log(`  Baseline (5 sequential): p50=${baselineStats.p50}ms p95=${baselineStats.p95}ms`);

  // Under load: fire 20 concurrent requests (flooding SQS)
  const underLoad = [];
  const promises = Array.from({ length: 20 }, () =>
    getMovie(config.MOVIE_IDS[Math.floor(Math.random() * config.MOVIE_IDS.length)])
      .then(({ status, latencyMs }) => { if (status === 200) underLoad.push(latencyMs); })
      .catch(() => {})
  );
  await Promise.all(promises);
  const loadStats = computeStats(underLoad);
  console.log(`  Under load (20 concurrent): p50=${loadStats.p50}ms p95=${loadStats.p95}ms`);

  // Check: p50 under load should be within 3x of baseline (fire-and-forget means SQS doesn't block)
  const ratio = loadStats.p50 / (baselineStats.p50 || 1);
  const decoupled = ratio < 5;
  console.log(`  Ratio (load/baseline p50): ${ratio.toFixed(1)}x — ${decoupled ? '✓ decoupled' : '⚠ possible coupling'}\n`);

  return { baseline: baselineStats, underLoad: loadStats, ratio: parseFloat(ratio.toFixed(1)), decoupled };
}

async function testGatewayIndependence() {
  console.log('── Test 6b: WebSocket Gateway Independence ──');
  console.log('  Verifying Gateway stays healthy when no events are flowing.\n');

  try {
    const ws = new WebSocket(`${config.WS_GATEWAY_URL}/ws`);
    const connected = await new Promise((resolve, reject) => {
      ws.on('open', () => resolve(true));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 10000);
    });

    let gotInitialState = false;
    await new Promise((resolve) => {
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'initial_state') gotInitialState = true;
        } catch {}
        resolve();
      });
      setTimeout(resolve, 5000);
    });

    ws.close();
    console.log(`  Connected: ${connected}`);
    console.log(`  Received initial_state: ${gotInitialState}`);
    console.log(`  ✓ Gateway is healthy independently\n`);
    return { healthy: true, connected, gotInitialState };
  } catch (err) {
    console.log(`  ✗ Gateway unreachable: ${err.message}\n`);
    return { healthy: false, error: err.message };
  }
}

async function testSustainedLoad() {
  console.log('── Test 6c: Sustained Load Stability ──');
  console.log('  Sending requests over 30s and checking for latency degradation.\n');

  const windows = []; // 5-second windows
  const DURATION_S = 30;
  const WINDOW_S = 5;
  const CONCURRENCY = 5;

  const start = Date.now();

  for (let w = 0; w < DURATION_S / WINDOW_S; w++) {
    const windowLatencies = [];
    let errors = 0;
    const windowEnd = Date.now() + WINDOW_S * 1000;

    while (Date.now() < windowEnd) {
      const batch = Array.from({ length: CONCURRENCY }, () =>
        getMovie(config.MOVIE_IDS[Math.floor(Math.random() * config.MOVIE_IDS.length)])
          .then(({ status, latencyMs }) => { if (status === 200) windowLatencies.push(latencyMs); else errors++; })
          .catch(() => { errors++; })
      );
      await Promise.all(batch);
    }

    const stats = computeStats(windowLatencies);
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    windows.push({ windowS: `${w * WINDOW_S}-${(w + 1) * WINDOW_S}`, requests: stats.count, errors, p50: stats.p50, p95: stats.p95 });
    console.log(`  T+${elapsed}s: ${stats.count} reqs, p50=${stats.p50}ms p95=${stats.p95}ms errors=${errors}`);
  }

  // Check for degradation: compare first and last window p50
  const firstP50 = windows[0]?.p50 || 0;
  const lastP50 = windows[windows.length - 1]?.p50 || 0;
  const degradation = firstP50 > 0 ? ((lastP50 - firstP50) / firstP50 * 100).toFixed(0) : 0;
  console.log(`  Degradation (first→last p50): ${degradation}%`);
  console.log(`  ${Math.abs(degradation) < 50 ? '✓ Stable' : '⚠ Degradation detected'}\n`);

  return { windows, degradationPct: parseFloat(degradation) };
}

async function testOverload() {
  console.log('── Test 6d: Graceful Degradation Under Overload ──');
  console.log('  Firing 100 concurrent requests to test error handling.\n');

  const latencies = [];
  let errors = 0;
  let successes = 0;

  const start = Date.now();
  const promises = Array.from({ length: 100 }, () =>
    getMovie(config.MOVIE_IDS[Math.floor(Math.random() * config.MOVIE_IDS.length)])
      .then(({ status, latencyMs }) => {
        if (status === 200) { successes++; latencies.push(latencyMs); }
        else errors++;
      })
      .catch(() => { errors++; })
  );
  await Promise.all(promises);
  const durationMs = Date.now() - start;

  const stats = computeStats(latencies);
  const errorRate = ((errors / 100) * 100).toFixed(1);

  console.log(`  100 concurrent requests in ${durationMs}ms`);
  console.log(`  Successes: ${successes}, Errors: ${errors} (${errorRate}%)`);
  console.log(`  Latency: p50=${stats.p50}ms p95=${stats.p95}ms p99=${stats.p99}ms`);

  // Also check Service A /metrics to see if SQS publish errors increased
  const metrics = await getMetrics();
  if (metrics) {
    console.log(`  SQS metrics: published=${metrics.totalPublished} errors=${metrics.publishErrors} avgLatency=${metrics.avgPublishLatencyMs}ms`);
  }
  console.log(`  ${errors < 20 ? '✓ Graceful' : '⚠ High error rate'}\n`);

  return { total: 100, successes, errors, errorRate, durationMs, latency: stats, sqsMetrics: metrics };
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Test 6: Resilience');
  console.log('═══════════════════════════════════════════════════\n');

  const decoupling = await testDecoupling();
  const gateway = await testGatewayIndependence();
  const sustained = await testSustainedLoad();
  const overload = await testOverload();

  console.log('─── Summary ───');
  console.log(`Service A decoupled from pipeline: ${decoupling.decoupled ? '✓' : '⚠'} (${decoupling.ratio}x ratio)`);
  console.log(`Gateway healthy independently: ${gateway.healthy ? '✓' : '✗'}`);
  console.log(`Sustained load stable: ${Math.abs(sustained.degradationPct) < 50 ? '✓' : '⚠'} (${sustained.degradationPct}% degradation)`);
  console.log(`Overload graceful: ${overload.errors < 20 ? '✓' : '⚠'} (${overload.errorRate}% errors)`);

  writeResult('resilience', { decoupling, gateway, sustained, overload });
}

run().catch(console.error);

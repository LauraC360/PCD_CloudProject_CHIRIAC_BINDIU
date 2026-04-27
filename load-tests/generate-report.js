'use strict';

/**
 * Reads JSON results from load-tests/results/ and generates RESULTS.md
 * with markdown tables and Mermaid charts (rendered natively by GitHub).
 */

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
const OUTPUT = path.join(__dirname, 'RESULTS.md');

function loadJson(name) {
  const file = path.join(RESULTS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function generate() {
  const consistency = loadJson('consistency-window');
  const burst = loadJson('burst');
  const throughput = loadJson('throughput-latency');
  const wsReconn = loadJson('ws-reconnection');
  const lambdaTp = loadJson('lambda-throughput');
  const resilience = loadJson('resilience');

  const lines = [];
  const w = (s = '') => lines.push(s);

  w('# Load Test Results');
  w();
  w(`> Generated: ${new Date().toISOString()}`);
  w();

  // ── 1. Consistency Window ──
  if (consistency) {
    w('## 1. Consistency Window Measurement');
    w();
    w('Measures the time from `GET /movies/:id` until the `stats_update` arrives over WebSocket.');
    w('This is the **eventual consistency window** of the system.');
    w();
    w('| Run | Consistency (ms) | HTTP Latency (ms) | E2E from publishedAt (ms) |');
    w('|-----|-----------------|-------------------|--------------------------|');
    for (const r of consistency.results) {
      w(`| ${r.run} | ${r.consistencyMs ?? '✗ timeout'} | ${r.httpLatency} | ${r.e2eFromPublished ?? '—'} |`);
    }
    if (consistency.summary) {
      const s = consistency.summary;
      w();
      w(`**Average consistency window: ${s.avgMs}ms** (min: ${s.minMs}ms, max: ${s.maxMs}ms, successful: ${s.successfulRuns}/${consistency.runs})`);
    }
    w();
    const successful = consistency.results.filter(r => r.consistencyMs != null);
    if (successful.length > 0) {
      w('```mermaid');
      w('xychart-beta');
      w('  title "Consistency Window per Run"');
      w('  x-axis [' + successful.map(r => `"Run ${r.run}"`).join(', ') + ']');
      w('  y-axis "Milliseconds"');
      w('  bar [' + successful.map(r => r.consistencyMs).join(', ') + ']');
      w('```');
      w();
    }
  }

  // ── 2. Burst Test ──
  if (burst) {
    w('## 2. Burst Test — 100 Events');
    w();
    w(`Sent **${burst.totalEvents}** requests (concurrency=${burst.concurrency}) to movieId \`${burst.movieId}\`.`);
    w();
    w('| Metric | Value |');
    w('|--------|-------|');
    w(`| Requests sent | ${burst.totalEvents} |`);
    w(`| Successful publishes | ${burst.published} |`);
    w(`| Errors | ${burst.errors} |`);
    w(`| Time to publish all | ${burst.publishDurationMs}ms |`);
    w(`| Final viewCount | ${burst.finalViewCount} |`);
    w(`| Stats updates received | ${burst.statsUpdatesReceived} |`);
    w(`| Total convergence time | ${(burst.totalDurationMs / 1000).toFixed(1)}s |`);
    w();
    if (burst.timeline && burst.timeline.length > 0) {
      w('```mermaid');
      w('xychart-beta');
      w('  title "viewCount Convergence Over Time"');
      w('  x-axis [' + burst.timeline.map(t => `"T+${t.elapsedS}s"`).join(', ') + ']');
      w('  y-axis "viewCount" 0 --> ' + Math.max(burst.published, burst.finalViewCount));
      w('  line [' + burst.timeline.map(t => t.viewCount).join(', ') + ']');
      w('```');
      w();
    }
    w('**Analysis:** SQS acts as a buffer between the fast producer (HTTP requests) and the slower consumer (Lambda batches of up to 10). Multiple Lambda instances process in parallel; DynamoDB atomic `ADD` prevents data races.');
    w();
  }

  // ── 3. Throughput & Latency ──
  if (throughput) {
    w('## 3. Throughput & Latency Under Variable Load');
    w();
    w(`Requests per concurrency level: ${throughput.requestsPerLevel}`);
    w();
    w('| Concurrency | Throughput (r/s) | p50 (ms) | p95 (ms) | p99 (ms) | Errors |');
    w('|-------------|-----------------|----------|----------|----------|--------|');
    for (const l of throughput.levels) {
      w(`| ${l.concurrency} | ${l.throughputRps} | ${l.latency.p50} | ${l.latency.p95} | ${l.latency.p99} | ${l.errorRate} |`);
    }
    w();
    w('```mermaid');
    w('xychart-beta');
    w('  title "Throughput vs Concurrency"');
    w('  x-axis [' + throughput.levels.map(l => `"${l.concurrency}"`).join(', ') + ']');
    w('  y-axis "Requests/sec"');
    w('  bar [' + throughput.levels.map(l => l.throughputRps).join(', ') + ']');
    w('```');
    w();
    w('```mermaid');
    w('xychart-beta');
    w('  title "Latency Percentiles vs Concurrency"');
    w('  x-axis [' + throughput.levels.map(l => `"${l.concurrency}"`).join(', ') + ']');
    w('  y-axis "Milliseconds"');
    w('  line "p50" [' + throughput.levels.map(l => l.latency.p50).join(', ') + ']');
    w('  line "p95" [' + throughput.levels.map(l => l.latency.p95).join(', ') + ']');
    w('  line "p99" [' + throughput.levels.map(l => l.latency.p99).join(', ') + ']');
    w('```');
    w();
    if (throughput.e2eLatency) {
      const e = throughput.e2eLatency;
      w('### End-to-End Latency (via WebSocket)');
      w();
      w('| Metric | Value |');
      w('|--------|-------|');
      w(`| Samples | ${e.count} |`);
      w(`| p50 | ${e.p50}ms |`);
      w(`| p95 | ${e.p95}ms |`);
      w(`| p99 | ${e.p99}ms |`);
      w(`| min | ${e.min}ms |`);
      w(`| max | ${e.max}ms |`);
      w(`| avg | ${e.avg}ms |`);
      w();
    }
  }

  // ── 4. WebSocket Reconnection ──
  if (wsReconn) {
    w('## 4. WebSocket Reconnection Behavior');
    w();
    w(`Backoff: ${wsReconn.initialBackoffMs}ms × ${wsReconn.backoffMultiplier} (cap ${wsReconn.backoffCapMs}ms)`);
    w();
    w('| Attempt | Backoff (ms) | Connect Time (ms) | Result |');
    w('|---------|-------------|-------------------|--------|');
    for (const r of wsReconn.results) {
      w(`| ${r.attempt} | ${r.backoffMs} | ${r.connectMs ?? '—'} | ${r.success ? '✓' : '✗ ' + (r.error || '')} |`);
    }
    w();
    if (wsReconn.summary.avgConnectMs != null) {
      w(`**Average reconnect time: ${wsReconn.summary.avgConnectMs}ms** (${wsReconn.summary.successful}/${wsReconn.summary.total} successful)`);
    }
    w();
    const ok = wsReconn.results.filter(r => r.success);
    if (ok.length > 0) {
      w('```mermaid');
      w('xychart-beta');
      w('  title "Reconnection Time per Attempt"');
      w('  x-axis [' + ok.map(r => `"#${r.attempt}"`).join(', ') + ']');
      w('  y-axis "Milliseconds"');
      w('  bar [' + ok.map(r => r.connectMs).join(', ') + ']');
      w('```');
      w();
    }
  }

  // ── 5. Lambda Throughput ──
  if (lambdaTp) {
    w('## 5. Lambda (Event Processor) Throughput');
    w();
    w(`Measures events processed per second by polling DynamoDB viewCount during sustained load.`);
    w(`Target movieId: \`${lambdaTp.movieId}\``);
    w();
    w('| Target RPS | Events Sent | Processed | Time (s) | Avg Throughput (e/s) |');
    w('|------------|-------------|-----------|----------|---------------------|');
    for (const l of lambdaTp.levels) {
      w(`| ${l.targetRps} | ${l.totalEvents} | ${l.totalProcessed} | ${l.totalTimeS} | ${l.avgThroughput} |`);
    }
    w();
    w('```mermaid');
    w('xychart-beta');
    w('  title "Lambda Throughput vs Input Rate"');
    w('  x-axis [' + lambdaTp.levels.map(l => `"${l.targetRps} rps"`).join(', ') + ']');
    w('  y-axis "Events/sec processed"');
    w('  bar [' + lambdaTp.levels.map(l => l.avgThroughput).join(', ') + ']');
    w('```');
    w();

    // Show convergence timeline for the highest load level
    const heaviest = lambdaTp.levels[lambdaTp.levels.length - 1];
    if (heaviest?.samples?.length > 0) {
      w('### Processing Rate Over Time (highest load level)');
      w();
      w('```mermaid');
      w('xychart-beta');
      w('  title "Events Processed Over Time (' + heaviest.targetRps + ' rps target)"');
      w('  x-axis [' + heaviest.samples.map(s => `"T+${s.elapsedS}s"`).join(', ') + ']');
      w('  y-axis "Total Processed"');
      w('  line [' + heaviest.samples.map(s => s.processed).join(', ') + ']');
      w('```');
      w();
    }
  }

  // ── 6. Resilience ──
  if (resilience) {
    w('## 6. Resilience');
    w();

    // 6a: Decoupling
    if (resilience.decoupling) {
      const d = resilience.decoupling;
      w('### 6a. Service A Decoupling (fire-and-forget SQS)');
      w();
      w('Verifies Service A response time is independent of downstream pipeline load.');
      w();
      w('| Condition | p50 (ms) | p95 (ms) |');
      w('|-----------|----------|----------|');
      w(`| Baseline (sequential) | ${d.baseline.p50} | ${d.baseline.p95} |`);
      w(`| Under load (20 concurrent) | ${d.underLoad.p50} | ${d.underLoad.p95} |`);
      w();
      w(`**Load/baseline p50 ratio: ${d.ratio}x** — ${d.decoupled ? '✓ Service A is decoupled from the pipeline' : '⚠ Possible coupling detected'}`);
      w();
    }

    // 6b: Gateway independence
    if (resilience.gateway) {
      w('### 6b. WebSocket Gateway Independence');
      w();
      w(`Gateway healthy when no events flowing: **${resilience.gateway.healthy ? '✓ Yes' : '✗ No'}**`);
      w();
    }

    // 6c: Sustained load
    if (resilience.sustained) {
      const s = resilience.sustained;
      w('### 6c. Sustained Load Stability (30s)');
      w();
      w('| Window | Requests | p50 (ms) | p95 (ms) | Errors |');
      w('|--------|----------|----------|----------|--------|');
      for (const win of s.windows) {
        w(`| ${win.windowS}s | ${win.requests} | ${win.p50} | ${win.p95} | ${win.errors} |`);
      }
      w();
      w(`**Latency degradation (first→last p50): ${s.degradationPct}%** — ${Math.abs(s.degradationPct) < 50 ? '✓ Stable' : '⚠ Degradation detected'}`);
      w();

      if (s.windows.length > 1) {
        w('```mermaid');
        w('xychart-beta');
        w('  title "p50 Latency Over Time (sustained load)"');
        w('  x-axis [' + s.windows.map(win => `"${win.windowS}s"`).join(', ') + ']');
        w('  y-axis "p50 (ms)"');
        w('  line [' + s.windows.map(win => win.p50).join(', ') + ']');
        w('```');
        w();
      }
    }

    // 6d: Overload
    if (resilience.overload) {
      const o = resilience.overload;
      w('### 6d. Graceful Degradation Under Overload');
      w();
      w(`100 concurrent requests: **${o.successes} succeeded**, **${o.errors} failed** (${o.errorRate}% error rate)`);
      w(`Latency: p50=${o.latency.p50}ms, p95=${o.latency.p95}ms, p99=${o.latency.p99}ms`);
      if (o.sqsMetrics) {
        w(`SQS publisher: ${o.sqsMetrics.totalPublished} published, ${o.sqsMetrics.publishErrors} errors, avg latency ${o.sqsMetrics.avgPublishLatencyMs}ms`);
      }
      w();
    }
  }

  // ── Footer ──
  const allNull = [consistency, burst, throughput, wsReconn, lambdaTp, resilience].every(x => x === null);
  if (allNull) {
    w('*No results found. Run the load tests first:*');
    w();
    w('```bash');
    w('npm run load-test');
    w('```');
  }

  const md = lines.join('\n');
  fs.writeFileSync(OUTPUT, md);
  console.log(`✓ Report generated: ${OUTPUT}`);
}

generate();

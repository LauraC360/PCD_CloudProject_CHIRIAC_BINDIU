'use strict';

/**
 * Test 2 — Burst Test (100 events with parallel verification)
 *
 * Adapted from assignment section 4.4 (Part 2).
 * Fires 100 GET /movies/:id requests (which each publish a View_Event to SQS),
 * then monitors the WebSocket for stats_update messages to observe how the
 * viewCount converges over time.
 *
 * Answers Q7: Does viewCount reach 100? How long does it take?
 * Demonstrates the producer-fast / consumer-slow pattern with SQS as buffer.
 */

const WebSocket = require('ws');
const config = require('./config');
const { getMovie, sleep, writeResult } = require('./helpers');

const TOTAL_EVENTS = 100;
const CONCURRENCY = 10; // parallel HTTP requests
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_CHECKS = 24; // 2 minutes max

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Test 2: Burst Test — 100 Events');
  console.log('═══════════════════════════════════════════════════\n');

  // Use a single movie so viewCount accumulates
  const movieId = config.MOVIE_IDS[0];
  console.log(`Target movieId: ${movieId}`);
  console.log(`Sending ${TOTAL_EVENTS} requests with concurrency=${CONCURRENCY}\n`);

  // Connect WebSocket to count stats_update messages
  let statsUpdatesReceived = 0;
  let lastViewCount = 0;
  const timeline = []; // { elapsed, viewCount, published }

  const ws = new WebSocket(`${config.WS_GATEWAY_URL}/ws`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'stats_update' && msg.top10) {
        statsUpdatesReceived++;
        const entry = msg.top10.find((m) => m.movieId === movieId);
        if (entry) lastViewCount = entry.viewCount;
      }
    } catch { /* ignore */ }
  });

  // Fire requests in batches
  const start = Date.now();
  let published = 0;
  let errors = 0;

  async function fireOne() {
    try {
      const { status } = await getMovie(movieId);
      if (status === 200) published++;
      else errors++;
    } catch {
      errors++;
    }
  }

  // Launch in waves of CONCURRENCY
  for (let i = 0; i < TOTAL_EVENTS; i += CONCURRENCY) {
    const batch = Math.min(CONCURRENCY, TOTAL_EVENTS - i);
    await Promise.all(Array.from({ length: batch }, () => fireOne()));
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  Published: ${published}/${TOTAL_EVENTS} (errors: ${errors}) [${elapsed}s]`);
  }

  const publishDoneMs = Date.now() - start;
  console.log(`\nAll ${TOTAL_EVENTS} requests sent in ${publishDoneMs}ms`);
  console.log(`  Successful publishes: ${published}, Errors: ${errors}`);
  console.log(`\nPolling for convergence (every ${POLL_INTERVAL_MS / 1000}s)…\n`);

  // Poll: observe viewCount converging
  for (let check = 1; check <= MAX_POLL_CHECKS; check++) {
    await sleep(POLL_INTERVAL_MS);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    timeline.push({ elapsedS: elapsed, viewCount: lastViewCount, statsUpdates: statsUpdatesReceived });
    console.log(
      `  T+${elapsed}s: viewCount=${lastViewCount}, statsUpdates=${statsUpdatesReceived}`
    );
    if (lastViewCount >= published) {
      console.log(`\n✓ viewCount converged to ${lastViewCount} after ${elapsed}s`);
      break;
    }
  }

  ws.close();

  // Summary
  console.log('\n─── Summary ───');
  console.log(`Total requests sent: ${TOTAL_EVENTS}`);
  console.log(`Successful publishes: ${published}`);
  console.log(`Final viewCount observed: ${lastViewCount}`);
  console.log(`Stats updates received: ${statsUpdatesReceived}`);
  console.log(`Time to publish all: ${publishDoneMs}ms`);
  console.log(`Total convergence time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`\nTimeline:`, JSON.stringify(timeline, null, 2));

  writeResult('burst', {
    movieId,
    totalEvents: TOTAL_EVENTS,
    concurrency: CONCURRENCY,
    published,
    errors,
    publishDurationMs: publishDoneMs,
    finalViewCount: lastViewCount,
    statsUpdatesReceived,
    totalDurationMs: Date.now() - start,
    timeline,
  });

  console.log(`\nAnalysis:`);
  console.log(`  - SQS acts as a buffer between the fast producer (HTTP requests)`);
  console.log(`    and the slower consumer (Lambda processing batches of up to 10)`);
  console.log(`  - Multiple Lambda instances process batches in parallel`);
  console.log(`  - DynamoDB atomic ADD ensures no data races despite parallel writes`);
  if (lastViewCount < published) {
    console.log(`  ⚠ viewCount (${lastViewCount}) < published (${published}) — still converging or messages in DLQ`);
  }
}

run().catch(console.error);

'use strict';

/**
 * Test 5 — Lambda (Event Processor) Throughput
 *
 * From assignment: "Throughput-ul Cloud Function sub incarcare variabila"
 *
 * Measures how many events/second Lambda actually processes by:
 *   1. Recording the initial viewCount for a movie from DynamoDB
 *   2. Firing N requests at varying rates
 *   3. Polling DynamoDB viewCount at intervals to measure processing rate
 *
 * Uses the AWS SDK directly to query DynamoDB (same table Lambda writes to).
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const config = require('./config');
const { getMovie, sleep, writeResult } = require('./helpers');

const region = config.AWS_REGION;
const tableName = 'MovieStats';

const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

async function getViewCount(movieId) {
  try {
    const res = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { movieId },
      ProjectionExpression: 'viewCount',
    }));
    return res.Item?.viewCount ?? 0;
  } catch (err) {
    console.error(`  DynamoDB query failed: ${err.message}`);
    return null;
  }
}

// Fire requests at a target rate (events/sec)
async function fireAtRate(movieId, totalEvents, targetRps) {
  const delayMs = Math.floor(1000 / targetRps);
  let sent = 0;
  let errors = 0;

  for (let i = 0; i < totalEvents; i++) {
    getMovie(movieId).then(({ status }) => {
      if (status === 200) sent++;
      else errors++;
    }).catch(() => { errors++; });

    if (delayMs > 0 && i < totalEvents - 1) await sleep(delayMs);
  }

  // Wait for in-flight requests to finish
  await sleep(2000);
  return { sent: sent + errors - errors, errors, actualSent: totalEvents };
}

async function runLevel(movieId, targetRps, totalEvents) {
  console.log(`\n── Target rate: ${targetRps} events/sec (${totalEvents} total) ──`);

  const initialCount = await getViewCount(movieId);
  if (initialCount === null) return null;
  console.log(`  Initial viewCount: ${initialCount}`);

  const start = Date.now();

  // Fire requests
  await fireAtRate(movieId, totalEvents, targetRps);
  const publishDoneMs = Date.now() - start;
  console.log(`  All ${totalEvents} requests sent in ${publishDoneMs}ms`);

  // Poll DynamoDB every 2s for up to 60s to watch Lambda process
  const samples = [];
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const count = await getViewCount(movieId);
    if (count === null) continue;
    const processed = count - initialCount;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const rate = (processed / parseFloat(elapsed)).toFixed(1);
    samples.push({ elapsedS: parseFloat(elapsed), viewCount: count, processed, ratePerSec: parseFloat(rate) });
    console.log(`  T+${elapsed}s: viewCount=${count} (Δ${processed}) rate=${rate} events/s`);

    if (processed >= totalEvents) {
      console.log(`  ✓ All ${totalEvents} events processed`);
      break;
    }
  }

  const finalCount = await getViewCount(movieId);
  const totalProcessed = (finalCount ?? 0) - initialCount;
  const totalTimeS = (Date.now() - start) / 1000;
  const avgThroughput = parseFloat((totalProcessed / totalTimeS).toFixed(2));

  return {
    targetRps,
    totalEvents,
    publishDurationMs: publishDoneMs,
    totalProcessed,
    totalTimeS: parseFloat(totalTimeS.toFixed(1)),
    avgThroughput,
    samples,
  };
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Test 5: Lambda (Event Processor) Throughput');
  console.log('═══════════════════════════════════════════════════\n');

  const movieId = config.MOVIE_IDS[2]; // use a different movie than burst test
  console.log(`Target movieId: ${movieId}`);

  // Test at different publish rates
  const levels = [
    { rps: 2, total: 10 },
    { rps: 10, total: 30 },
    { rps: 25, total: 50 },
  ];

  const results = [];
  for (const { rps, total } of levels) {
    const result = await runLevel(movieId, rps, total);
    if (result) results.push(result);
    await sleep(5000); // cooldown between levels
  }

  // Summary
  console.log('\n─── Summary ───');
  console.log('Target RPS | Events | Processed | Time (s) | Avg Throughput (e/s)');
  console.log('-----------|--------|-----------|----------|--------------------');
  for (const r of results) {
    console.log(
      `${String(r.targetRps).padStart(10)} | ${String(r.totalEvents).padStart(6)} | ` +
      `${String(r.totalProcessed).padStart(9)} | ${String(r.totalTimeS).padStart(8)} | ${r.avgThroughput}`
    );
  }

  writeResult('lambda-throughput', { movieId, levels: results });
}

run().catch(console.error);

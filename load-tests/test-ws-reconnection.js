'use strict';

/**
 * Test 4 — WebSocket Reconnection Behavior
 *
 * From assignment metrics: "Comportamentul WebSocket la reconectare dupa esec"
 *
 * Tests:
 *   1. Connect → receive initial_state → verify
 *   2. Force-close → reconnect → verify initial_state again
 *   3. Measure reconnection time with exponential backoff
 *   4. Verify data continuity (top10 still arrives after reconnect)
 */

const WebSocket = require('ws');
const config = require('./config');
const { sleep, writeResult } = require('./helpers');

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 1000;
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_CAP_MS = 30_000;

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${config.WS_GATEWAY_URL}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('WS connect timeout (10s)'));
    }, 10_000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForMessage(ws, type, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch { /* ignore */ }
    };
    ws.on('message', handler);
  });
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Test 4: WebSocket Reconnection Behavior');
  console.log('═══════════════════════════════════════════════════\n');

  // ── Step 1: Initial connection ──
  console.log('Step 1: Initial connection');
  let ws;
  try {
    const connectStart = Date.now();
    ws = await connectWs();
    const connectMs = Date.now() - connectStart;
    console.log(`  ✓ Connected in ${connectMs}ms`);

    const initialState = await waitForMessage(ws, 'initial_state');
    console.log(`  ✓ initial_state received: connectedClients=${initialState.connectedClients}, top10Count=${initialState.top10?.length ?? 0}`);
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`);
    console.log('\n⚠ Cannot proceed — WebSocket Gateway unreachable.');
    return;
  }

  // ── Step 2: Force disconnect and reconnect ──
  console.log('\nStep 2: Force disconnect → reconnect');
  ws.close();
  console.log('  WebSocket closed.');
  await sleep(1000);

  try {
    const reconnStart = Date.now();
    ws = await connectWs();
    const reconnMs = Date.now() - reconnStart;
    console.log(`  ✓ Reconnected in ${reconnMs}ms`);

    const initialState2 = await waitForMessage(ws, 'initial_state');
    console.log(`  ✓ initial_state received again: connectedClients=${initialState2.connectedClients}, top10Count=${initialState2.top10?.length ?? 0}`);
    ws.close();
  } catch (err) {
    console.log(`  ✗ Reconnect failed: ${err.message}`);
  }

  // ── Step 3: Exponential backoff reconnection simulation ──
  console.log('\nStep 3: Exponential backoff reconnection (simulating client behavior)');
  let backoff = INITIAL_BACKOFF_MS;
  const reconnResults = [];

  for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
    console.log(`  Attempt ${attempt}: waiting ${backoff}ms before reconnect…`);
    await sleep(backoff);

    const start = Date.now();
    try {
      ws = await connectWs();
      const ms = Date.now() - start;
      const msg = await waitForMessage(ws, 'initial_state');
      reconnResults.push({ attempt, backoffMs: backoff, connectMs: ms, success: true });
      console.log(`  ✓ Connected in ${ms}ms (got initial_state, clients=${msg.connectedClients})`);
      ws.close();
    } catch (err) {
      reconnResults.push({ attempt, backoffMs: backoff, success: false, error: err.message });
      console.log(`  ✗ Failed: ${err.message}`);
    }

    backoff = Math.min(backoff * BACKOFF_MULTIPLIER, BACKOFF_CAP_MS);
  }

  // ── Step 4: Verify data continuity after reconnect ──
  console.log('\nStep 4: Data continuity — connect and verify top10 is populated');
  try {
    ws = await connectWs();
    const msg = await waitForMessage(ws, 'initial_state');
    const hasData = msg.top10 && msg.top10.length > 0;
    console.log(`  ✓ top10 has ${msg.top10?.length ?? 0} entries — data continuity: ${hasData ? 'OK' : 'EMPTY (may be expected if no events yet)'}`);
    ws.close();
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
  }

  // Summary
  console.log('\n─── Summary ───');
  const successful = reconnResults.filter((r) => r.success);
  console.log(`Reconnection attempts: ${reconnResults.length}`);
  console.log(`Successful: ${successful.length}/${reconnResults.length}`);
  if (successful.length > 0) {
    const avgConnect = Math.round(successful.reduce((a, r) => a + r.connectMs, 0) / successful.length);
    console.log(`Average reconnect time: ${avgConnect}ms`);
  }
  console.log(`Backoff schedule: ${INITIAL_BACKOFF_MS}ms × ${BACKOFF_MULTIPLIER} (cap ${BACKOFF_CAP_MS}ms)`);
  console.log('\nRaw results:', JSON.stringify(reconnResults, null, 2));

  writeResult('ws-reconnection', {
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
    backoffMultiplier: BACKOFF_MULTIPLIER,
    backoffCapMs: BACKOFF_CAP_MS,
    results: reconnResults,
    summary: {
      total: reconnResults.length,
      successful: successful.length,
      avgConnectMs: successful.length > 0
        ? Math.round(successful.reduce((a, r) => a + r.connectMs, 0) / successful.length)
        : null,
    },
  });
}

run().catch(console.error);

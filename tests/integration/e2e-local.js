#!/usr/bin/env node

/**
 * End-to-End Integration Test (Local)
 * 
 * Tests the full flow locally:
 * 1. WebSocket client connects to Gateway
 * 2. HTTP client calls Service A GET /movies/:id
 * 3. Service A publishes View_Event to SQS (mock)
 * 4. Gateway receives notification and broadcasts stats_update
 * 5. WebSocket client receives stats_update with updated viewCount
 * 
 * Usage:
 *   node tests/integration/e2e-local.js
 * 
 * Prerequisites:
 *   - Service A running on http://localhost:3000
 *   - WebSocket Gateway running on ws://localhost:8080 and http://localhost:8081
 */

const WebSocket = require('ws');
const http = require('http');

const SERVICE_A_URL = 'http://localhost:3000';
const GATEWAY_WS_URL = 'ws://localhost:8080';
const GATEWAY_HTTP_URL = 'http://localhost:8081';

const TIMEOUT = 10000; // 10 seconds

let testsPassed = 0;
let testsFailed = 0;

// Helper: make HTTP request
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? require('https') : http;
    
    const req = protocol.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null
          });
        } catch (err) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        }
      });
    });

    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// Helper: test assertion
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Test 1: Health check
async function testHealthCheck() {
  console.log('\n[TEST 1] Health Check');
  try {
    const response = await httpRequest(`${GATEWAY_HTTP_URL}/health`);
    assert(response.status === 200, `Expected status 200, got ${response.status}`);
    assert(response.body.status === 'ok', `Expected status 'ok', got ${response.body.status}`);
    assert(typeof response.body.connectedClients === 'number', 'connectedClients should be a number');
    assert(typeof response.body.backpressureActive === 'boolean', 'backpressureActive should be a boolean');
    
    console.log('✓ Health check passed');
    console.log(`  - connectedClients: ${response.body.connectedClients}`);
    console.log(`  - backpressureActive: ${response.body.backpressureActive}`);
    testsPassed++;
  } catch (err) {
    console.error('✗ Health check failed:', err.message);
    testsFailed++;
  }
}

// Test 2: Service A metrics
async function testServiceAMetrics() {
  console.log('\n[TEST 2] Service A Metrics');
  try {
    const response = await httpRequest(`${SERVICE_A_URL}/api/v1/metrics`);
    assert(response.status === 200, `Expected status 200, got ${response.status}`);
    assert(typeof response.body.totalPublished === 'number', 'totalPublished should be a number');
    assert(typeof response.body.publishErrors === 'number', 'publishErrors should be a number');
    assert(typeof response.body.avgPublishLatencyMs === 'number', 'avgPublishLatencyMs should be a number');
    
    console.log('✓ Service A metrics passed');
    console.log(`  - totalPublished: ${response.body.totalPublished}`);
    console.log(`  - publishErrors: ${response.body.publishErrors}`);
    console.log(`  - avgPublishLatencyMs: ${response.body.avgPublishLatencyMs.toFixed(2)}`);
    testsPassed++;
  } catch (err) {
    console.error('✗ Service A metrics failed:', err.message);
    testsFailed++;
  }
}

// Test 3: WebSocket connection and stats_update
async function testWebSocketStatsUpdate() {
  console.log('\n[TEST 3] WebSocket Connection and Stats Update');
  
  return new Promise((resolve) => {
    let receivedInitialState = false;
    let receivedStatsUpdate = false;
    let movieId = '573a1390f29313caabcd42e8'; // Sample movie ID from MongoDB

    const ws = new WebSocket(GATEWAY_WS_URL);
    let timeoutHandle;

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      ws.close();
    };

    ws.on('open', () => {
      console.log('  - WebSocket connected');
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);

        if (message.type === 'initial_state') {
          receivedInitialState = true;
          console.log('  - Received initial_state');
          console.log(`    - connectedClients: ${message.connectedClients}`);
          console.log(`    - top10 movies: ${message.top10?.length || 0}`);

          // Now call Service A to trigger a view event
          setTimeout(async () => {
            try {
              console.log(`  - Calling GET /movies/${movieId}...`);
              const response = await httpRequest(`${SERVICE_A_URL}/api/v1/movies/${movieId}`);
              if (response.status === 200) {
                console.log(`    - Got 200 response, movie: ${response.body.title}`);
              } else {
                console.log(`    - Got ${response.status} response`);
              }
            } catch (err) {
              console.error(`    - Error calling Service A: ${err.message}`);
            }
          }, 500);
        }

        if (message.type === 'stats_update') {
          receivedStatsUpdate = true;
          console.log('  - Received stats_update');
          console.log(`    - connectedClients: ${message.connectedClients}`);
          console.log(`    - top10 movies: ${message.top10?.length || 0}`);
          
          if (message.publishedAt && message.deliveredAt) {
            const latency = new Date(message.deliveredAt).getTime() - new Date(message.publishedAt).getTime();
            console.log(`    - latency: ${latency}ms`);
          }

          // Verify message structure
          try {
            assert(message.type === 'stats_update', 'Message type should be stats_update');
            assert(message.connectedClients >= 1, 'connectedClients should be >= 1');
            assert(Array.isArray(message.top10), 'top10 should be an array');
            assert(message.deliveredAt, 'deliveredAt should be defined');
            assert(message.publishedAt, 'publishedAt should be defined');

            const latency = new Date(message.deliveredAt).getTime() - new Date(message.publishedAt).getTime();
            assert(latency > 0, 'latency should be positive');
            assert(latency < 5000, 'latency should be < 5 seconds');

            console.log('✓ WebSocket stats_update test passed');
            testsPassed++;
          } catch (err) {
            console.error('✗ WebSocket stats_update validation failed:', err.message);
            testsFailed++;
          }

          cleanup();
          resolve();
        }
      } catch (err) {
        console.error('✗ Error parsing message:', err.message);
        testsFailed++;
        cleanup();
        resolve();
      }
    });

    ws.on('error', (err) => {
      console.error('✗ WebSocket error:', err.message);
      testsFailed++;
      cleanup();
      resolve();
    });

    ws.on('close', () => {
      console.log('  - WebSocket closed');
      if (!receivedStatsUpdate) {
        console.error('✗ Did not receive stats_update before connection closed');
        testsFailed++;
      }
      resolve();
    });

    // Timeout
    timeoutHandle = setTimeout(() => {
      console.error('✗ Timeout waiting for stats_update');
      testsFailed++;
      cleanup();
      resolve();
    }, TIMEOUT);
  });
}

// Test 4: Multiple concurrent connections
async function testMultipleConnections() {
  console.log('\n[TEST 4] Multiple Concurrent Connections');

  return new Promise((resolve) => {
    const numClients = 3;
    let connectedCount = 0;
    let statsUpdateCount = 0;
    const clients = [];
    let timeoutHandle;

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      clients.forEach(ws => ws.close());
    };

    const connectClient = (index) => {
      const ws = new WebSocket(GATEWAY_WS_URL);

      ws.on('open', () => {
        connectedCount++;
        console.log(`  - Client ${index} connected (${connectedCount}/${numClients})`);
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);

          if (message.type === 'stats_update') {
            statsUpdateCount++;
            console.log(`  - Client ${index} received stats_update (${statsUpdateCount}/${numClients})`);
            console.log(`    - connectedClients: ${message.connectedClients}`);

            if (statsUpdateCount >= numClients) {
              try {
                assert(message.connectedClients >= numClients, `Expected >= ${numClients} connected clients, got ${message.connectedClients}`);
                console.log('✓ Multiple connections test passed');
                testsPassed++;
              } catch (err) {
                console.error('✗ Multiple connections validation failed:', err.message);
                testsFailed++;
              }

              cleanup();
              resolve();
            }
          }
        } catch (err) {
          console.error(`✗ Client ${index} error parsing message:`, err.message);
          testsFailed++;
          cleanup();
          resolve();
        }
      });

      ws.on('error', (err) => {
        console.error(`✗ Client ${index} error:`, err.message);
        testsFailed++;
        cleanup();
        resolve();
      });

      clients.push(ws);
    };

    // Connect clients
    for (let i = 0; i < numClients; i++) {
      setTimeout(() => connectClient(i), i * 100);
    }

    // Trigger a view event after all clients are connected
    setTimeout(async () => {
      try {
        console.log('  - Triggering view event...');
        await httpRequest(`${SERVICE_A_URL}/api/v1/movies/573a1390f29313caabcd42e8`);
      } catch (err) {
        console.error('  - Error triggering view event:', err.message);
      }
    }, 1000);

    // Timeout
    timeoutHandle = setTimeout(() => {
      console.error('✗ Timeout waiting for all clients to receive stats_update');
      testsFailed++;
      cleanup();
      resolve();
    }, TIMEOUT + 5000);
  });
}

// Main test runner
async function runTests() {
  console.log('='.repeat(60));
  console.log('End-to-End Integration Tests (Local)');
  console.log('='.repeat(60));
  console.log(`\nService A: ${SERVICE_A_URL}`);
  console.log(`Gateway WS: ${GATEWAY_WS_URL}`);
  console.log(`Gateway HTTP: ${GATEWAY_HTTP_URL}`);

  try {
    await testHealthCheck();
    await testServiceAMetrics();
    await testWebSocketStatsUpdate();
    await testMultipleConnections();
  } catch (err) {
    console.error('\nFatal error:', err.message);
    testsFailed++;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log(`✓ Passed: ${testsPassed}`);
  console.log(`✗ Failed: ${testsFailed}`);
  console.log(`Total: ${testsPassed + testsFailed}`);

  if (testsFailed === 0) {
    console.log('\n✓ All tests passed!');
    process.exit(0);
  } else {
    console.log('\n✗ Some tests failed');
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

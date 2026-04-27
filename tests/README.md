# Integration and Load Tests

This directory contains integration tests and load tests for the Realtime Analytics Dashboard.

## Prerequisites

All services must be running locally:

1. **Service A** (Fastify API)
   ```bash
   cd service-a
   npm run dev
   ```
   Runs on `http://localhost:3000`

2. **WebSocket Gateway**
   ```bash
   cd websocket-gateway
   npm run dev
   ```
   Runs on `ws://localhost:8080` and `http://localhost:8081`

3. **MongoDB** (for Service A)
   - Must be running and accessible at the URL in `service-a/.env`
   - Or use Testcontainers (automatic when `NODE_ENV=test`)

## Integration Tests

### End-to-End Test (Local)

Tests the full flow:
1. WebSocket client connects to Gateway
2. HTTP client calls Service A `GET /movies/:id`
3. Service A publishes View_Event to SQS (mock)
4. Gateway receives notification and broadcasts `stats_update`
5. WebSocket client receives `stats_update` with updated view count

**Run the test:**

```bash
node tests/integration/e2e-local.js
```

**Expected output:**

```
============================================================
End-to-End Integration Tests (Local)
============================================================

Service A: http://localhost:3000
Gateway WS: ws://localhost:8080
Gateway HTTP: http://localhost:8081

[TEST 1] Health Check
  - WebSocket connected
  - Received initial_state
    - connectedClients: 1
    - top10 movies: 2
  - Calling GET /movies/573a1390f29313caabcd42e8...
    - Got 200 response, movie: The Shawshank Redemption
  - Received stats_update
    - connectedClients: 1
    - top10 movies: 2
    - latency: 45ms
✓ WebSocket stats_update test passed

[TEST 2] Service A Metrics
✓ Service A metrics passed
  - totalPublished: 5
  - publishErrors: 0
  - avgPublishLatencyMs: 12.34

[TEST 3] Multiple Concurrent Connections
  - Client 0 connected (1/3)
  - Client 1 connected (2/3)
  - Client 2 connected (3/3)
  - Client 0 received stats_update (1/3)
    - connectedClients: 3
  - Client 1 received stats_update (2/3)
    - connectedClients: 3
  - Client 2 received stats_update (3/3)
    - connectedClients: 3
✓ Multiple connections test passed

============================================================
Test Summary
============================================================
✓ Passed: 4
✗ Failed: 0
Total: 4

✓ All tests passed!
```

**What it tests:**

- ✓ Gateway health check endpoint
- ✓ Service A metrics endpoint
- ✓ WebSocket connection and initial state
- ✓ View event publishing and stats update delivery
- ✓ End-to-end latency (publishedAt → deliveredAt)
- ✓ Multiple concurrent WebSocket connections
- ✓ Connected clients count accuracy

## Load Tests

### Artillery Load Test

Tests Service A under increasing load. Measures:
- Latency (p50, p95, p99)
- Throughput (requests per second)
- Error rate
- SQS publish success rate

**Prerequisites:**

```bash
npm install -g artillery
```

**Run the load test:**

```bash
# Against local Service A
artillery run tests/load/load-test.yml

# Or specify a target
TARGET_URL=http://localhost:3000 artillery run tests/load/load-test.yml
```

**Load profile:**

- **Ramp-up**: 0 → 50 users over 30 seconds
- **Steady state**: 50 users for 60 seconds
- **Ramp-down**: 50 → 0 users over 30 seconds

**Total duration**: ~2 minutes

**Expected output:**

```
All virtual users finished
Summary report @ 12:34:56 +0000
  Scenarios launched:  3000
  Scenarios completed: 3000
  Requests completed:  3000
  RPS sent: 50
  Request latency:
    min: 10
    max: 250
    median: 45
    p95: 120
    p99: 180
  Scenario counts:
    Get Movie by ID: 2400
    Get Metrics: 600
  Codes:
    200: 3000
  Errors: 0
```

**Interpreting results:**

- **p99 latency < 200ms**: ✓ Good (requirement met)
- **Error rate < 0.1%**: ✓ Good (requirement met)
- **RPS = 50**: ✓ Steady state maintained
- **SQS publish errors**: Check Service A logs for `[ERROR] Failed to publish View_Event`

### Analyzing Load Test Results

After running the load test, check:

1. **Service A logs** for SQS publish errors:
   ```
   [ERROR] Failed to publish View_Event
   ```

2. **Service A metrics** endpoint:
   ```bash
   curl http://localhost:3000/api/v1/metrics
   ```
   
   Should show:
   - `totalPublished`: ~2400 (number of movie requests)
   - `publishErrors`: 0 (or very low)
   - `avgPublishLatencyMs`: < 50ms

3. **Gateway health** endpoint:
   ```bash
   curl http://localhost:8081/health
   ```
   
   Should show:
   - `backpressureActive`: false (unless load > 100 req/s)
   - `connectedClients`: 0 (after test completes)

4. **Load test report**:
   - `tests/load/report.json` - Full metrics in JSON
   - `tests/load/report.csv` - Metrics in CSV format

## Collecting Metrics for the Report

### 1. Latency Percentiles

From Artillery report:
```
Request latency:
  p50: 45ms
  p95: 120ms
  p99: 180ms
```

### 2. Throughput

From Artillery report:
```
RPS sent: 50
Scenarios completed: 3000
```

### 3. End-to-End Latency

From integration test output:
```
- latency: 45ms  (publishedAt → deliveredAt)
```

### 4. SQS Publish Metrics

From Service A `/metrics` endpoint:
```json
{
  "totalPublished": 2400,
  "publishErrors": 0,
  "avgPublishLatencyMs": 12.34
}
```

### 5. WebSocket Delivery Latency

From integration test:
```
- latency: 45ms  (time from event published to stats_update delivered)
```

## Troubleshooting

### "Connection refused" errors

**Problem**: Tests fail to connect to Service A or Gateway

**Solution**:
1. Verify Service A is running: `curl http://localhost:3000/api/v1/metrics`
2. Verify Gateway is running: `curl http://localhost:8081/health`
3. Check firewall/port conflicts

### "Timeout waiting for stats_update"

**Problem**: Integration test times out waiting for WebSocket message

**Solution**:
1. Check Service A logs for SQS publish errors
2. Check Gateway logs for notification errors
3. Verify mock SQS is working (check Service A logs for `[MOCK SQS]` messages)

### "Did not receive stats_update before connection closed"

**Problem**: WebSocket connection closes before receiving stats_update

**Solution**:
1. Increase `TIMEOUT` in `e2e-local.js` (currently 10 seconds)
2. Check Gateway logs for errors
3. Verify DynamoDB mock is working

### Artillery "Cannot find module" errors

**Problem**: Artillery can't find the processor module

**Solution**:
```bash
# Make sure you're in the project root
cd /path/to/project
artillery run tests/load/load-test.yml
```

## Next Steps

After running these tests:

1. **Collect metrics** for the scientific report:
   - Latency percentiles (p50, p95, p99)
   - Throughput (requests per second)
   - Error rate
   - End-to-end latency

2. **Document results** in the report:
   - Include Artillery HTML report
   - Include latency chart from integration test
   - Analyze performance under load

3. **Verify requirements**:
   - ✓ Requirement 7: End-to-end latency < 500ms
   - ✓ Requirement 8: Load test with Artillery
   - ✓ Requirement 8.4: Latency and throughput graphs

## References

- [Artillery Documentation](https://artillery.io/docs)
- [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [Node.js HTTP Module](https://nodejs.org/api/http.html)

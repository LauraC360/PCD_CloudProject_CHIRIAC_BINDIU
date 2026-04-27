# Load Tests

Performance and resilience tests for the Realtime Analytics Dashboard.

## Prerequisites

- **Node.js ≥ 18** (uses native `fetch`)
- **AWS CLI** configured with a profile that has access to Cognito and DynamoDB
- **All services deployed and running:**
  - Service A (ECS Fargate / App Runner)
  - Event Processor (Lambda + SQS)
  - WebSocket Gateway (ECS Fargate)
  - DynamoDB tables (`MovieStats`, `ProcessedEvents`, `RecentActivity`)

## Setup

```bash
cd load-tests
npm install
```

## Configuration

Edit `config.js` or set environment variables before running:

```bash
# Required — your deployed service URLs
export SERVICE_A_URL="https://vvsusbtfkg.us-east-1.awsapprunner.com"
export WS_GATEWAY_URL="wss://d368d1sswys5zs.cloudfront.net"

# Optional — skip auto-fetch from Cognito by providing a token directly
export JWT_TOKEN="eyJraWQiOi..."

# Optional — AWS CLI profile for Cognito auth and DynamoDB queries
export AWS_PROFILE="pers"
export AWS_REGION="us-east-1"
```

If `JWT_TOKEN` is not set, the tests will auto-fetch one using the AWS CLI with the Cognito credentials in `config.js`.

### How to get a JWT manually

```bash
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=test@test.com,PASSWORD='Test1234!Perm' \
  --client-id 4t06qivno4u8b5nqq4qqs6usr5 \
  --profile pers \
  --region us-east-1 \
  --query "AuthenticationResult.IdToken" \
  --output text
```

## Running Tests

### Run all tests + generate report

```bash
npm run all
# or from the repo root:
npm run load-test
```

This runs all 6 tests sequentially, saves JSON results to `results/`, and generates `RESULTS.md` with tables and Mermaid charts.

### Run individual tests

```bash
npm run consistency        # Test 1: Consistency window (5 runs)
npm run burst              # Test 2: 100-event burst with convergence tracking
npm run throughput         # Test 3: HTTP throughput & latency at varying concurrency
npm run lambda-throughput  # Test 4: Lambda processing rate via DynamoDB polling
npm run ws-reconnect       # Test 5: WebSocket reconnection with exponential backoff
npm run resilience         # Test 6: Decoupling, stability, graceful degradation
```

### Regenerate the report from existing results

```bash
npm run report
```

## Test Descriptions

### Test 1 — Consistency Window (`test-consistency-window.js`)

Measures the eventual consistency window: time from `GET /movies/:id` until the `stats_update` arrives over WebSocket.

- Connects WebSocket **before** the HTTP request (so it doesn't miss the update)
- Runs 5 iterations with different movies
- Reports avg/min/max consistency window in milliseconds

**Answers assignment Q6:** What is the average consistency window? What factors contribute to variability?

### Test 2 — Burst Test (`test-burst.js`)

Sends 100 `GET /movies/:id` requests to a single movie (concurrency=10) and monitors the WebSocket in parallel to observe how `viewCount` converges over time.

- Logs a timeline: `T+Xs: viewCount=Y, statsUpdates=Z`
- Measures total convergence time

**Answers assignment Q7/Q8:** Does viewCount reach 100? SQS as buffer between fast producer and slow consumer. CAP theorem trade-offs.

### Test 3 — Throughput & Latency (`test-throughput-latency.js`)

Ramps through concurrency levels [1, 5, 10, 20, 50] and measures:

- HTTP response latency (p50, p95, p99)
- Throughput (requests/second)
- Error rate per level
- End-to-end latency from WebSocket (`publishedAt` → `deliveredAt`)

### Test 4 — Lambda Throughput (`test-lambda-throughput.js`)

Measures how many events/second Lambda actually processes by:

1. Recording the initial `viewCount` for a movie from DynamoDB
2. Firing requests at target rates (2, 10, 25 events/sec)
3. Polling DynamoDB every 2 seconds to measure the processing rate

**Requires:** AWS credentials with DynamoDB `GetItem` permission on the `MovieStats` table.

### Test 5 — WebSocket Reconnection (`test-ws-reconnection.js`)

Tests WebSocket reconnection behavior:

1. Connect → receive `initial_state` → verify
2. Force-close → reconnect → verify `initial_state` again
3. Simulate exponential backoff (1s × 2, cap 30s, 5 attempts)
4. Verify data continuity after reconnect (top10 still populated)

### Test 6 — Resilience (`test-resilience.js`)

Four sub-tests:

| Sub-test | What it verifies |
|----------|-----------------|
| **6a. Decoupling** | Service A response time is independent of pipeline load (SQS fire-and-forget) |
| **6b. Gateway independence** | WebSocket Gateway stays healthy when no events are flowing |
| **6c. Sustained load** | Latency remains stable over 30 seconds of continuous load |
| **6d. Overload** | System degrades gracefully under 100 concurrent requests |

## Output

Each test writes:
- **Console output** — real-time progress and results
- **JSON file** — `results/<test-name>.json` with structured data

After all tests, `generate-report.js` produces **`RESULTS.md`** containing:
- Markdown tables with all metrics
- Mermaid charts (rendered natively by GitHub):
  - Consistency window bar chart
  - viewCount convergence line chart
  - Throughput vs concurrency bar chart
  - Latency percentiles (p50/p95/p99) line chart
  - Lambda throughput bar chart
  - Sustained load stability line chart
  - Reconnection time bar chart

## File Structure

```
load-tests/
├── config.js                    # Shared configuration (URLs, movie IDs, credentials)
├── helpers.js                   # HTTP helpers, JWT fetching, stats computation
├── test-consistency-window.js   # Test 1
├── test-burst.js                # Test 2
├── test-throughput-latency.js   # Test 3
├── test-lambda-throughput.js    # Test 4
├── test-ws-reconnection.js      # Test 5
├── test-resilience.js           # Test 6
├── generate-report.js           # Reads results/*.json → produces RESULTS.md
├── run-all.sh                   # Runs all tests + generates report
├── package.json
├── RESULTS.md                   # Generated report (commit after running)
└── results/                     # Raw JSON results (gitignored)
```

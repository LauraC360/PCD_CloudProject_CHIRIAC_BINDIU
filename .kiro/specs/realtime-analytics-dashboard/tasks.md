# Implementation Tasks — Realtime Analytics Dashboard

## Overview

Tasks are ordered by dependency. Each task maps directly to requirements and design sections. Complete tasks in order — later tasks depend on earlier ones.

**Stack summary:**
- Service A: TypeScript / Fastify v5 / MongoDB (Fast Lazy Bee, already cloned in `service-a/`)
- Event Processor: Node.js / AWS Lambda
- WebSocket Gateway: Node.js / `ws` library / ECS Fargate
- Frontend: HTML + Vanilla JS + Tailwind CSS (CDN) + Chart.js (CDN) hosted on S3
- Infrastructure: AWS SQS, DynamoDB, Lambda, ECS Fargate, ECR, S3, CloudWatch

---

## Task 1: AWS Infrastructure Provisioning

- [ ] 1.1 Create SQS Standard Queue `view-events` with `VisibilityTimeout=60s`, `maxReceiveCount=3`, message retention 4 days
- [ ] 1.2 Create SQS Dead Letter Queue `view-events-dlq` with message retention of 4 days and attach it to `view-events`
- [ ] 1.3 Create DynamoDB table `MovieStats` with partition key `movieId` (String), billing mode `PAY_PER_REQUEST`; add attribute `pk` (String) to every item for GSI support; create GSI `viewCount-index` with partition key `pk` (String) and sort key `viewCount` (Number), projection `ALL`
- [ ] 1.4 Create DynamoDB table `ProcessedEvents` with partition key `requestId` (String), billing mode `PAY_PER_REQUEST`, TTL enabled on attribute `ttl`
- [ ] 1.5 Create IAM role for Lambda (`event-processor-role`) with policies: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`, `sqs:ChangeMessageVisibility`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:GetItem`, `cloudwatch:PutMetricData`, `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`
- [ ] 1.6 Create IAM role for ECS tasks (`ecs-task-role`) with policies: `sqs:SendMessage`, `dynamodb:Query`, `dynamodb:GetItem`
- [ ] 1.7 Create two ECR repositories: `service-a` and `websocket-gateway`
- [ ] 1.8 Create S3 bucket for Dashboard static hosting with public read access and static website hosting enabled
- [ ] 1.9 Document all provisioned resource ARNs, queue URLs, table names, and bucket name in `infrastructure/resources.md`

**Validates:** Requirements 2, 4, 10

---

## Task 2: Service A — SQS Plugin

- [x] 2.1 Install `@aws-sdk/client-sqs` as a production dependency in `service-a/`
- [x] 2.2 Create `service-a/src/plugins/sqs.ts` as a `fastify-plugin` (`fp`) that:
  - Initialises `SQSClient` using `fastify.config.AWS_REGION`
  - Exposes `fastify.sqsPublisher.publish(event: ViewEvent): void` — fire-and-forget, no `await`
  - Maintains in-memory counters: `totalPublished`, `publishErrors`, `totalPublishLatencyMs` (for rolling average)
  - On SQS error: increments `publishErrors`, logs at `ERROR` level with `movieId` and `requestId`, does not throw
  - Declares `dependencies: ['server-config']` so `fastify.config` is available at registration time
- [x] 2.3 Define the `ViewEvent` TypeScript interface in `service-a/src/types/resources.d.ts` (or a new `view-event.ts`): `{ schemaVersion: string; requestId: string; movieId: string; publishedAt: string }`
- [x] 2.4 Add `SQS_QUEUE_URL: Type.String()` and `AWS_REGION: Type.String({ default: 'us-east-1' })` to the TypeBox schema in `service-a/src/schemas/dotenv.ts`
- [x] 2.5 Register the SQS plugin in `service-a/src/plugins/` so `@fastify/autoload` picks it up automatically (file naming follows existing plugin convention)
- [ ] 2.6 Write unit tests in `service-a/src/test/` for the SQS plugin using a mocked `SQSClient`:
  - Verify `publish()` calls `SendMessageCommand` with correct `MessageBody` JSON
  - Verify `publishErrors` increments when `SQSClient.send()` rejects
  - Verify `totalPublished` increments on success
  - Verify the method returns immediately without awaiting (fire-and-forget)

**Validates:** Requirements 1, 9 (R1.1–R1.4)

---

## Task 3: Service A — Movie Route Extension and Metrics Endpoint

- [x] 3.1 Modify `service-a/src/routes/movies/movie_id/movie-id-routes.ts`: in the `GET /movies/:movie_id` handler, after `this.dataStore.fetchMovie(params.movie_id)` succeeds, call `this.sqsPublisher.publish({ schemaVersion: '1.0', requestId: crypto.randomUUID(), movieId: params.movie_id, publishedAt: new Date().toISOString() })` without `await`, then send the reply — the 404 path is already handled by `genNotFoundError` throwing before this line
- [x] 3.2 Add `sqsPublisher` to the Fastify instance type declaration in `service-a/src/types/fastify.d.ts` so TypeScript resolves `this.sqsPublisher` inside route handlers
- [x] 3.3 Create `service-a/src/routes/metrics/metrics-routes.ts` with a `GET /metrics` handler that reads `fastify.sqsPublisher.getMetrics()` and returns `{ totalPublished, publishErrors, avgPublishLatencyMs }`
- [ ] 3.4 Write unit tests for the modified `GET /movies/:movie_id` route:
  - Verify `sqsPublisher.publish` is called with correct `movieId` on a 200 response
  - Verify `sqsPublisher.publish` is NOT called on a 404 response
  - Verify the HTTP response is returned even when `sqsPublisher.publish` throws internally
- [ ] 3.5 Write unit tests for `GET /metrics`:
  - Verify the response shape matches `{ totalPublished, publishErrors, avgPublishLatencyMs }`
  - Verify values reflect the mock counters from `sqsPublisher.getMetrics()`
- [ ] 3.6 Write property-based test **P4 (Serialization Round-Trip)** using `fast-check` in `service-a/src/test/`:
  - Generate random `ViewEvent` objects with arbitrary `movieId` and `requestId` strings
  - Serialize to JSON (as `SendMessageCommand.MessageBody`) and parse back
  - Assert all four fields (`schemaVersion`, `requestId`, `movieId`, `publishedAt`) are identical after round-trip
  - Tag: `// Feature: realtime-analytics-dashboard, Property 4: Serialization Round-Trip`
  - Minimum 100 iterations

**Validates:** Requirements 1.1–1.4, 7.1

---

## Task 4: Service A — Dockerfile and Local Verification

- [ ] 4.1 Create `service-a/Dockerfile` using a two-stage build: stage 1 runs `npm ci` + `npm run build` (TypeScript compile); stage 2 copies `dist/` and runs `npm ci --omit=dev`, exposes port 3000, CMD `node dist/src/server.js`
- [ ] 4.2 Create `service-a/.env.example` documenting all required environment variables: `NODE_ENV`, `APP_PORT`, `MONGO_URL`, `MONGO_DB_NAME`, `SQS_QUEUE_URL`, `AWS_REGION`
- [ ] 4.3 Verify `npm run build` completes without TypeScript errors in `service-a/`
- [ ] 4.4 Verify `NODE_ENV=test npm run dev` starts the server (Testcontainers spins up MongoDB automatically) and `GET /api/v1/movies/:movie_id` returns a 200 with movie data
- [ ] 4.5 Run `npm test` in `service-a/` and verify all existing tests plus the new SQS plugin and route tests pass, meeting the coverage thresholds (branches 50%, functions/lines/statements 90%)

**Validates:** Requirements 1, 10.6

---

## Task 5: Event Processor — Lambda Function

- [ ] 5.1 Create `event-processor/` directory with `package.json` (Node.js, `"type": "module"` or CommonJS — match Lambda runtime Node.js 22.x)
- [ ] 5.2 Install production dependencies: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-cloudwatch`
- [ ] 5.3 Create `event-processor/src/handler.js` — main Lambda handler that:
  - Iterates over `event.Records` (SQS batch, up to 5 messages per requirements)
  - Parses JSON body; validates required fields (`schemaVersion`, `requestId`, `movieId`, `publishedAt`)
  - Returns `{ batchItemFailures: [{ itemIdentifier: record.messageId }] }` for failed items (`ReportBatchItemFailures`)
- [ ] 5.4 Create `event-processor/src/lib/idempotency.js`:
  - `PutItem` on `ProcessedEvents` with `ConditionExpression: 'attribute_not_exists(requestId)'`
  - Sets `ttl = Math.floor(Date.now() / 1000) + 86400`
  - Returns `true` if new event, `false` if duplicate (`ConditionalCheckFailedException`)
- [ ] 5.5 Create `event-processor/src/lib/statsWriter.js`:
  - `UpdateItem` on `MovieStats`: `ADD viewCount :one SET pk = :pk, lastViewedAt = :ts, updatedAt = :now`
  - Sets `pk = 'STATS'` on every write to support the GSI query in the Gateway
- [ ] 5.6 Create `event-processor/src/lib/gatewayNotifier.js`:
  - `POST` to `GATEWAY_INTERNAL_URL/internal/notify` with `{ movieId, viewCount, publishedAt }`
  - On failure: logs `WARN` with error message; does NOT throw (non-fatal — SQS batch must still succeed)
- [ ] 5.7 Create `event-processor/src/lib/metrics.js`:
  - Publishes `EventsProcessed` (count), `EventsFailed` (count), `EventProcessingDuration` (ms) to CloudWatch Metrics namespace `RealTimeAnalytics`
- [ ] 5.8 Wire all modules in `handler.js`: for each record → idempotency check → stats write → gateway notify; collect failures; publish metrics once per batch
- [ ] 5.9 Write unit tests (Jest) for `idempotency.js`: mock `DynamoDBDocumentClient`; verify new event returns `true`, duplicate returns `false`
- [ ] 5.10 Write unit tests for `statsWriter.js`: mock `DynamoDBDocumentClient`; verify `UpdateExpression` contains `ADD viewCount :one` and `pk = 'STATS'` is set
- [ ] 5.11 Write unit tests for `handler.js`:
  - Verify malformed JSON is caught and returned in `batchItemFailures`
  - Verify duplicate `requestId` is skipped without calling `statsWriter`
  - Verify gateway notify failure does NOT cause the message to appear in `batchItemFailures`
- [ ] 5.12 Write property-based tests using `fast-check`:
  - **P1 (Counter Invariant)**: generate N distinct `requestId` events for same `movieId`; mock DynamoDB accumulator; verify final `viewCount` = N — Tag: `// Feature: realtime-analytics-dashboard, Property 1: Counter Invariant`
  - **P2 (Idempotency)**: generate one event duplicated K times; verify final `viewCount` = 1 — Tag: `// Feature: realtime-analytics-dashboard, Property 2: Idempotency`
  - **P3 (Movie Isolation)**: generate events for two random `movieId`s; verify counts are independent — Tag: `// Feature: realtime-analytics-dashboard, Property 3: Movie Isolation`
  - **P6 (Invalid Input Rejection)**: generate arbitrary strings as SQS message bodies; verify no DynamoDB write occurs — Tag: `// Feature: realtime-analytics-dashboard, Property 6: Invalid Input Rejection`
  - Each property runs minimum 100 iterations
- [ ] 5.13 Create `event-processor/.env.example` documenting: `DYNAMODB_TABLE_STATS`, `DYNAMODB_TABLE_EVENTS`, `GATEWAY_INTERNAL_URL`, `AWS_REGION`
- [ ] 5.14 Create `event-processor/deploy.sh`: zips `src/` + `node_modules/` + `package.json` and runs `aws lambda update-function-code --function-name event-processor --zip-file fileb://function.zip`

**Validates:** Requirements 3, 4, 9 (R3.1–R3.6, R4.1–R4.4, R9.1–R9.2)

---

## Task 6: WebSocket Gateway

- [x] 6.1 Create `websocket-gateway/` directory with `package.json`
- [x] 6.2 Install dependencies: `ws`, `express`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-dynamodb`
- [x] 6.3 Create `websocket-gateway/src/connectionManager.js`:
  - Wraps `wss.clients` (the native `Set` from the `ws` library)
  - Exposes `broadcast(message)` — iterates `wss.clients`, sends to each client with `readyState === WebSocket.OPEN`
  - Exposes `getCount()` — returns `wss.clients.size`
- [x] 6.4 Create `websocket-gateway/src/statsQuery.js`:
  - Queries DynamoDB `MovieStats` GSI (`pk = 'STATS'`, `ScanIndexForward: false`, `Limit: 10`)
  - Returns array of `{ movieId, viewCount, lastViewedAt }`
- [x] 6.5 Create `websocket-gateway/src/backpressure.js`:
  - Sliding-window counter (1-second window) tracking incoming notification rate
  - `record()`: increments counter; activates backpressure if count > 100
  - `isActive()`: returns boolean
  - When active: coalesces pending updates; fires one consolidated push per second via `setInterval`
  - When rate drops ≤ 100 for 3 consecutive seconds: deactivates, cancels timer
- [x] 6.6 Create `websocket-gateway/src/wsServer.js` — sets up `ws.Server` on path `/ws`:
  - `connection` event: query top-10; send `initial_state` message with `{ type, deliveredAt, connectedClients, top10 }`; broadcast updated `connectedClients` count to all other clients
  - `close`/`error` event: broadcast updated `connectedClients` count
- [x] 6.7 Create `websocket-gateway/src/httpServer.js` — Express app with two routes:
  - `GET /health` → `{ status: 'ok', connectedClients: connectionManager.getCount(), backpressureActive: backpressure.isActive() }`
  - `POST /internal/notify` → validates payload `{ movieId, viewCount, publishedAt }`; calls `backpressure.record()`; if not throttled: queries top-10, stamps `deliveredAt = new Date().toISOString()`, calls `connectionManager.broadcast(stats_update)`; logs `WARN` if `Date.parse(deliveredAt) - Date.parse(publishedAt) > 2000`; returns HTTP 400 on invalid payload
- [x] 6.8 Create `websocket-gateway/src/index.js` — starts both the WebSocket server (port `PORT`, default 8080) and the HTTP server (port `INTERNAL_PORT`, default 8081)
- [ ] 6.9 Write unit tests for `backpressure.js`:
  - Verify activation when > 100 events/s
  - Verify deactivation after rate drops for 3 consecutive seconds
- [ ] 6.10 Write unit tests for `httpServer.js` `/internal/notify`:
  - Verify `stats_update` broadcast is called with correct shape
  - Verify HTTP 400 on missing `movieId`
  - Verify latency `WARN` log when `deliveredAt - publishedAt > 2000ms`
- [ ] 6.11 Write property-based test **P5 (Monotonically Non-Decreasing)** using `fast-check`:
  - Generate a sequence of `viewCount` values; mock `statsQuery` to return them in order
  - Verify each broadcast has `viewCount` ≥ previous for same `movieId`
  - Tag: `// Feature: realtime-analytics-dashboard, Property 5: Monotonically Non-Decreasing`
- [ ] 6.12 Write property-based test **P7 (Backpressure Coalescing)** using `fast-check`:
  - Generate N > 100 notifications within 1 second
  - Verify each mock client receives exactly 1 `stats_update` message
  - Tag: `// Feature: realtime-analytics-dashboard, Property 7: Backpressure Coalescing`
- [x] 6.13 Create `websocket-gateway/Dockerfile` (multi-stage build, non-root user, exposes ports 8080 and 8081)
- [x] 6.14 Create `websocket-gateway/.env.example` documenting: `DYNAMODB_TABLE_STATS`, `AWS_REGION`, `PORT`, `INTERNAL_PORT`

**Validates:** Requirements 5, 9.2 (R5.1–R5.6)

---

## Task 7: Frontend — Dashboard

- [ ] 7.1 Create `frontend/index.html` with semantic structure: header with connection status badge, top-movies table, connected-users counter, recent activity feed, latency chart container; load Tailwind CSS and Chart.js from CDN (no build step)
- [ ] 7.2 Create `frontend/app.js` — WebSocket client:
  - Connects to `ws://<GATEWAY_HOST>/ws` on page load (host read from `window.GATEWAY_WS_URL` or a `<script>` config block)
  - Dispatches `initial_state` and `stats_update` messages to `dashboard.js` and `latencyChart.js`
  - Implements exponential backoff reconnection: initial 1000ms, multiplier 2, cap 30000ms, max 10 attempts
  - Displays "Reconnecting..." badge during attempts; "Connection lost. Please refresh the page." after 10 failures
- [ ] 7.3 Create `frontend/dashboard.js` — DOM update module:
  - `renderTop10(top10)`: updates the movies table (sorted descending by `viewCount`)
  - `renderConnectedClients(count)`: updates the counter element
  - `renderActivityFeed(event)`: prepends `{ movieId, lastViewedAt }` to feed; keeps last 20 items
  - All DOM updates complete within 500ms of message receipt (per Requirement 6.2)
- [ ] 7.4 Create `frontend/latencyChart.js` — latency percentile module:
  - `addSample(publishedAt, deliveredAt)`: computes `latencyMs`, pushes to `latencySamples`, prunes samples older than 60s; skips if `publishedAt` is missing
  - `getPercentiles()`: returns `{ p50, p95, p99 }` from sorted `latencyMs` values using index-based selection
  - `renderChart(canvas, percentiles)`: renders p50/p95/p99 as a Chart.js line chart on the provided `<canvas>` element; updates on each `stats_update`
- [ ] 7.5 Write unit tests for `latencyChart.js` (using Jest + jsdom or plain Node):
  - Verify p50/p95/p99 calculation for known sample sets
  - Verify samples older than 60s are pruned
  - Verify `addSample` skips entries with missing `publishedAt`
- [ ] 7.6 Write unit tests for `dashboard.js`:
  - Verify activity feed keeps max 20 items
  - Verify top-10 table renders correct number of rows sorted by `viewCount` descending
- [ ] 7.7 Upload `frontend/` to the S3 bucket created in Task 1.8 with `aws s3 sync ./frontend s3://<BUCKET_NAME>/ --delete`

**Validates:** Requirements 6 (R6.1–R6.7)

---

## Task 8: Deployment

- [ ] 8.1 Build and push Service A Docker image to ECR `service-a` repository
- [ ] 8.2 Create ECS Fargate cluster (if not already existing)
- [ ] 8.3 Create ECS Task Definition for Service A: inject `SQS_QUEUE_URL`, `MONGODB_URI` (MongoDB Atlas connection string), `MONGO_DB_NAME`, `AWS_REGION` as environment variables from AWS Systems Manager Parameter Store or Secrets Manager — no hardcoded values
- [ ] 8.4 Create ECS Service for Service A (min 1 task, public subnet, security group allowing inbound on port 3000)
- [ ] 8.5 Build and push WebSocket Gateway Docker image to ECR `websocket-gateway` repository
- [ ] 8.6 Create ECS Task Definition for WebSocket Gateway: inject `DYNAMODB_TABLE_STATS`, `AWS_REGION`, `PORT=8080`, `INTERNAL_PORT=8081`
- [ ] 8.7 Create ECS Service for WebSocket Gateway (min 1 task, public subnet, security group allowing inbound on ports 8080 and 8081)
- [ ] 8.8 Deploy Lambda function `event-processor` using `deploy.sh`: set timeout 30s, memory 256MB, runtime `nodejs22.x`; configure SQS event source mapping with batch size 5 and `ReportBatchItemFailures`; inject `DYNAMODB_TABLE_STATS`, `DYNAMODB_TABLE_EVENTS`, `GATEWAY_INTERNAL_URL`, `AWS_REGION`
- [ ] 8.9 Verify end-to-end smoke test: call `GET /api/v1/movies/:movie_id` on deployed Service A; confirm a `stats_update` message arrives on a connected WebSocket client within 5 seconds

**Validates:** Requirements 10 (R10.1–R10.6)

---

## Task 9: Integration and Load Testing

- [ ] 9.1 Create `tests/integration/e2e.js`:
  - Connects a WebSocket client to the Gateway
  - Calls `GET /api/v1/movies/:movie_id` on Service A
  - Asserts a `stats_update` message is received within 500ms with `viewCount` ≥ 1
- [ ] 9.2 Create `tests/integration/dlq-test.js`:
  - Publishes a malformed SQS message directly to `view-events`
  - Waits for `maxReceiveCount` retries (≈ 3 × 60s visibility timeout)
  - Asserts the message appears in `view-events-dlq`
- [ ] 9.3 Install Artillery globally (`npm install -g artillery`) and create `tests/load/load-test.yml`:
  - Ramp-up profile: 0 → 200 virtual users over 30s, hold 200 users for 60s
  - Target: `GET /api/v1/movies/:movie_id` on deployed Service A
  - Assertions: p99 HTTP latency < 200ms, error rate < 0.1%
- [ ] 9.4 Run load test against deployed environment; save Artillery HTML report to `tests/load/report.html`
- [ ] 9.5 During load test, monitor the frontend latency chart; capture screenshot showing p50/p95/p99 values for the scientific report
- [ ] 9.6 Verify backpressure activates: run load test at > 100 req/s; check `GET /health` returns `backpressureActive: true`; verify connected clients receive ≤ 1 push/s
- [ ] 9.7 Test WebSocket reconnection: stop the Gateway ECS task; verify frontend shows "Reconnecting..."; restart task; verify frontend reconnects and receives `initial_state`

**Validates:** Requirements 7, 8 (R7.1–R7.3, R8.1–R8.4)

---

## Task 10: Observability Verification

- [ ] 10.1 Verify CloudWatch Logs contain Lambda log entries with `requestId`, `movieId`, `processingDurationMs`, `status` for each processed event
- [ ] 10.2 Verify CloudWatch Metrics namespace `RealTimeAnalytics` contains `EventsProcessed`, `EventsFailed`, `EventProcessingDuration` after a load test run
- [ ] 10.3 Verify `GET /api/v1/metrics` on Service A returns correct `totalPublished`, `publishErrors`, `avgPublishLatencyMs` after a load test run
- [ ] 10.4 Verify `GET /health` on Gateway returns correct `connectedClients` count and `backpressureActive` flag
- [ ] 10.5 Measure and document the consistency window: record the time between a DynamoDB write (Lambda log timestamp) and the corresponding WebSocket push (Gateway log timestamp) across 100 events; compute average and p95; include in the scientific report

**Validates:** Requirements 7, 8 (R7.2–R7.3, R8.2)

---

## Task 11: Final Cleanup and Documentation

- [ ] 11.1 Ensure all `.env.example` files are complete and match the environment variables documented in `README.md`
- [ ] 11.2 Verify `README.md` includes: architecture diagram (Mermaid), step-by-step deploy instructions, how to run tests locally, how to run load tests, how to access the dashboard URL
- [ ] 11.3 Run all unit and property-based tests locally across all services; ensure all pass
- [ ] 11.4 Remove any hardcoded AWS account IDs, ARNs, queue URLs, or credentials from source code
- [ ] 11.5 Tag the final commit and push to GitHub

**Validates:** Requirements 10.5

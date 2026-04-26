# Implementation Tasks — Realtime Analytics Dashboard

> ⚠️ **IMPORTANT — Personal Project, No Amazon Internal Tools**
> This is a personal university project. Do NOT use any Amazon-internal tools, systems, or commands at any point.
> Forbidden: `brazil`, `brazil-build`, `brazil-recursive-cmd`, `cr`, `cdk` (Amazon internal), `mwinit`, `kinit`, or any other Amazon internal CLI tool.
> Use only standard open-source tooling: `npm`, `node`, `tsc`, `jest`, `aws` (AWS CLI with `--profile pers`), `cdk` (AWS CDK open-source), `docker`, `git`.

## Overview

Tasks are split into two parallel tracks:
- **Your track (Ana)**: CDK infrastructure + integration
- **Laura's track**: Service implementations (Service A fixes, Lambda, WSG, Frontend)

Complete CDK foundation tasks first — they produce the resource ARNs and URLs that Laura needs to wire up env vars.

**AWS CLI configuration:**
- Profile: `pers` — use `--profile pers` on all AWS CLI commands
- Region: `us-east-1` — use `--region us-east-1` or set `AWS_REGION=us-east-1`
- Example: `aws sqs list-queues --profile pers --region us-east-1`
- CDK: `cdk deploy --profile pers`

**Stack:**
- Service A: TypeScript / Fastify v5 / MongoDB → AWS App Runner
- Event Processor: Node.js → AWS Lambda
- WebSocket Gateway: Node.js / `ws` → AWS ECS Fargate
- Frontend: HTML + Vanilla JS + Chart.js (CDN) → S3 + CloudFront
- Infrastructure: AWS CDK (TypeScript) in `infra/`

---

## Track A: CDK Infrastructure (Ana)

### Task 1: CDK Foundation — Networking, Queues, Tables

- [x] 1.1 Initialise CDK app in `infra/` with TypeScript: `cdk init app --language typescript` inside the `infra/` directory
- [x] 1.2 Create VPC with 2 public + 2 private subnets across 2 AZs; no NAT Gateway needed (App Runner has outbound internet natively)
- [x] 1.3 Create SQS Standard Queue `view-events`: `visibilityTimeout=60s`, `retentionPeriod=4days`
- [x] 1.4 Create SQS Dead Letter Queue `view-events-dlq`: `retentionPeriod=4days`; attach to `view-events` with `maxReceiveCount=3`
- [x] 1.5 Create DynamoDB table `MovieStats`: PK `movieId` (String), billing `PAY_PER_REQUEST`; GSI `viewCount-index` with PK `pk` (String) + SK `viewCount` (Number), projection `ALL`
- [x] 1.6 Create DynamoDB table `ProcessedEvents`: PK `requestId` (String), billing `PAY_PER_REQUEST`, TTL on attribute `ttl`
- [x] 1.7 Create DynamoDB table `RecentActivity`: PK `pk` (String), SK `viewedAt` (Number), billing `PAY_PER_REQUEST`, TTL on attribute `ttl`
- [x] 1.8 Create AWS Cloud Map private DNS namespace `local` in the VPC; register service `wsg` so Lambda can reach the gateway at `http://wsg.local:8081`
- [x] 1.9 Export all resource ARNs, queue URLs, table names as CDK stack outputs; document in `infrastructure/resources.md`
- [x] 1.10 Create SSM Parameter Store entries (before `cdk deploy`): `/analytics/INTERNAL_SECRET` (SecureString, generate a random 32-char secret), `/analytics/MONGO_URL` (SecureString, MongoDB Atlas connection string); these are referenced by Lambda and App Runner CDK constructs
- [x] 1.11 Verify: `cdk deploy` completes without errors; confirm all 3 DynamoDB tables, 2 SQS queues, VPC, and Cloud Map namespace exist in AWS Console; check CDK stack outputs match `infrastructure/resources.md`

**Validates:** Requirements 2, 4, 10.10

> **CDK deploy commands (use these from `infra/` directory):**
> ```bash
> # 1. Create SSM parameters (one-time, before first deploy)
> bash infrastructure/ssm/create-ssm-params.sh
>
> # 2. Bootstrap CDK in your account (one-time per account/region)
> ./node_modules/.bin/cdk bootstrap --profile pers
>
> # 3. Deploy the stack
> ./node_modules/.bin/cdk deploy --profile pers
>
> # 4. View stack outputs
> aws cloudformation describe-stacks --stack-name InfraStack --profile pers --region us-east-1 --query "Stacks[0].Outputs"
> ```

---

### Task 2: CDK — Lambda Event Processor

- [x] 2.1 Create IAM role `event-processor-role`: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`, `sqs:ChangeMessageVisibility`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:GetItem`, `cloudwatch:PutMetricData`, `logs:*`
- [x] 2.2 Create Lambda function `event-processor`: runtime `nodejs22.x`, timeout 30s, memory 256MB, reserved concurrency 10; inject env vars `DYNAMODB_TABLE_STATS`, `DYNAMODB_TABLE_EVENTS`, `DYNAMODB_TABLE_RECENT_ACTIVITY`, `GATEWAY_INTERNAL_URL=http://wsg.local:8081`, `INTERNAL_SECRET` (from SSM), `AWS_REGION`, `SQS_BATCH_SIZE=10`; place in VPC private subnets
- [x] 2.3 Create SQS event source mapping: `view-events` → `event-processor`, batch size 10 (configurable via `SQS_BATCH_SIZE` env var), `ReportBatchItemFailures` enabled
- [x] 2.4 Add Lambda to same VPC security group that can reach the WSG Cloud Map service on port 8081
- [x] 2.5 Verify: Lambda function exists in AWS Console with correct timeout, memory, concurrency, and env vars; SQS event source mapping shows as `Enabled`; send a test SQS message and confirm Lambda invocation in CloudWatch Logs

**Validates:** Requirements 2.2, 3.1, 3.5, 14.2

---

### Task 3: CDK — ECS Fargate + ALB + ACM (WebSocket Gateway)

- [ ] 3.1 Create ECR repository `websocket-gateway`
- [ ] 3.2 Create ECS Fargate cluster
- [ ] 3.3 Create IAM task role `ecs-wsg-task-role`: `dynamodb:Query`, `dynamodb:GetItem`, `cloudwatch:PutMetricData`, `cloudwatch:GetMetricData`
- [ ] 3.4 Create ECS Task Definition for WSG: image from ECR `websocket-gateway`, 512 CPU / 1024 MB memory; inject env vars `DYNAMODB_TABLE_STATS`, `DYNAMODB_TABLE_RECENT_ACTIVITY`, `AWS_REGION`, `PORT=8080`, `INTERNAL_PORT=8081`, `COGNITO_JWKS_URL`, `INTERNAL_SECRET` (from SSM), `CLOUDWATCH_POLL_INTERVAL_MS=5000`, `CLOUDWATCH_METRICS_FLUSH_INTERVAL_MS=30000`
- [ ] 3.5 Create public ALB with HTTPS listener (port 443); request ACM certificate for WSG domain; add HTTP→HTTPS redirect on port 80; forward to target group on port 8080
- [ ] 3.6 Create ECS Fargate service: `desiredCount=1`, public subnet, security group allowing inbound 8080 from ALB + inbound 8081 from Lambda security group only (port 8081 NOT exposed via ALB)
- [ ] 3.7 Register WSG ECS service with Cloud Map under `wsg.local` so Lambda can resolve it via DNS
- [ ] 3.8 Verify: ECS service shows 1/1 running tasks; ALB health check passes; `curl https://<ALB_DOMAIN>/health` returns 200; port 8081 is NOT reachable from outside the VPC

**Validates:** Requirements 5.9, 5.10, 10.7

---

### Task 3.5: MongoDB Atlas Setup (Manual — before Task 4)

- [x] 3.5.1 Create a free MongoDB Atlas cluster at https://cloud.mongodb.com (M0 free tier is sufficient)
- [x] 3.5.2 Create a database user with read/write access to the movies database
- [x] 3.5.3 Set IP allowlist to `0.0.0.0/0` — required because App Runner has dynamic outbound IPs; a static allowlist is not feasible
- [x] 3.5.4 Copy the connection string (format: `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<dbname>?retryWrites=true&w=majority`)
- [~] 3.5.5 Store it in SSM: `bash infrastructure/ssm/create-ssm-params.sh --mongo` — paste the connection string when prompted (input is hidden, never stored in source)
- [~] 3.5.6 Verify: `aws ssm get-parameter --name /analytics/MONGO_URL --with-decryption --profile pers --region us-east-1` returns the parameter (value will be encrypted in output)

**Validates:** Requirements 10.9

---

### Task 4: CDK — App Runner + ECR (Service A)

- [ ] 4.1 Create ECR repository `service-a`
- [ ] 4.2 Create IAM role for App Runner instance: `sqs:SendMessage`, `cloudwatch:PutMetricData`
- [ ] 4.3 Create App Runner service from ECR `service-a` image; inject env vars `SQS_QUEUE_URL`, `AWS_REGION`, `MONGO_URL` (from SSM), `MONGO_DB_NAME`, `COGNITO_JWKS_URL`, `APP_PORT=3000`; configure auto-scaling (min 1, max 5 instances)
- [ ] 4.4 Create `service-a/Dockerfile` using two-stage build: stage 1 runs `npm ci` + `npm run build` (TypeScript compile); stage 2 copies `dist/` and runs `npm ci --omit=dev`, exposes port 3000, CMD `node dist/src/server.js`
- [ ] 4.5 Create `service-a/.env.example` documenting all required env vars: `NODE_ENV`, `APP_PORT`, `MONGO_URL`, `MONGO_DB_NAME`, `SQS_QUEUE_URL`, `AWS_REGION`, `COGNITO_JWKS_URL`
- [ ] 4.6 Verify: App Runner service shows status `Running`; `curl https://<APP_RUNNER_URL>/health` returns 200; `curl https://<APP_RUNNER_URL>/api/v1/movies` returns movie data (with valid JWT)

**Validates:** Requirements 10.6, 10.8, 10.9

---

### Task 5: CDK — Cognito User Pool

- [ ] 5.1 Create Cognito User Pool with email sign-in; configure hosted UI domain
- [ ] 5.2 Create app client (no client secret — SPA); set callback URLs for dashboard CloudFront domain
- [ ] 5.3 Output User Pool ID, app client ID, and JWKS endpoint URL as CDK stack outputs
- [ ] 5.4 After `cdk deploy`: manually create team member accounts and `loadtest@project.com` account via AWS Console — never hardcode in CDK
- [ ] 5.5 Verify: open Cognito hosted UI URL in browser — login page appears; log in with a test account; confirm JWT (ID token) is returned; decode JWT at jwt.io and confirm `iss` matches the User Pool

**Validates:** Requirements 13.1, 13.7

---

### Task 6: CDK — S3 + CloudFront (Frontend)

- [ ] 6.1 Create S3 bucket for frontend (block all public access; CloudFront OAC only)
- [ ] 6.2 Create CloudFront distribution: origin = S3 bucket, default root object `index.html`, HTTPS only; attach Cognito auth via Lambda@Edge or CloudFront function if time permits (otherwise Cognito hosted UI handles auth at app level)
- [ ] 6.3 Output CloudFront domain as CDK stack output
- [ ] 6.4 Verify: upload a test `index.html` to S3; confirm it's accessible via CloudFront URL but NOT directly via S3 URL (403 on direct S3 access)

**Validates:** Requirements 6.5, 10.2

---

### Task 7: CDK — Cost Protection

- [ ] 7.1 Create AWS Budget alert: monthly spend threshold $10, email notification
- [ ] 7.2 Set Lambda `event-processor` reserved concurrency to 10 (already done in Task 2.2 — verify)
- [ ] 7.3 Add `removalPolicy: DESTROY` to all DynamoDB tables and S3 bucket so `cdk destroy` cleans up fully after the presentation
- [ ] 7.4 Verify: AWS Budgets console shows the $10 alert configured; Lambda concurrency limit shows as 10 in AWS Console

**Validates:** Requirements 14.1, 14.2, 14.4

---

### Task 8: End-to-End Smoke Test

- [ ] 8.1 Deploy full CDK stack: `cdk deploy --all`
- [ ] 8.2 Build and push Service A Docker image to ECR; trigger App Runner redeploy
- [ ] 8.3 Build and push WSG Docker image to ECR; force ECS service update
- [ ] 8.4 Connect a WebSocket client to `wss://<ALB_DOMAIN>/ws` and verify `initial_state` is received
- [ ] 8.5 Call `GET /api/v1/movies/:movie_id` on App Runner URL with a valid Cognito JWT; verify a `stats_update` arrives on the WebSocket client within 5 seconds
- [ ] 8.6 Verify `MovieStats` DynamoDB item has `viewCount` incremented after the call
- [ ] 8.7 Verify `RecentActivity` DynamoDB has a new item with `pk = "ACTIVITY#<today>"`

**Validates:** Requirements 3.7, 5.4, 7.1

---

## Track B: Service Implementations (Laura)

### Task 9: Service A — Fix View Event Publishing

- [ ] 9.1 Merge `laura-dev` branch into `ana-dev` (or vice versa) to get the SQS plugin, metrics route, and WSG scaffolding
- [ ] 9.2 Fix `movie-id-routes.ts`: add `title: movie.title` to the `sqsPublisher.publish()` call
- [ ] 9.3 Fix `movie-id-routes.ts`: change `publishedAt: new Date().toISOString()` to `publishedAt: Number(request.headers['x-requested-at']) || Date.now()` (epoch ms)
- [ ] 9.4 Fix `resources.d.ts`: change `ViewEvent.publishedAt` type from `string` to `number`; add `title: string` field
- [ ] 9.5 Add `COGNITO_JWKS_URL: Type.String()` to `dotenv.ts` schema
- [ ] 9.6 Add Service A CloudWatch publishing: on each `GET /movies/:movie_id` call, publish `GetMovieInvocations` (count), `SqsPublishErrors` (count), `SqsPublishLatency` (ms) to CloudWatch namespace `AnalyticsDashboard` via `PutMetricData`; batch publishes to avoid per-request API calls (flush every 30s or on process exit)
- [ ] 9.7 Create `service-a/src/plugins/cognito-auth.ts`: register `@fastify/jwt` with the Cognito JWKS endpoint; add `preHandler` hook to validate JWT on all routes except `/health` and `/metrics`
- [ ] 9.8 Write unit tests: verify `sqsPublisher.publish` is called with correct `movieId`, `title`, and epoch ms `publishedAt` on 200 response; verify NOT called on 404
- [ ] 9.9 Write property-based test P4 (Serialization Round-Trip): generate random `ViewEvent` objects; serialize → deserialize; assert all fields identical including `title` and numeric `publishedAt`; tag `// Feature: realtime-analytics-dashboard, Property 4: Serialization Round-Trip`; minimum 100 iterations
- [ ] 9.10 Logging: ensure every significant action in Service A logs at appropriate level — `INFO` on successful SQS publish (with `movieId`, `requestId`), `ERROR` on SQS failure (with `movieId`, `requestId`, error message), `INFO` on server startup with port and environment, `WARN` on JWT validation failure with request path
- [ ] 9.11 Verify: run `npm test` in `service-a/` — all tests pass and coverage thresholds met
- [ ] 9.12 Verify: start server locally (`NODE_ENV=test npm run dev`), call `GET /api/v1/movies/:movie_id` with a valid movie ID, confirm SQS message appears in the queue via `aws sqs receive-message --queue-url <URL> --max-number-of-messages 1`
- [ ] 9.13 Verify: call `GET /metrics` and confirm `totalPublished` increments after each movie request

**Validates:** Requirements 1.1–1.5, 13.4

---

### Task 10: Event Processor — Lambda Implementation

- [ ] 10.1 Create `event-processor/src/handler.js` — main Lambda handler:
  - Runs idempotency checks for all events first (before any aggregation)
  - Aggregates view counts by `movieId` across non-duplicate events
  - One `UpdateItem` per `movieId` with `ADD viewCount :delta`
  - One `PutItem` per non-duplicate event to `RecentActivity` with `pk = "ACTIVITY#<YYYY-MM-DD>"`
  - Sends ONE `POST /internal/notify` per batch with `{ updates: [{ movieId, delta, publishedAt }] }` + `X-Internal-Secret` header
  - Uses `ReportBatchItemFailures` for failed items
- [ ] 10.2 Create `event-processor/src/lib/idempotency.js`: conditional `PutItem` on `ProcessedEvents`; returns `true` if new, `false` if duplicate
- [ ] 10.3 Create `event-processor/src/lib/statsWriter.js`: `UpdateItem` with `ADD viewCount :delta SET pk = :pk, lastViewedAt = :ts, updatedAt = :now, title = :title`
- [ ] 10.4 Create `event-processor/src/lib/recentActivityWriter.js`: `PutItem` to `RecentActivity` with day-scoped `pk`
- [ ] 10.5 Create `event-processor/src/lib/gatewayNotifier.js`: POST to gateway; on failure logs `WARN`, does NOT throw
- [ ] 10.6 Create `event-processor/src/lib/metrics.js`: publishes `BatchProcessingDuration`, `DuplicatesSkipped`, `DynamoWriteErrors` to CloudWatch namespace `AnalyticsDashboard`
- [ ] 10.7 Write unit tests: idempotency check, aggregation logic, batch failure reporting, gateway notify failure is non-fatal
- [ ] 10.8 Write property-based tests P1 (Counter Invariant), P2 (Idempotency), P3 (Movie Isolation), P6 (Invalid Input Rejection); tag each `// Feature: realtime-analytics-dashboard, Property N: <name>`; minimum 100 iterations each
- [ ] 10.9 Create `event-processor/package.json` with dependencies: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-cloudwatch`; devDependencies: `jest`, `fast-check`
- [ ] 10.10 Create `event-processor/.env.example` documenting: `DYNAMODB_TABLE_STATS`, `DYNAMODB_TABLE_EVENTS`, `DYNAMODB_TABLE_RECENT_ACTIVITY`, `GATEWAY_INTERNAL_URL`, `INTERNAL_SECRET`, `AWS_REGION`, `SQS_BATCH_SIZE`
- [ ] 10.11 Configure CDK `NodejsFunction` construct (or equivalent) to bundle and deploy Lambda code automatically on `cdk deploy`; alternatively create `event-processor/deploy.sh` that zips `src/` + `node_modules/` and runs `aws lambda update-function-code --function-name event-processor --zip-file fileb://function.zip`
- [ ] 10.12 Logging: ensure Lambda logs at `INFO` level for each batch — batch size received, number of duplicates skipped, number of unique movieIds aggregated, gateway notify success/failure; log at `ERROR` for DynamoDB write failures with `requestId` and `movieId`; log at `WARN` for gateway POST failure with status code
- [ ] 10.13 Verify: run `npm test` in `event-processor/` — all tests pass
- [ ] 10.14 Verify: manually invoke Lambda via AWS Console with a test SQS event payload (`{ "Records": [{ "body": "{\"schemaVersion\":\"1.0\",\"requestId\":\"test-uuid\",\"movieId\":\"tt0111161\",\"title\":\"Test\",\"publishedAt\":1234567890}" }] }`); confirm `MovieStats` item created/incremented in DynamoDB console
- [ ] 10.15 Verify: send the same event twice (same `requestId`); confirm `viewCount` only incremented once — idempotency working
- [ ] 10.16 Verify: check `ProcessedEvents` table has item with correct `requestId` and `ttl` ~24h from now; check `RecentActivity` table has item with `pk = "ACTIVITY#<today>"`

**Validates:** Requirements 3, 4, 9.1, 9.2, 11

---

### Task 11: WebSocket Gateway — Main Server

- [ ] 11.1 Fix `statsQuery.js`: add `title` to the returned item mapping
- [ ] 11.2 Create `websocket-gateway/src/recentActivityQuery.js`: query `RecentActivity` with `pk = "ACTIVITY#<today>"`, `ScanIndexForward: false`, `Limit: 20`
- [ ] 11.3 Create `websocket-gateway/src/cloudwatchPoller.js`: polls `GetMetricData` every `CLOUDWATCH_POLL_INTERVAL_MS` (5s); maintains rolling 1-hour buffer (720 data points); exposes `getLatest()` and `getHistory()`
- [ ] 11.4 Create `websocket-gateway/src/latencyTracker.js`: maintains rolling 60s window of `latencyMs` samples; computes p50/p95/p99; flushes to CloudWatch via `PutMetricData` every `CLOUDWATCH_METRICS_FLUSH_INTERVAL_MS` (30s)
- [ ] 11.5 Create `websocket-gateway/src/wsServer.js`:
  - On connect: validate Cognito JWT; send `initial_state` with top-10, recentActivity, `systemMetrics.history`; broadcast updated `connectedClients`
  - On close/error: remove client; broadcast updated `connectedClients`
  - Ping/pong keepalive every 30s; remove non-responding clients
- [ ] 11.6 Create `websocket-gateway/src/httpServer.js`:
  - `GET /health`: returns `{ status, connectedClients, backpressureActive }`
  - `POST /internal/notify` (port 8081): validates `X-Internal-Secret`; receives `{ updates: [...] }`; computes latency; serves from cache; broadcasts `stats_update` with `systemMetrics`
- [ ] 11.7 Create `websocket-gateway/src/index.js`: starts WS server (port 8080) and HTTP server (port 8081); starts CloudWatch poller and latency flush timer on startup
- [ ] 11.8 Write unit tests: connection lifecycle (mock ws), backpressure activation/deactivation, notify handler validates `X-Internal-Secret`, ping/pong cleanup removes non-responding clients, DynamoDB cache serves stale-while-revalidate
- [ ] 11.9 Write property-based tests P5 (Monotonically Non-Decreasing) and P7 (Backpressure Coalescing); tags `// Feature: realtime-analytics-dashboard, Property 5/7: ...`; minimum 100 iterations each
- [ ] 11.10 Create `websocket-gateway/.env.example` documenting: `DYNAMODB_TABLE_STATS`, `DYNAMODB_TABLE_RECENT_ACTIVITY`, `AWS_REGION`, `PORT`, `INTERNAL_PORT`, `COGNITO_JWKS_URL`, `INTERNAL_SECRET`, `CLOUDWATCH_POLL_INTERVAL_MS`, `CLOUDWATCH_METRICS_FLUSH_INTERVAL_MS`
- [ ] 11.11 Create `websocket-gateway/Dockerfile`: multi-stage build, non-root user, exposes ports 8080 and 8081
- [ ] 11.12 Logging: ensure WSG logs at `INFO` on client connect/disconnect (with client count), `INFO` on each `/internal/notify` received (batch size, latencyMs computed), `INFO` on each broadcast (connectedClients count), `WARN` when latency > 2000ms, `WARN` when backpressure activates/deactivates, `ERROR` on DynamoDB query failure, `WARN` on JWT rejection with reason
- [ ] 11.13 Verify: run `npm test` in `websocket-gateway/` — all tests pass
- [ ] 11.14 Verify: start WSG locally (`node src/index.js`), call `GET /health` — returns `{ status: "ok", connectedClients: 0, backpressureActive: false }`
- [ ] 11.15 Verify: connect a WebSocket client (e.g. `wscat -c ws://localhost:8080/ws`) — `initial_state` message received with `top10` and `recentActivity` arrays
- [ ] 11.16 Verify: POST to `http://localhost:8081/internal/notify` with `X-Internal-Secret` header and test payload — connected WebSocket client receives `stats_update` within 500ms
- [ ] 11.17 Verify: POST to `/internal/notify` without `X-Internal-Secret` header — returns HTTP 403

**Validates:** Requirements 5, 7, 9.2, 12, 13.5, 15

---

### Task 12: Frontend — Dashboard

- [ ] 12.1 Update `frontend/index.html` (file already exists in repo): add Cognito hosted UI redirect on load; store JWT in memory after login; add Chart.js and Tailwind CSS CDN links if not already present
- [ ] 12.2 Create `frontend/app.js`: WebSocket client connecting to `wss://<GATEWAY_HOST>/ws` with JWT as query param; dispatches messages; exponential backoff reconnection (1s start, ×2, cap 30s, max 10 attempts)
- [ ] 12.3 Create `frontend/dashboard.js`: renders top-10 list, recent activity feed, connected users count from `stats_update` and `initial_state`
- [ ] 12.4 Create `frontend/charts.js`: renders all Chart.js charts from `systemMetrics` data — latency p50/p95/p99 (from `systemMetrics.gateway.latencyP50/P95/P99`), throughput, Lambda metrics, SQS depth, ECS CPU/memory; appends data points to local history arrays; no client-side calculations
- [ ] 12.5 Wire Cognito JWT as `Authorization: Bearer` header on all `GET /movies/:id` HTTP requests
- [ ] 12.6 Write unit tests for `dashboard.js`: activity feed keeps max 20 items; top-10 renders correct rows sorted by `viewCount` descending; reconnection backoff timing
- [ ] 12.7 Upload to S3: `aws s3 sync ./frontend s3://<BUCKET_NAME>/ --delete`
- [ ] 12.8 Logging: ensure frontend logs to browser console — `INFO` on WebSocket connect/disconnect, `INFO` on each `initial_state` and `stats_update` received (with `ts`), `WARN` on reconnection attempt (with attempt number and backoff delay), `ERROR` after 10 failed reconnection attempts
- [ ] 12.9 Verify: open dashboard in browser — Cognito login redirect works; after login, WebSocket connects and `initial_state` renders top-10 list and activity feed
- [ ] 12.10 Verify: trigger a `GET /movies/:id` request (via browser or curl with JWT), confirm `stats_update` updates the dashboard UI within 500ms
- [ ] 12.11 Verify: disconnect from network briefly — dashboard shows "Reconnecting..." indicator; reconnect — dashboard reconnects and re-renders

**Validates:** Requirements 6, 13.2, 13.3, 16

---

## Track C: Load Testing + Observability

### Task 13: Load Testing Setup

- [ ] 13.1 Create `load-testing/` directory with `load-test.yml`: Artillery ramp-up 0→200 users over 30s, hold 60s; target `GET /api/v1/movies/:movie_id`; attach `Authorization: Bearer ${LOAD_TEST_TOKEN}` and `X-Requested-At: {{ $timestamp }}` headers
- [ ] 13.2 Create `load-testing/get-token.sh`: calls `aws cognito-idp initiate-auth` for `loadtest@project.com` and exports `LOAD_TEST_TOKEN`
- [ ] 13.3 Run load test locally against deployed environment; save HTML report to `load-testing/report.html`
- [ ] 13.4 Verify during load test: backpressure activates (`GET /health` returns `backpressureActive: true`); DLQ remains empty; CloudWatch latency percentiles appear in `systemMetrics.gateway` on the dashboard
- [ ] 13.5 DLQ integration test: publish a malformed SQS message directly to `view-events`; wait for `maxReceiveCount` retries (3 × 60s visibility timeout); assert the message appears in `view-events-dlq`
- [ ] 13.6 WebSocket reconnection test: stop the Gateway ECS task; verify frontend shows "Reconnecting..."; restart task; verify frontend reconnects and receives `initial_state` with full `systemMetrics.history`
- [ ] 13.7* (Bonus) Implement `latency_ack` round-trip: browser stamps `receivedAt = Date.now()` on each `stats_update` and sends `{ type: "latency_ack", publishedAt, receivedAt }` back to the Gateway; Gateway computes `fullLatencyMs = receivedAt - publishedAt` and publishes as CloudWatch metric `FullRoundTripLatency`

**Validates:** Requirements 8

---

### Task 14: Final Verification + Documentation

- [ ] 14.1 Run all unit and property-based tests across all services; all must pass
- [ ] 14.2 Verify CloudWatch namespace `AnalyticsDashboard` has all expected metrics after a load test run
- [ ] 14.3 Write root `README.md`: architecture overview, step-by-step deploy instructions (`cdk deploy`, ECR push, App Runner redeploy, ECS force update), how to run tests, how to run load tests, dashboard URL
- [ ] 14.4 Write per-service `README.md` files covering: what the service does, how to run locally, required env vars — for `service-a/`, `event-processor/`, `websocket-gateway/`, `frontend/`, and `load-testing/`
- [ ] 14.5 Remove any hardcoded ARNs, queue URLs, or credentials from source; verify `.gitignore` covers `.env` files
- [ ] 14.6 Run `cdk destroy` after presentation to tear down all resources

**Validates:** Requirements 10.5, 14.4

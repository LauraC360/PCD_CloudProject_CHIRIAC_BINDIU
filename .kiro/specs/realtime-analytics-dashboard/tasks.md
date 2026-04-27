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

- [x] 3.1 Create ECR repository `websocket-gateway`
- [x] 3.2 Create ECS Fargate cluster
- [x] 3.3 Create IAM task role `ecs-wsg-task-role`: `dynamodb:Query`, `dynamodb:GetItem`, `cloudwatch:PutMetricData`, `cloudwatch:GetMetricData`
- [x] 3.4 Create ECS Task Definition for WSG: image from ECR `websocket-gateway`, 512 CPU / 1024 MB memory; inject env vars `DYNAMODB_TABLE_STATS`, `DYNAMODB_TABLE_RECENT_ACTIVITY`, `AWS_REGION`, `PORT=8080`, `INTERNAL_PORT=8081`, `COGNITO_JWKS_URL`, `INTERNAL_SECRET` (from SSM), `CLOUDWATCH_POLL_INTERVAL_MS=5000`; add `CLOUDWATCH_METRICS_FLUSH_INTERVAL_MS=30000` only if latency tracker bonus (11.10) is implemented
- [x] 3.5 Add CloudFront distribution in front of the ALB for `wss://` support (no custom domain needed — CloudFront provides a free `*.cloudfront.net` HTTPS domain):
  - Create CloudFront distribution with ALB as HTTP origin (CloudFront → ALB on port 80 internally)
  - Add cache behavior for `/ws` path: forward all headers, disable caching, enable WebSocket support (`AllowedMethods: GET/HEAD`, `CachedMethods: GET/HEAD`, `CachePolicyId: CachingDisabled`)
  - Default behavior (`/*`) forwards to ALB as well (health check, internal notify not exposed)
  - Output CloudFront domain as `WsgCloudFrontDomain` — this is the public `wss://` endpoint for the frontend
  - Note: port 8081 (`/internal/notify`) is still only reachable from within the VPC via Lambda → Cloud Map, NOT via CloudFront
- [x] 3.6 Create ECS Fargate service: `desiredCount=1`, public subnet, security group allowing inbound 8080 from ALB + inbound 8081 from Lambda security group only (port 8081 NOT exposed via ALB)
- [x] 3.7 Register WSG ECS service with Cloud Map under `wsg.local` so Lambda can resolve it via DNS
- [x] 3.8 Verify: ECS service shows 1/1 running tasks; ALB health check passes; `curl http://<ALB_DOMAIN>/health` returns 200; `curl https://<CLOUDFRONT_DOMAIN>/health` returns 200; port 8081 is NOT reachable from outside the VPC

**Validates:** Requirements 5.9, 5.10, 10.7

---

### Task 3.5: MongoDB Atlas Setup (Manual — before Task 4)

- [x] 3.5.1 Create a free MongoDB Atlas cluster at https://cloud.mongodb.com (M0 free tier is sufficient)
- [x] 3.5.2 Create a database user with read/write access to the movies database
- [x] 3.5.3 Set IP allowlist to `0.0.0.0/0` — required because App Runner has dynamic outbound IPs; a static allowlist is not feasible
- [x] 3.5.4 Copy the connection string (format: `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<dbname>?retryWrites=true&w=majority`)
- [x] 3.5.5 Store it in SSM: `bash infrastructure/ssm/create-ssm-params.sh --mongo` — paste the connection string when prompted (input is hidden, never stored in source)
- [x] 3.5.6 Verify: `aws ssm get-parameter --name /analytics/MONGO_URL --with-decryption --profile pers --region us-east-1` returns the parameter (value will be encrypted in output)

**Validates:** Requirements 10.9

---

### Task 4: CDK — App Runner + ECR (Service A)

- [x] 4.1 Create ECR repository `service-a`
- [x] 4.2 Create IAM role for App Runner instance: `sqs:SendMessage`, `cloudwatch:PutMetricData`
- [x] 4.3 Create App Runner service from ECR `service-a` image; inject env vars `SQS_QUEUE_URL`, `AWS_REGION`, `MONGO_URL` (from SSM), `MONGO_DB_NAME`, `COGNITO_JWKS_URL`, `APP_PORT=3000`; configure auto-scaling (min 1, max 5 instances)
- [x] 4.4 Create `service-a/Dockerfile` using two-stage build: stage 1 runs `npm ci` + `npm run build` (TypeScript compile); stage 2 copies `dist/` and runs `npm ci --omit=dev`, exposes port 3000, CMD `node dist/src/server.js`
- [x] 4.5 Create `service-a/.env.example` documenting all required env vars: `NODE_ENV`, `APP_PORT`, `MONGO_URL`, `MONGO_DB_NAME`, `SQS_QUEUE_URL`, `AWS_REGION`, `COGNITO_JWKS_URL`
- [ ] 4.6 Verify: App Runner service shows status `Running`; `curl https://<APP_RUNNER_URL>/health` returns 200; `curl https://<APP_RUNNER_URL>/api/v1/movies` returns movie data (with valid JWT)

**Validates:** Requirements 10.6, 10.8, 10.9

---

### Task 5: CDK — Cognito User Pool

- [x] 5.1 Create Cognito User Pool with email sign-in; configure hosted UI domain
- [x] 5.2 Create app client (no client secret — SPA); set callback URLs for dashboard CloudFront domain
- [x] 5.3 Output User Pool ID, app client ID, and JWKS endpoint URL as CDK stack outputs
- [ ] 5.4 After `cdk deploy`: manually create team member accounts and `loadtest@project.com` account via AWS Console — never hardcode in CDK
- [ ] 5.5 Verify: open Cognito hosted UI URL in browser — login page appears; log in with a test account; confirm JWT (ID token) is returned; decode JWT at jwt.io and confirm `iss` matches the User Pool

**Validates:** Requirements 13.1, 13.7

---

### Task 6: CDK — S3 + CloudFront (Frontend)

- [x] 6.1 Create S3 bucket for frontend (block all public access; CloudFront OAC only)
- [ ] 6.2 Create CloudFront distribution with two origins:
  - **Origin 1 (default `/*`)**: S3 bucket via OAC — serves `index.html`, `app.js`, `dashboard.js`, `charts.js`
  - **Origin 2 (`/ws` path pattern)**: ALB HTTP origin — proxies WebSocket connections; disable caching, forward all headers, enable WebSocket
  - Default root object: `index.html`; HTTPS only (redirect HTTP → HTTPS)
  - Update Cognito app client callback URLs to include the CloudFront domain
- [x] 6.3 Output CloudFront domain as `FrontendCloudFrontDomain` CDK stack output
- [ ] 6.4 Verify: upload a test `index.html` to S3; confirm it's accessible via `https://<CLOUDFRONT_DOMAIN>/` but NOT directly via S3 URL (403 on direct S3 access); confirm `wscat -c wss://<CLOUDFRONT_DOMAIN>/ws` connects successfully

**Validates:** Requirements 6.5, 10.2

---

### Task 7: CDK — Cost Protection

- [x] 7.1 Create AWS Budget alert: monthly spend threshold $10, email notification
- [ ] 7.2 Set Lambda `event-processor` reserved concurrency to 10 (already done in Task 2.2 — verify)
- [x] 7.3 Add `removalPolicy: DESTROY` to all DynamoDB tables and S3 bucket so `cdk destroy` cleans up fully after the presentation
- [ ] 7.4 Verify: AWS Budgets console shows the $10 alert configured; Lambda concurrency limit shows as 10 in AWS Console

**Validates:** Requirements 14.1, 14.2, 14.4

---

### Task 8: End-to-End Smoke Test

- [ ] 8.1 Deploy full CDK stack: `cdk deploy --all`
- [ ] 8.2 Build and push Service A Docker image to ECR; trigger App Runner redeploy
- [ ] 8.3 Build and push WSG Docker image to ECR; force ECS service update
- [ ] 8.4 Connect a WebSocket client to `wss://<CLOUDFRONT_DOMAIN>/ws` and verify `initial_state` is received
- [ ] 8.5 Call `GET /api/v1/movies/:movie_id` on App Runner URL with a valid Cognito JWT; verify a `stats_update` arrives on the WebSocket client within 5 seconds
- [ ] 8.6 Verify `MovieStats` DynamoDB item has `viewCount` incremented after the call
- [ ] 8.7 Verify `RecentActivity` DynamoDB has a new item with `pk = "ACTIVITY#<today>"`

**Validates:** Requirements 3.7, 5.4, 7.1

---

## Track B: Service Implementations (Laura)

### Task 9: Service A — Fix View Event Publishing

- [x] 9.1 Merge `laura-dev` branch into `ana-dev` (or vice versa) to get the SQS plugin, metrics route, and WSG scaffolding
- [x] 9.2 Fix `movie-id-routes.ts`: add `title: movie.title` to the `sqsPublisher.publish()` call
- [x] 9.3 Fix `movie-id-routes.ts`: change `publishedAt: new Date().toISOString()` to `publishedAt: Number(request.headers['x-requested-at']) || Date.now()` (epoch ms)
- [x] 9.4 Fix `resources.d.ts`: change `ViewEvent.publishedAt` type from `string` to `number`; add `title: string` field
- [x] 9.5 Add `COGNITO_JWKS_URL: Type.String()` to `dotenv.ts` schema
- [x] 9.6 Add Service A CloudWatch publishing: on each `GET /movies/:movie_id` call, publish `GetMovieInvocations` (count), `SqsPublishErrors` (count), `SqsPublishLatency` (ms) to CloudWatch namespace `AnalyticsDashboard` via `PutMetricData`; batch publishes to avoid per-request API calls (flush every 30s or on process exit)
- [x] 9.7 Create `service-a/src/plugins/cognito-auth.ts`: register `@fastify/jwt` with the Cognito JWKS endpoint; add `preHandler` hook to validate JWT on all routes except `/health` and `/metrics`
- [x] 9.8 Write unit tests: verify `sqsPublisher.publish` is called with correct `movieId`, `title`, and epoch ms `publishedAt` on 200 response; verify NOT called on 404
- [x] 9.9 Write property-based test P4 (Serialization Round-Trip): generate random `ViewEvent` objects; serialize → deserialize; assert all fields identical including `title` and numeric `publishedAt`; tag `// Feature: realtime-analytics-dashboard, Property 4: Serialization Round-Trip`; minimum 100 iterations
- [x] 9.10 Logging: ensure every significant action in Service A logs at appropriate level — `INFO` on successful SQS publish (with `movieId`, `requestId`), `ERROR` on SQS failure (with `movieId`, `requestId`, error message), `INFO` on server startup with port and environment, `WARN` on JWT validation failure with request path
- [x] 9.11 Verify: run `npm test` in `service-a/` — all tests pass and coverage thresholds met
- [ ] 9.12 Verify: start server locally (`NODE_ENV=test npm run dev`), call `GET /api/v1/movies/:movie_id` with a valid movie ID, confirm SQS message appears in the queue via `aws sqs receive-message --queue-url <URL> --max-number-of-messages 1`
- [x] 9.13 Verify: call `GET /metrics` and confirm `totalPublished` increments after each movie request

**Validates:** Requirements 1.1–1.5, 13.4

---

### Task 10: Event Processor — Lambda Implementation

> **Gateway contract (current `httpServer.js`):** The gateway's `/internal/notify` endpoint expects one POST per movieId with body `{ movieId: string, viewCount: number, publishedAt: string (ISO 8601) }`. No `X-Internal-Secret` header is checked. The Lambda must send one POST per unique movieId after aggregating the batch — not a single batched payload.

- [x] 10.1 Create `event-processor/src/handler.js` — main Lambda handler:
  - Parse each SQS record body as JSON (`schemaVersion`, `requestId`, `movieId`, `title`, `publishedAt` epoch ms)
  - Run idempotency check for each event before any writes (skip duplicates)
  - Aggregate view counts by `movieId` across non-duplicate events (e.g. 3 events for movie A + 2 for movie B → `{ "movieA": 3, "movieB": 2 }`)
  - One `UpdateItem` per unique `movieId` on `MovieStats`: `ADD viewCount :delta SET pk = :pk, lastViewedAt = :ts, updatedAt = :now, title = :title`
  - One `PutItem` per non-duplicate event to `RecentActivity`: `pk = "ACTIVITY#<YYYY-MM-DD>"`, `viewedAt = publishedAt`, `movieId`, `title`, `ttl = Math.floor(Date.now()/1000) + 86400`
  - After all DynamoDB writes, send one `POST /internal/notify` per unique `movieId` to the gateway with body `{ movieId, viewCount: delta, publishedAt: new Date(publishedAt).toISOString() }` — `publishedAt` converted from epoch ms to ISO string to match the gateway's current validation (`typeof publishedAt !== 'string'`)
  - Uses `ReportBatchItemFailures`: collect `itemIdentifier` for any record that throws; return `{ batchItemFailures: [...] }`
- [ ] 10.2 Create `event-processor/src/lib/idempotency.js`: conditional `PutItem` on `ProcessedEvents` table with `attribute_not_exists(requestId)`; returns `true` if new (item written), `false` if duplicate (condition failed); sets `ttl = Math.floor(Date.now()/1000) + 86400`
- [x] 10.3 Create `event-processor/src/lib/statsWriter.js`: accepts `{ movieId, title, delta, lastViewedAt }`; runs `UpdateItem` with expression `ADD viewCount :delta SET pk = :pk, lastViewedAt = :ts, updatedAt = :now, title = :title`; `:pk = "STATS"` (required for the GSI `viewCount-index` that `statsQuery.js` queries with `pk = "STATS"`)
- [x] 10.4 Create `event-processor/src/lib/recentActivityWriter.js`: accepts a single event `{ movieId, title, publishedAt (epoch ms) }`; derives UTC date string `YYYY-MM-DD` from `publishedAt`; runs `PutItem` to `RecentActivity` with `pk = "ACTIVITY#<date>"`, `viewedAt = publishedAt`, `movieId`, `title`, `ttl`
- [x] 10.5 Create `event-processor/src/lib/gatewayNotifier.js`: accepts `{ movieId, viewCount, publishedAt (ISO string) }`; POSTs to `process.env.GATEWAY_INTERNAL_URL + "/internal/notify"` with `Content-Type: application/json`; on non-2xx or network error logs `WARN` with status code and movieId, does NOT throw (gateway notify is best-effort)
- [x] 10.6 Create `event-processor/src/lib/metrics.js`: publishes `BatchProcessingDuration` (ms), `DuplicatesSkipped` (count), `DynamoWriteErrors` (count) to CloudWatch namespace `AnalyticsDashboard` via `PutMetricData`; called once per handler invocation after all processing
- [x] 10.7 Write unit tests in `event-processor/src/__tests__/`:
  - `idempotency.test.js`: mock DynamoDB — first call returns success (new), second call throws `ConditionalCheckFailedException` (duplicate); assert return values
  - `handler.test.js`: mock all lib modules — assert aggregation produces correct `delta` per movieId; assert `statsWriter` called once per unique movieId; assert `recentActivityWriter` called once per non-duplicate event; assert `gatewayNotifier` called once per unique movieId with correct `{ movieId, viewCount: delta, publishedAt: ISO string }`; assert failed record appears in `batchItemFailures`
  - `gatewayNotifier.test.js`: mock `fetch` — assert non-2xx response logs WARN and does not throw; assert network error logs WARN and does not throw
- [x] 10.8 Write property-based tests in `event-processor/src/__tests__/properties.test.js`; tag each with `// Feature: realtime-analytics-dashboard, Property N: <name>`; minimum 100 iterations each:
  - P1 (Counter Invariant): generate N events for the same movieId; assert `statsWriter` is called with `delta = N`
  - P2 (Idempotency): generate a batch where some `requestId`s repeat; assert `viewCount` increments only for unique `requestId`s
  - P3 (Movie Isolation): generate events for multiple distinct movieIds; assert each movieId's delta is independent and correct
  - P6 (Invalid Input Rejection): generate records with missing/malformed `movieId` or `requestId`; assert they appear in `batchItemFailures` and do not affect other records
- [x] 10.9 Update `event-processor/package.json` — add dependencies: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-cloudwatch`; devDependencies: `jest`, `fast-check`; add `"test": "jest"` script
- [x] 10.10 Create `event-processor/.env.example` documenting all required env vars: `DYNAMODB_TABLE_STATS`, `DYNAMODB_TABLE_EVENTS`, `DYNAMODB_TABLE_RECENT_ACTIVITY`, `GATEWAY_INTERNAL_URL` (e.g. `http://wsg.local:8081`), `AWS_REGION`, `SQS_BATCH_SIZE`
- [x] 10.11 Create `event-processor/deploy.sh`: zips `src/` + `node_modules/` into `function.zip` and runs `aws lambda update-function-code --function-name event-processor --zip-file fileb://function.zip --profile pers --region us-east-1`
- [x] 10.12 Logging: `INFO` per batch — batch size received, duplicates skipped, unique movieIds aggregated; `INFO` per gateway notify — movieId, response status; `ERROR` for DynamoDB write failures — include `requestId` and `movieId`; `WARN` for gateway POST failure — include status code and movieId
- [x] 10.13 Verify: run `npm test` in `event-processor/` — all tests pass
- [ ] 10.14 Verify: manually invoke Lambda via AWS Console with test payload `{ "Records": [{ "messageId": "msg-1", "body": "{\"schemaVersion\":\"1.0\",\"requestId\":\"test-uuid-1\",\"movieId\":\"tt0111161\",\"title\":\"The Shawshank Redemption\",\"publishedAt\":1700000000000}" }] }`; confirm `MovieStats` item has `viewCount` incremented and `pk = "STATS"` in DynamoDB console
- [ ] 10.15 Verify: invoke Lambda twice with the same `requestId`; confirm `viewCount` incremented only once (idempotency); confirm `ProcessedEvents` has one item for that `requestId`
- [ ] 10.16 Verify: check `RecentActivity` table has item with `pk = "ACTIVITY#<today>"`, correct `movieId`, `title`, and `ttl` ~24h from now; check gateway CloudWatch Logs show the notify POST was received (or check `wscat` client receives `stats_update`)

**Validates:** Requirements 3, 4, 9.1, 9.2, 11

---

### Task 11: WebSocket Gateway — Main Server

> **Context:** The teammate has already implemented the core gateway skeleton (`wsServer.js`, `httpServer.js`, `connectionManager.js`, `backpressure.js`, `statsQuery.js`, `index.js`, `Dockerfile`). The backpressure logic and basic notify→broadcast loop are done. Tasks below are additions and fixes on top of that existing code.

> **Payload contract:** The Lambda sends `{ updates: [{ movieId, delta, publishedAt }] }` (array). The current `httpServer.js` expects a flat single-object payload. This must be aligned — see 11.2.

- [ ] 11.1 Fix `statsQuery.js`: add `title` to the returned item mapping (currently missing)
- [ ] 11.2 Fix `httpServer.js` — align `/internal/notify` payload with Lambda contract:
  - Change expected body from `{ movieId, viewCount, publishedAt }` to `{ updates: [{ movieId, delta, publishedAt }] }`
  - Validate that `updates` is a non-empty array; return 400 otherwise
  - Use `publishedAt` from the first update entry for latency logging
  - Pass the full `updates` array through to the broadcast payload
- [ ] 11.3 Fix `httpServer.js` — add `X-Internal-Secret` header validation: read secret from `process.env.INTERNAL_SECRET`; return HTTP 403 if header is missing or does not match
- [ ] 11.4 Fix `wsServer.js` — add `recentActivity` to `initial_state`:
  - Import and call `recentActivityQuery` on connect alongside `queryTop10`
  - Include `recentActivity` array in the `initial_state` message
- [ ] 11.5 Create `websocket-gateway/src/recentActivityQuery.js`: query `RecentActivity` table with `pk = "ACTIVITY#<today>"`, `ScanIndexForward: false`, `Limit: 20`; return array of `{ movieId, title, viewedAt }`
- [ ] 11.6 Fix `httpServer.js` — include `recentActivity` in `stats_update` broadcast: call `recentActivityQuery` alongside `queryTop10` on each `/internal/notify`; include result in the broadcast payload
- [ ] 11.7 Create `websocket-gateway/src/cloudwatchPoller.js`: polls `GetMetricData` every `CLOUDWATCH_POLL_INTERVAL_MS` (default 5000ms); fetches Lambda invocations/errors/duration, SQS queue depth (`ApproximateNumberOfMessagesVisible` on `view-events`), ECS CPU% and memory% for the WSG task; maintains a rolling 1-hour in-memory buffer (max 720 data points at 5s granularity); exposes `getLatest()` → single object and `getHistory()` → array
- [ ] 11.8 Wire `cloudwatchPoller` into `index.js`: start polling on startup; attach `getLatest()` result as `systemMetrics` on every `stats_update` broadcast; include `getHistory()` in `initial_state` as `systemMetrics.history`
- [ ] 11.9 Add `CLOUDWATCH_POLL_INTERVAL_MS` to `.env.example` (default 5000)
- [ ] 11.10* (TODO — bonus) Create `websocket-gateway/src/latencyTracker.js`: maintains rolling 60s window of `latencyMs` samples; computes p50/p95/p99 server-side; flushes to CloudWatch via `PutMetricData` every 30s as `EndToEndLatencyP50/P95/P99` under `AnalyticsDashboard` namespace; exposes `record(latencyMs)` and `getPercentiles()`
- [ ] 11.11* (TODO — bonus) Wire `latencyTracker` into `httpServer.js`: call `latencyTracker.record(latencyMs)` on each `/internal/notify`; attach `latencyTracker.getPercentiles()` into `systemMetrics.gateway` on each broadcast
- [ ] 11.12 Add ping/pong keepalive to `wsServer.js`: every 30s send a ping frame to all connected clients; remove clients that have not responded with a pong since the last ping interval
- [ ] 11.13 Update `websocket-gateway/.env.example`: add `INTERNAL_SECRET`, `COGNITO_JWKS_URL`, `DYNAMODB_TABLE_RECENT_ACTIVITY`, `CLOUDWATCH_POLL_INTERVAL_MS`
- [ ] 11.14 Write unit tests: notify handler rejects missing/wrong `X-Internal-Secret` (403), notify handler rejects invalid `updates` array (400), backpressure activation/deactivation (already implemented — add regression tests), ping/pong cleanup removes non-responding clients, CloudWatch poller `getLatest()` returns most recent data point
- [ ] 11.15 Write property-based tests P5 (Monotonically Non-Decreasing) and P7 (Backpressure Coalescing); tag `// Feature: realtime-analytics-dashboard, Property 5/7: ...`; minimum 100 iterations each
- [ ] 11.16 Logging: `INFO` on client connect/disconnect (with count), `INFO` on each `/internal/notify` (updates count, latencyMs), `INFO` on each broadcast (connectedClients), `WARN` when latency > 2000ms, `WARN` on backpressure activate/deactivate, `ERROR` on DynamoDB query failure, `WARN` on JWT rejection
- [ ] 11.17 Verify: `GET /health` returns `{ status: "ok", connectedClients: 0, backpressureActive: false }`
- [ ] 11.18 Verify: connect WebSocket client — `initial_state` received with `top10`, `recentActivity`, and `systemMetrics.history` arrays
- [ ] 11.19 Verify: POST to `http://localhost:8081/internal/notify` with correct `X-Internal-Secret` and `{ updates: [{ movieId: "tt0111161", delta: 1, publishedAt: <epoch ms> }] }` — connected client receives `stats_update` within 500ms
- [ ] 11.20 Verify: POST to `/internal/notify` without `X-Internal-Secret` — returns HTTP 403

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
  - Must include a **Prerequisites** section covering MongoDB Atlas setup:
    1. Create free M0 cluster at cloud.mongodb.com
    2. Load Sample Dataset (includes `sample_mflix` with movies collection)
    3. Create database user with read/write access
    4. Add `0.0.0.0/0` to IP allowlist (required for App Runner dynamic IPs)
    5. Copy connection string and store in SSM: `bash infrastructure/ssm/create-ssm-params.sh --mongo`
    6. Set `MONGO_DB_NAME=sample_mflix` in App Runner env vars
- [ ] 14.4 Write per-service `README.md` files covering: what the service does, how to run locally, required env vars — for `service-a/`, `event-processor/`, `websocket-gateway/`, `frontend/`, and `load-testing/`
- [ ] 14.5 Remove any hardcoded ARNs, queue URLs, or credentials from source; verify `.gitignore` covers `.env` files
- [ ] 14.6 Run `cdk destroy` after presentation to tear down all resources

**Validates:** Requirements 10.5, 14.4

# Requirements Document

## Introduction

This document defines the requirements for Project 1 — Real-Time Analytics Dashboard, a distributed system built on top of the Fast Lazy Bee movies REST API. The system collects movie view events, processes them asynchronously through a cloud-native pipeline, and displays live statistics on a browser-based dashboard. The architecture uses AWS-native services (SQS, Lambda, DynamoDB) and a custom WebSocket gateway to satisfy the university assignment's requirements for independent services, FaaS, real-time communication, and measurable performance metrics.

## Glossary

- **Fast_Lazy_Bee**: The base Node.js/Fastify/MongoDB movies REST API deployed on AWS App Runner, extended with event publishing.
- **SQS_Queue**: AWS SQS Standard Queue that receives view-event messages published by Fast_Lazy_Bee.
- **Dead_Letter_Queue**: AWS SQS queue that receives messages that have failed processing beyond the maximum retry threshold.
- **Event_Processor**: AWS Lambda function triggered by SQS_Queue that aggregates view counts and writes to DynamoDB.
- **MovieStats**: AWS DynamoDB table storing per-movie view counts with `movieId` as the partition key.
- **RecentActivity**: AWS DynamoDB table storing individual view events, time-sorted, with 1-day TTL.
- **ProcessedEvents**: AWS DynamoDB table used for idempotency deduplication, keyed by `requestId` with 24-hour TTL.
- **WebSocket_Gateway**: Custom Node.js server (ws library) running on ECS Fargate that maintains WebSocket connections with browser clients and receives HTTP POST notifications from Event_Processor.
- **Dashboard**: Static HTML/JS frontend hosted on S3 + CloudFront that connects to WebSocket_Gateway and renders real-time statistics using Chart.js.
- **View_Event**: A JSON message published to SQS_Queue each time a client calls `GET /movies/:id` on Fast_Lazy_Bee.
- **Batch**: A group of up to 10 View_Event messages delivered together to Event_Processor by SQS.
- **Connected_Users_Count**: The number of active WebSocket connections tracked in-memory by WebSocket_Gateway via `wss.clients.size`.

---

## Requirements

### Requirement 1: View Event Publishing

**User Story:** As a system operator, I want Fast_Lazy_Bee to publish a View_Event to SQS_Queue on every `GET /movies/:id` call, so that downstream services can process movie access data without coupling the route handler to analytics logic.

#### Acceptance Criteria

1. WHEN a client sends `GET /movies/:id` and Fast_Lazy_Bee returns a response, THE Fast_Lazy_Bee SHALL publish a View_Event message to SQS_Queue via a Fastify `onResponse` hook.
2. THE View_Event SHALL contain at minimum the `movieId`, `title`, a `requestId` (UUID v4 generated at publish time), a `publishedAt` timestamp (epoch ms), and a `schemaVersion` field.
3. THE `publishedAt` timestamp SHALL be read from the optional `X-Requested-At` request header (epoch ms) if present. IF the header is absent, THEN Fast_Lazy_Bee SHALL generate `publishedAt = Date.now()` itself. This allows callers (load testing tools, demo UI) to stamp the true request origin time for accurate end-to-end latency measurement.
4. IF SQS_Queue is unreachable when publishing, THEN THE Fast_Lazy_Bee SHALL log the error and return the original HTTP response to the client without modification.
5. THE Fast_Lazy_Bee SHALL publish View_Events only for successful responses (HTTP 2xx) to avoid counting error responses as views.

---

### Requirement 2: SQS Queue Configuration

**User Story:** As a system operator, I want the SQS_Queue to be configured for reliable at-least-once delivery with failure isolation, so that no view events are silently lost and repeated failures do not block the queue.

#### Acceptance Criteria

1. THE SQS_Queue SHALL be a Standard Queue with a visibility timeout of 60 seconds, exceeding the Event_Processor timeout of 30 seconds.
2. THE Lambda event source mapping batch size SHALL default to 10 messages per invocation and SHALL be configurable via an environment variable (`SQS_BATCH_SIZE`) to allow lower values (e.g. 3) during manual testing without redeployment.
3. WHEN a message fails processing more than the configured maximum retry count, THE SQS_Queue SHALL route the message to the Dead_Letter_Queue.
4. THE Dead_Letter_Queue SHALL retain failed messages for a minimum of 4 days to allow manual inspection.

---

### Requirement 3: Event Processing (Lambda)

**User Story:** As a system operator, I want Event_Processor to aggregate view counts from each Batch and write them atomically to MovieStats, so that parallel Lambda invocations do not produce data races or incorrect counts.

#### Acceptance Criteria

1. WHEN SQS_Queue delivers a Batch, THE Event_Processor SHALL be triggered automatically via an SQS event source mapping.
2. THE Event_Processor SHALL aggregate view counts within the Batch by `movieId` before writing to MovieStats (e.g., 3 events for movie A and 2 for movie B produce two writes, not five).
3. THE Event_Processor SHALL write aggregated counts to MovieStats using a DynamoDB `UpdateExpression` with an atomic `ADD` operation, without performing a read before the write.
4. IF a single message in a Batch fails processing, THEN THE Event_Processor SHALL report that message as a failure using `ReportBatchItemFailures` so that only the failed message is returned to SQS_Queue, not the entire Batch.
5. THE Event_Processor SHALL have a maximum execution timeout of 30 seconds.
6. FOR each successfully processed (non-duplicate) View_Event, THE Event_Processor SHALL write a record to the `RecentActivity` table containing `pk = "ACTIVITY#<YYYY-MM-DD>"` (UTC date at processing time), `viewedAt = publishedAt` (epoch ms), `movieId`, `title`, and `ttl = now + 86400`.
7. WHEN all messages in a Batch are processed successfully, THE Event_Processor SHALL send an HTTP POST notification to WebSocket_Gateway via its AWS Cloud Map DNS name (e.g. `http://wsg.local:8081/internal/notify`) containing the updated view counts. Lambda and the WSG SHALL be in the same VPC. Cloud Map provides a stable DNS name that survives task restarts without requiring a load balancer.

---

### Requirement 4: Analytics Storage (DynamoDB)

**User Story:** As a system operator, I want analytics data to persist durably and scale automatically with Lambda burst traffic, so that the system remains consistent under variable load.

#### Acceptance Criteria

1. THE `MovieStats` table SHALL use `movieId` (string) as the partition key with no sort key, and use on-demand capacity mode.
2. THE `MovieStats` table SHALL store a `viewCount` attribute (number) per item, incremented atomically by Event_Processor.
3. WHEN Event_Processor performs a concurrent `ADD` on the same `movieId` from multiple Lambda instances, THE `MovieStats` table SHALL reflect the correct total count without data loss.
4. A `MovieStats` GSI with partition key `pk = "STATS"` (fixed string on every item) and sort key `viewCount` (number) SHALL enable the gateway to query the top-10 movies sorted by view count descending. The GSI projection SHALL include `movieId`, `viewCount`, and `title`.
5. A separate `RecentActivity` table SHALL store individual view events with partition key `pk = "ACTIVITY#<YYYY-MM-DD>"` (UTC date, day-scoped to avoid hot partitions), sort key `viewedAt` (epoch ms), and attributes `movieId` and `title`.
6. THE `RecentActivity` table SHALL have a TTL of 86400 seconds (1 day) on each item — entries older than 24 hours are automatically deleted by DynamoDB.
7. THE gateway SHALL query `RecentActivity` with `ScanIndexForward: false` and `Limit: 20` to get the 20 most recent view events for the activity feed.
8. THE `ProcessedEvents` table SHALL use `requestId` (string) as the partition key, with a `ttl` attribute (Unix epoch seconds) for automatic expiry after 24 hours.

---

### Requirement 5: WebSocket Gateway

**User Story:** As a system operator, I want WebSocket_Gateway to maintain persistent connections with browser clients and broadcast real-time updates when Event_Processor reports new view counts, so that the Dashboard reflects current data without polling.

#### Acceptance Criteria

1. THE WebSocket_Gateway SHALL accept WebSocket connections from browser clients on port 8080.
2. EVERY `stats_update` message SHALL include a mandatory `ts` field containing the Unix timestamp in milliseconds (epoch ms) at the moment the gateway sends the message. The UI SHALL NOT generate or attach timestamps itself.
3. THE WebSocket_Gateway SHALL expose the Connected_Users_Count as part of every broadcast payload, derived from `wss.clients.size`.
4. WHEN Event_Processor sends an HTTP POST notification, THE WebSocket_Gateway SHALL broadcast the updated statistics payload to all currently connected clients.
5. WHEN a client disconnects, THE WebSocket_Gateway SHALL remove the connection from the active set without affecting other connected clients.
6. IF a client attempts to reconnect after a disconnection, THEN THE WebSocket_Gateway SHALL accept the new connection and include the client in subsequent broadcasts.
7. WHEN a new client connects, THE WebSocket_Gateway SHALL immediately query MovieStats and RecentActivity and send an `initial_state` message to that client — the UI is purely push-based and has no way to fetch data itself.
8. THE WebSocket_Gateway SHALL send a WebSocket ping frame to all connected clients every 30 seconds to keep connections alive through the ALB idle timeout. Clients that do not respond with a pong SHALL be removed from the active set.
9. THE WebSocket_Gateway SHALL be deployed as a container on ECS Fargate (single task, `desiredCount: 1`) and registered with AWS Cloud Map under a private DNS namespace (e.g. `wsg.local`). The WSG SHALL expose port 8081 for internal Lambda notifications and port 8080 for public WebSocket connections via the ALB.
10. THE `/internal/notify` endpoint on port 8081 SHALL be protected by a shared secret header (`X-Internal-Secret`) known only to Lambda and the gateway. Port 8081 SHALL NOT be exposed via the public ALB.

---

### Requirement 6: Dashboard Frontend

**User Story:** As a university student, I want a browser-based dashboard that displays live movie view statistics, so that I can demonstrate real-time data flow during the assignment demo.

#### Acceptance Criteria

1. THE Dashboard SHALL connect to WebSocket_Gateway via a WebSocket connection on page load, after Cognito authentication.
2. WHEN WebSocket_Gateway broadcasts an update, THE Dashboard SHALL re-render the statistics display within 500ms of receiving the message.
3. THE Dashboard SHALL display the top movies by view count, the most recent view activity, and the Connected_Users_Count.
4. THE Dashboard SHALL render at least one Chart.js graph showing latency or throughput trends over time.
5. THE Dashboard SHALL be hosted on S3 with CloudFront in front. Access SHALL be restricted via Cognito authentication — the dashboard is not publicly accessible without login.
6. IF the WebSocket connection is lost, THEN THE Dashboard SHALL display a reconnecting indicator and attempt to re-establish the connection automatically with exponential backoff (start 1s, multiplier 2, cap 30s, max 10 attempts).
7. THE Dashboard SHALL be implemented using vanilla HTML and JavaScript with Tailwind CSS and Chart.js loaded from CDN, without requiring a build step.
8. THE Dashboard SHALL maintain a full history of received data points for time-series charts with scrollable history — no points are dropped as new ones arrive. All computations (percentiles, throughput) are performed by the gateway; the UI only appends data points and re-renders.

---

### Requirement 7: End-to-End Latency

**User Story:** As a student evaluator, I want to measure the end-to-end latency from a movie view event to a dashboard update, so that I can report the system's real-time performance in the scientific report.

#### Acceptance Criteria

1. THE system SHALL propagate a View_Event from Fast_Lazy_Bee through SQS_Queue, Event_Processor, MovieStats, and WebSocket_Gateway to the Dashboard within a measurable and recordable time window under normal load.
2. THE caller (load testing tool or demo UI) SHALL stamp `publishedAt` (epoch ms) in the `X-Requested-At` request header. Fast_Lazy_Bee SHALL pass this value as `publishedAt` in the SQS message. If the header is absent, Fast_Lazy_Bee falls back to `Date.now()`.
3. THE WebSocket_Gateway SHALL stamp `ts = Date.now()` (epoch ms) immediately before sending each `stats_update` and include it in the payload.
4. THE WebSocket_Gateway SHALL compute `latencyMs = ts - publishedAt` per notification, maintain a rolling 60-second window of samples, derive p50, p95, p99 percentiles server-side, and publish them to CloudWatch as `EndToEndLatencyP50`, `EndToEndLatencyP95`, `EndToEndLatencyP99` under the `AnalyticsDashboard` namespace. These metrics flow to the Dashboard via the existing 5-second `GetMetricData` poll and are rendered from `systemMetrics.gateway` — no latency calculations in the browser.
5. THE Event_Processor SHALL emit a CloudWatch metric for processing duration per Batch invocation.

> **Bonus (if time permits):** Implement a full 2-step round-trip — browser stamps `receivedAt` on receiving the WebSocket push and sends it back to the Gateway via a `latency_ack` message. Gateway computes `fullLatencyMs = receivedAt - publishedAt` and publishes it as a separate CloudWatch metric `FullRoundTripLatency`.

---

### Requirement 8: Load Testing and Performance Metrics

**User Story:** As a student evaluator, I want to run load tests against Fast_Lazy_Bee and observe system behavior under increasing traffic, so that I can analyze throughput, error rate, and scalability in the report.

#### Acceptance Criteria

1. THE system SHALL be load-tested using Artillery with a step-by-step ramp-up profile targeting the `GET /movies/:id` endpoint.
2. WHEN load testing is active, THE system SHALL record throughput (requests per second), error rate, and SQS message backlog depth in CloudWatch.
3. THE Event_Processor SHALL process SQS_Queue messages without exceeding the Dead_Letter_Queue threshold under the defined load test profile.
4. THE load test results SHALL include at least one graph of latency over time and one graph of throughput over time for inclusion in the scientific report.
5. A dedicated Cognito user (e.g. `loadtest@project.com`) SHALL be created for load testing. Before each test run, a fresh JWT SHALL be obtained via `aws cognito-idp initiate-auth` and injected as `LOAD_TEST_TOKEN` environment variable. Artillery SHALL attach it as `Authorization: Bearer` on every request.
6. THE load test script SHALL be runnable both locally and from an EC2 instance in the same AWS region without code changes — only `LOAD_TEST_TOKEN` and target URL need to be set.

---

### Requirement 9: Resilience and Error Isolation

**User Story:** As a system operator, I want each component to handle failures independently, so that a failure in one service does not cascade and bring down the entire pipeline.

#### Acceptance Criteria

1. IF Event_Processor fails to write to MovieStats, THEN THE Event_Processor SHALL report the affected message(s) via `ReportBatchItemFailures` so SQS_Queue retries only those messages.
2. IF WebSocket_Gateway is temporarily unavailable when Event_Processor sends an HTTP POST notification, THEN THE Event_Processor SHALL log the failure and complete the SQS batch successfully without blocking.
3. IF Fast_Lazy_Bee fails to publish to SQS_Queue, THEN THE Fast_Lazy_Bee SHALL continue serving the original HTTP response to the client and log the SQS error.
4. THE Dead_Letter_Queue SHALL capture messages that exceed the maximum retry count, preventing infinite retry loops in SQS_Queue.

---

### Requirement 10: Infrastructure and Deployment

**User Story:** As a student developer, I want all components to be deployable independently using AWS-native services, so that the system satisfies the assignment's minimum requirements for independent services and native cloud services.

#### Acceptance Criteria

1. THE system SHALL consist of at least 3 independently deployed components: Fast_Lazy_Bee (AWS App Runner), Event_Processor (Lambda), and WebSocket_Gateway (ECS Fargate).
2. THE system SHALL use at least 3 AWS-native services, including at least one stateful service: SQS_Queue, MovieStats (DynamoDB), and Dead_Letter_Queue qualify; S3 for Dashboard hosting is additional.
3. THE system SHALL include exactly one FaaS component: Event_Processor (AWS Lambda).
4. THE system SHALL include exactly one real-time communication technology: WebSocket connections between Dashboard and WebSocket_Gateway.
5. THE GitHub repository SHALL contain a root `README.md` with clear instructions for building, deploying, and testing the full system. Each service directory SHALL also contain its own `README.md` covering: what the service does, how to run it locally, and required environment variables.
6. THE repository SHALL follow this structure:
```
service-a/              ← Fast Lazy Bee (TypeScript, App Runner)
event-processor/        ← Lambda (Node.js)
websocket-gateway/      ← WSG (Node.js, ECS Fargate)
frontend/               ← Dashboard (vanilla HTML/JS)
infra/                  ← CDK stack (TypeScript)
load-testing/           ← Artillery config and scripts
given_assignment/       ← assignment docs
README.md               ← root build/deploy/test instructions
```
6. **Service A** SHALL be deployed on **AWS App Runner** — handles HTTPS/TLS automatically, auto-scaling, zero ALB cost. App Runner does not support WebSocket, but Service A is pure HTTP REST.
7. **WebSocket Gateway** SHALL be deployed on **ECS Fargate** (single task) behind a **public ALB** with an **ACM certificate** for TLS termination, exposing `wss://` to browsers. App Runner cannot be used for WSG as it does not support WebSocket (confirmed — HTTP 1.0/1.1 only).
8. THE Fast_Lazy_Bee container image SHALL be stored in AWS ECR. Environment variables (SQS URL, MongoDB URL, Cognito config) SHALL be injected at runtime via App Runner configuration — no secrets hardcoded in the image.
9. MongoDB Atlas SHALL be configured with `0.0.0.0/0` IP allowlist. App Runner has dynamic outbound IPs so a static allowlist is not feasible. No NAT Gateway needed — App Runner has outbound internet access by default.
10. ALL AWS infrastructure SHALL be provisioned using **AWS CDK (TypeScript)** in an `infra/` directory. This includes: SQS queues, DLQ, DynamoDB tables, Lambda, ECS Fargate service, ALB, ACM certificate, App Runner service, S3 bucket, CloudFront, Cognito User Pool, IAM roles, Cloud Map namespace, VPC. User accounts SHALL be created manually after `cdk deploy` — never hardcoded in CDK or committed to git.

---

### Requirement 11: Idempotency

**User Story:** As a system operator, I want Event_Processor to detect and skip duplicate View_Events, so that a movie view is counted exactly once even if SQS delivers the same message more than once.

#### Acceptance Criteria

1. THE Fast_Lazy_Bee SHALL generate a unique `requestId` (UUID v4) for each View_Event at publish time and include it in the SQS message body.
2. BEFORE writing to MovieStats, THE Event_Processor SHALL perform a conditional `PutItem` on the `ProcessedEvents` table using `ConditionExpression: attribute_not_exists(requestId)`.
3. IF the condition fails (item already exists), THEN THE Event_Processor SHALL skip the event without writing to MovieStats — the event is a duplicate.
4. IF the condition succeeds, THEN THE Event_Processor SHALL write the `requestId` to `ProcessedEvents` with a TTL of 86400 seconds (24 hours) and proceed to increment the view count in MovieStats.
5. WHEN two parallel Lambda instances process the same `requestId` simultaneously, exactly one SHALL succeed the conditional write — the other SHALL receive `ConditionalCheckFailedException` and skip.

---

### Requirement 12: Backpressure (Bonus)

**User Story:** As a system operator, I want the WebSocket_Gateway to protect browser clients from being flooded with updates during high-traffic periods, so that the dashboard remains responsive during load testing.

#### Acceptance Criteria

1. THE WebSocket_Gateway SHALL track the rate of incoming notifications from Event_Processor using a sliding 1-second window counter.
2. WHEN the notification rate exceeds 100 events per second, THE WebSocket_Gateway SHALL activate backpressure mode.
3. WHILE backpressure mode is active, THE WebSocket_Gateway SHALL coalesce all pending updates and send at most one `stats_update` message per second to each connected client.
4. WHEN the notification rate drops to 100 events per second or below for 3 consecutive seconds, THE WebSocket_Gateway SHALL deactivate backpressure mode and resume normal per-notification pushes.
5. THE `/health` endpoint SHALL include a `backpressureActive` boolean field reflecting the current backpressure state.

---

### Requirement 13: Authentication via Cognito

**User Story:** As a system owner, I want only authorized users to access the dashboard and call Service A, so that the system is not publicly exploitable during or after the presentation.

#### Acceptance Criteria

1. THE system SHALL use an **AWS Cognito User Pool** as the identity provider. Team members are manually added as users.
2. THE Dashboard SHALL present a Cognito-hosted login page on first load. WHEN a user logs in successfully, Cognito SHALL return a JWT (ID token).
3. THE Dashboard SHALL store the JWT in memory and attach it as a `Bearer` token on every `GET /movies/:id` HTTP request to Service A.
4. THE Service A SHALL validate the Cognito JWT on all incoming requests using `@fastify/jwt` configured with the Cognito User Pool's public JWKS endpoint. Requests without a valid token SHALL receive HTTP 401.
5. THE Dashboard SHALL attach the JWT as a query parameter or header when establishing the WebSocket connection to the Gateway. The Gateway SHALL validate the token on connect and reject unauthenticated connections.
6. FOR load testing, a dedicated Cognito user (e.g. `loadtest@project.com`) SHALL be used. A fresh JWT SHALL be obtained before each test run via `aws cognito-idp initiate-auth` and injected as `LOAD_TEST_TOKEN` — no interactive login needed during the test.
7. THE Cognito User Pool and app client SHALL be provisioned via CDK. User accounts SHALL be created manually after deployment — never hardcoded in CDK or committed to git.

---

### Requirement 14: Cost Protection

**User Story:** As a system owner, I want guardrails in place to prevent unexpected AWS costs during development, load testing, and the presentation.

#### Acceptance Criteria

1. AN AWS Budget alert SHALL be configured to send an email notification when monthly spend exceeds $10.
2. THE Lambda Event_Processor SHALL have a maximum concurrency limit set (e.g. 10) to prevent runaway invocations from flooding DynamoDB during unexpected traffic spikes.

> **Note — Account Concurrency Limit**: New AWS accounts have an applied quota of 10 concurrent executions (not the standard 1000 default). Setting `reservedConcurrentExecutions: 10` fails because AWS requires a minimum of 10 unreserved executions at all times, leaving 0 available. The CDK construct has this value commented out pending a quota increase. To enable it: go to Service Quotas → Lambda → "Concurrent executions" → Request increase to 100 (auto-approved for new accounts). Once approved, uncomment `reservedConcurrentExecutions: 10` in `infra/lib/infra-stack.ts` and redeploy.
>
> **Current status**: `reservedConcurrentExecutions` is NOT set on the deployed Lambda — the function uses the shared unreserved pool (max 10 total for the account). This is a known limitation of the new account and does not affect functionality for the demo. To fix: contact AWS Support and request a Lambda concurrent executions quota increase to 200 for us-east-1.
3. THE DynamoDB tables SHALL use on-demand capacity mode with a maximum write capacity limit configured to cap costs during load testing.
4. ALL ECS Fargate services and App Runner services SHALL be torn down via `cdk destroy` after the presentation to prevent ongoing costs.

> **Bonus (if time permits):** Add AWS WAF to the App Runner service with a rate limiting rule (e.g. max 100 req/min per IP) to protect against abuse during the presentation. Use a WAF IP allowlist rule to exempt your own IP and the load testing EC2 instance from the rate limit, so Artillery runs unrestricted while random IPs are blocked.

---

### Requirement 15: System Metrics via CloudWatch (Bonus)

**User Story:** As a student evaluator, I want the dashboard to display live system health metrics for all components during load testing, so that I can observe the full distributed system behavior in one place.

#### Acceptance Criteria

1. ALL components SHALL publish custom metrics to CloudWatch via `PutMetricData` under the namespace `AnalyticsDashboard`. Each component's IAM role SHALL include `cloudwatch:PutMetricData` permission.

2. **Service A** SHALL publish:
   - `GetMovieInvocations` — count of `GET /movies/:id` requests per interval
   - `SqsPublishErrors` — count of failed SQS publish attempts per interval
   - `SqsPublishLatency` — time taken to publish each View_Event to SQS (ms)

3. **Event_Processor (Lambda)** SHALL publish:
   - `BatchProcessingDuration` — total time to process each SQS batch (ms)
   - `DuplicatesSkipped` — count of idempotency hits per batch
   - `DynamoWriteErrors` — count of failed DynamoDB write attempts per batch

4. **WebSocket_Gateway** SHALL publish:
   - `EndToEndLatencyP50`, `EndToEndLatencyP95`, `EndToEndLatencyP99` — percentiles computed server-side from a rolling 60-second window of `latencyMs = ts - publishedAt` samples (ms)
   - `ConnectedClients` — current WebSocket connection count
   - `ViewEventsPerSecond` — throughput of incoming Lambda notifications
   - `BackpressureActive` — 0 or 1

5. THE WebSocket_Gateway SHALL poll CloudWatch every 5 seconds via `GetMetricData` to fetch ALL metrics — both custom and AWS-native (Lambda invocations/errors/duration, SQS queue depth, ECS CPU%/memory%). The gateway's IAM role SHALL include `cloudwatch:GetMetricData` permission.

6. ALL fetched metrics SHALL be included in every `stats_update` WebSocket payload under a `systemMetrics` field and rendered by the Dashboard without any client-side calculations.

7. WHEN a new client connects, THE `initial_state` message SHALL include the last 1 hour of metric history at 5-second granularity (max 720 data points per metric). The gateway SHALL maintain this rolling 1-hour buffer in memory.

8. THE Dashboard SHALL maintain a full history of received data points for time-series charts with scrollable history.

> **Note:** CloudWatch dashboards can alternatively be embedded via `<iframe>` (shared publicly) — zero backend work but renders as AWS console UI. Decision: proceed with gateway fetching CloudWatch API for full custom chart control.

---

### Requirement 16: Dashboard Chart Types (Bonus)

**User Story:** As a student evaluator, I want the dashboard to display the right chart type for each metric, so that the data is easy to interpret during the demo and in the report.

#### Chart Definitions

**Analytics Section (required):**
- Top 10 most viewed movies — scrollable ranked list: `"#1 The Godfather — 4,821 views"`
- Recent activity feed — scrollable list: `"<movie title> — <timestamp>"`
- Connected users count — single large number display

**Latency Section (bonus):**
- End-to-end latency p50/p95/p99 — multi-line chart (time on x-axis, ms on y-axis, 3 lines)
- Throughput (view events/second) — line chart (time on x-axis, req/s on y-axis)

**Service A Section (bonus):**
- `GET /movies/:id` invocations/sec — line chart over time
- SQS publish latency — line chart over time
- SQS publish errors — line chart over time

**Lambda Section (bonus):**
- Invocations/sec — line chart over time
- Batch processing duration — line chart over time
- Error rate — line chart over time
- Duplicates skipped — line chart over time

**SQS Section (bonus):**
- Queue depth over time — line chart (shows if Lambda is keeping up)
- Messages sent/deleted — line chart over time

**Gateway Section (bonus):**
- Connected clients over time — line chart
- Backpressure state — colored indicator (green = inactive, red = active)

**ECS Section (bonus):**
- Service A CPU% over time — line chart
- Service A memory% over time — line chart

All time-series charts use epoch ms timestamps on the x-axis (provided by the gateway in every `stats_update`). The UI appends data points and re-renders — no calculations in the browser.

---

## Message Schemas

### View_Event (SQS message body)

```json
{
  "schemaVersion": "1.0",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "movieId": "tt0111161",
  "title": "The Shawshank Redemption",
  "publishedAt": 1745678901234
}
```

---

### `initial_state` (WebSocket — sent once on client connect)

```json
{
  "type": "initial_state",
  "ts": 1745678901234,
  "connectedClients": 3,
  "top10": [
    { "movieId": "tt0111161", "title": "The Shawshank Redemption", "viewCount": 4821 }
    , ...
  ],
  "recentActivity": [
    { "movieId": "tt0111161", "title": "The Shawshank Redemption", "viewedAt": 1745678901000 }
  ],
  "systemMetrics": {
    "history": [
      {
        "ts": 1745678900000,
        "lambda": { "invocations": 45, "errors": 0, "avgDurationMs": 180 },
        "sqs": { "queueDepth": 2, "messagesSent": 45 },
        "serviceA": { "cpuPercent": 12, "memoryPercent": 34 },
        "gateway": { "connectedClients": 3, "viewEventsPerSecond": 8, "backpressureActive": false, "latencyP50": 120, "latencyP95": 340, "latencyP99": 580 }
      }
    ]
  }
}
```

> `systemMetrics.history` contains up to 720 data points (last 1 hour at 5s granularity) for chart initialisation. top10` always contains exactly 10 items (or fewer only if less than 10 movies have been viewed) — the gateway queries DynamoDB on every notification to get the current full list.

---

### `stats_update` (WebSocket — broadcast to all clients on each Lambda notification)

```json
{
  "type": "stats_update",
  "ts": 1745678901234,
  "connectedClients": 3,
  "top10": [
    { "movieId": "tt0111161", "title": "The Shawshank Redemption", "viewCount": 4822 }
    , ...
  ],
  "recentActivity": [
    { "movieId": "tt0111161", "title": "The Shawshank Redemption", "viewedAt": 1745678901000 }
  ],
  "systemMetrics": {
    "ts": 1745678901234,
    "lambda": { "invocations": 46, "errors": 0, "avgDurationMs": 182 },
    "sqs": { "queueDepth": 0, "messagesSent": 46 },
    "serviceA": { "cpuPercent": 13, "memoryPercent": 34 },
    "gateway": { "connectedClients": 3, "viewEventsPerSecond": 9, "backpressureActive": false, "latencyP50": 122, "latencyP95": 345, "latencyP99": 590 }
  }
}
```

> `stats_update` contains only the latest single data point for `systemMetrics` (not history). The UI appends it to its local history array. `top10` always contains exactly 10 items (or fewer only if less than 10 movies have been viewed) — the gateway queries DynamoDB on every notification to get the current full list.

---

### `latency_ack` (WebSocket — sent from browser to gateway, bonus)

```json
{
  "type": "latency_ack",
  "publishedAt": 1745678900900,
  "receivedAt": 1745678901350
}
```

---

## Resolved Decisions

1. **Metrics publishing** — Gateway computes p50/p95/p99 server-side from rolling 60s window. All metrics flow through CloudWatch (`PutMetricData` from each component, `GetMetricData` by gateway). UI renders only.
2. **Load testing tool** — Artillery. Built-in HTML report, YAML config, `$timestamp` variable for `X-Requested-At` header.
3. **Metrics storage** — CloudWatch for all performance metrics. DynamoDB for analytics data (view counts, recent activity) only.
4. **Chart types** — Defined in Requirement 16.
5. **WebSocket Gateway scaling** — Single ECS task (`desiredCount: 1`). Backpressure protects it from being overwhelmed. Scaling limitation documented as known trade-off in the report.
6. **Lambda → Gateway communication** — HTTP POST via AWS Cloud Map DNS (`wsg.local`). Same VPC. No ALB needed for internal traffic.
7. **Recent activity data model** — Separate `RecentActivity` DynamoDB table, time-sorted, 1-day TTL, limit 20.
8. **HTTPS/WSS** — Service A on App Runner (auto TLS). WSG on ECS Fargate + ALB + ACM certificate.
9. **MongoDB Atlas** — `0.0.0.0/0` allowlist. App Runner handles outbound internet natively.
10. **Infrastructure as Code** — AWS CDK (TypeScript) in `infra/` directory.

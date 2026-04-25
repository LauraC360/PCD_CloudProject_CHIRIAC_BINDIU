# Requirements Document

## Introduction

This document defines the requirements for Project 1 — Real-Time Analytics Dashboard, a distributed system built on top of the Fast Lazy Bee movies REST API. The system collects movie view events, processes them asynchronously through a cloud-native pipeline, and displays live statistics on a browser-based dashboard. The architecture uses AWS-native services (SQS, Lambda, DynamoDB) and a custom WebSocket gateway to satisfy the university assignment's requirements for independent services, FaaS, real-time communication, and measurable performance metrics.

## Glossary

- **Fast_Lazy_Bee**: The base Node.js/Fastify/MongoDB movies REST API deployed on ECS Fargate, extended with event publishing.
- **SQS_Queue**: AWS SQS Standard Queue that receives view-event messages published by Fast_Lazy_Bee.
- **Dead_Letter_Queue**: AWS SQS queue that receives messages that have failed processing beyond the maximum retry threshold.
- **Event_Processor**: AWS Lambda function triggered by SQS_Queue that aggregates view counts and writes to DynamoDB.
- **Analytics_Store**: AWS DynamoDB table storing per-movie view counts with `movieId` as the partition key.
- **WebSocket_Gateway**: Custom Node.js server (ws library) running on ECS Fargate that maintains WebSocket connections with browser clients and receives HTTP POST notifications from Event_Processor.
- **Dashboard**: Static HTML/JS frontend hosted on S3 that connects to WebSocket_Gateway and renders real-time statistics using Chart.js.
- **View_Event**: A JSON message published to SQS_Queue each time a client calls `GET /movies/:id` on Fast_Lazy_Bee.
- **Batch**: A group of up to 5 View_Event messages delivered together to Event_Processor by SQS.
- **Connected_Users_Count**: The number of active WebSocket connections tracked in-memory by WebSocket_Gateway via `wss.clients.size`.

---

## Requirements

### Requirement 1: View Event Publishing

**User Story:** As a system operator, I want Fast_Lazy_Bee to publish a View_Event to SQS_Queue on every `GET /movies/:id` call, so that downstream services can process movie access data without coupling the route handler to analytics logic.

#### Acceptance Criteria

1. WHEN a client sends `GET /movies/:id` and Fast_Lazy_Bee returns a response, THE Fast_Lazy_Bee SHALL publish a View_Event message to SQS_Queue via a Fastify `onResponse` hook.
2. THE View_Event SHALL contain at minimum the `movieId`, a UTC timestamp, and the HTTP response status code.
3. IF SQS_Queue is unreachable when publishing, THEN THE Fast_Lazy_Bee SHALL log the error and return the original HTTP response to the client without modification.
4. THE Fast_Lazy_Bee SHALL publish View_Events only for successful responses (HTTP 2xx) to avoid counting error responses as views.

---

### Requirement 2: SQS Queue Configuration

**User Story:** As a system operator, I want the SQS_Queue to be configured for reliable at-least-once delivery with failure isolation, so that no view events are silently lost and repeated failures do not block the queue.

#### Acceptance Criteria

1. THE SQS_Queue SHALL be a Standard Queue with a visibility timeout of 60 seconds, exceeding the Event_Processor timeout of 30 seconds.
2. THE SQS_Queue SHALL be configured with a batch size of 5 messages per Event_Processor invocation.
3. WHEN a message fails processing more than the configured maximum retry count, THE SQS_Queue SHALL route the message to the Dead_Letter_Queue.
4. THE Dead_Letter_Queue SHALL retain failed messages for a minimum of 4 days to allow manual inspection.

---

### Requirement 3: Event Processing (Lambda)

**User Story:** As a system operator, I want Event_Processor to aggregate view counts from each Batch and write them atomically to Analytics_Store, so that parallel Lambda invocations do not produce data races or incorrect counts.

#### Acceptance Criteria

1. WHEN SQS_Queue delivers a Batch, THE Event_Processor SHALL be triggered automatically via an SQS event source mapping.
2. THE Event_Processor SHALL aggregate view counts within the Batch by `movieId` before writing to Analytics_Store (e.g., 3 events for movie A and 2 for movie B produce two writes, not five).
3. THE Event_Processor SHALL write aggregated counts to Analytics_Store using a DynamoDB `UpdateExpression` with an atomic `ADD` operation, without performing a read before the write.
4. IF a single message in a Batch fails processing, THEN THE Event_Processor SHALL report that message as a failure using `ReportBatchItemFailures` so that only the failed message is returned to SQS_Queue, not the entire Batch.
5. THE Event_Processor SHALL have a maximum execution timeout of 30 seconds.
6. WHEN all messages in a Batch are processed successfully, THE Event_Processor SHALL send an HTTP POST notification to WebSocket_Gateway containing the updated view counts.

---

### Requirement 4: Analytics Storage (DynamoDB)

**User Story:** As a system operator, I want Analytics_Store to persist per-movie view counts durably and scale automatically with Lambda burst traffic, so that the system remains consistent under variable load.

#### Acceptance Criteria

1. THE Analytics_Store SHALL use `movieId` (string) as the partition key with no sort key.
2. THE Analytics_Store SHALL use on-demand capacity mode to scale automatically with Event_Processor invocation bursts.
3. THE Analytics_Store SHALL store a `viewCount` attribute (number) per item, incremented atomically by Event_Processor.
4. WHEN Event_Processor performs a concurrent `ADD` on the same `movieId` from multiple Lambda instances, THE Analytics_Store SHALL reflect the correct total count without data loss.

---

### Requirement 5: WebSocket Gateway

**User Story:** As a system operator, I want WebSocket_Gateway to maintain persistent connections with browser clients and broadcast real-time updates when Event_Processor reports new view counts, so that the Dashboard reflects current data without polling.

#### Acceptance Criteria

1. THE WebSocket_Gateway SHALL accept WebSocket connections from browser clients on a dedicated port.
2. WHEN Event_Processor sends an HTTP POST notification, THE WebSocket_Gateway SHALL broadcast the updated statistics payload to all currently connected clients.
3. THE WebSocket_Gateway SHALL expose the Connected_Users_Count as part of every broadcast payload, derived from `wss.clients.size`.
4. WHEN a client disconnects, THE WebSocket_Gateway SHALL remove the connection from the active set without affecting other connected clients.
5. IF a client attempts to reconnect after a disconnection, THEN THE WebSocket_Gateway SHALL accept the new connection and include the client in subsequent broadcasts.
6. THE WebSocket_Gateway SHALL be deployed as a container on ECS Fargate and remain reachable by Event_Processor via an internal HTTP endpoint.

---

### Requirement 6: Dashboard Frontend

**User Story:** As a university student, I want a browser-based dashboard that displays live movie view statistics, so that I can demonstrate real-time data flow during the assignment demo.

#### Acceptance Criteria

1. THE Dashboard SHALL connect to WebSocket_Gateway via a WebSocket connection on page load.
2. WHEN WebSocket_Gateway broadcasts an update, THE Dashboard SHALL re-render the statistics display within 500ms of receiving the message.
3. THE Dashboard SHALL display the top movies by view count, the most recent view activity, and the Connected_Users_Count.
4. THE Dashboard SHALL render at least one Chart.js graph showing view count trends over time.
5. THE Dashboard SHALL be hosted as a static website on an S3 bucket with public read access.
6. IF the WebSocket connection is lost, THEN THE Dashboard SHALL display a reconnecting indicator and attempt to re-establish the connection automatically.
7. THE Dashboard SHALL be implemented using vanilla HTML and JavaScript with Tailwind CSS and Chart.js loaded from CDN, without requiring a build step.

---

### Requirement 7: End-to-End Latency

**User Story:** As a student evaluator, I want to measure the end-to-end latency from a movie view event to a dashboard update, so that I can report the system's real-time performance in the scientific report.

#### Acceptance Criteria

1. THE system SHALL propagate a View_Event from Fast_Lazy_Bee through SQS_Queue, Event_Processor, Analytics_Store, and WebSocket_Gateway to the Dashboard within a measurable and recordable time window under normal load.
2. WHEN load testing is performed, THE system SHALL record end-to-end latency percentiles (p50, p95, p99) using CloudWatch metrics or equivalent instrumentation.
3. THE Event_Processor SHALL emit a CloudWatch metric for processing duration per Batch invocation.

---

### Requirement 8: Load Testing and Performance Metrics

**User Story:** As a student evaluator, I want to run load tests against Fast_Lazy_Bee and observe system behavior under increasing traffic, so that I can analyze throughput, error rate, and scalability in the report.

#### Acceptance Criteria

1. THE system SHALL be load-tested using k6 or Artillery with a step-by-step ramp-up profile targeting the `GET /movies/:id` endpoint.
2. WHEN load testing is active, THE system SHALL record throughput (requests per second), error rate, and SQS message backlog depth in CloudWatch.
3. THE Event_Processor SHALL process SQS_Queue messages without exceeding the Dead_Letter_Queue threshold under the defined load test profile.
4. THE load test results SHALL include at least one graph of latency over time and one graph of throughput over time for inclusion in the scientific report.

---

### Requirement 9: Resilience and Error Isolation

**User Story:** As a system operator, I want each component to handle failures independently, so that a failure in one service does not cascade and bring down the entire pipeline.

#### Acceptance Criteria

1. IF Event_Processor fails to write to Analytics_Store, THEN THE Event_Processor SHALL report the affected message(s) via `ReportBatchItemFailures` so SQS_Queue retries only those messages.
2. IF WebSocket_Gateway is temporarily unavailable when Event_Processor sends an HTTP POST notification, THEN THE Event_Processor SHALL log the failure and complete the SQS batch successfully without blocking.
3. IF Fast_Lazy_Bee fails to publish to SQS_Queue, THEN THE Fast_Lazy_Bee SHALL continue serving the original HTTP response to the client and log the SQS error.
4. THE Dead_Letter_Queue SHALL capture messages that exceed the maximum retry count, preventing infinite retry loops in SQS_Queue.

---

### Requirement 10: Infrastructure and Deployment

**User Story:** As a student developer, I want all components to be deployable independently using AWS-native services, so that the system satisfies the assignment's minimum requirements for independent services and native cloud services.

#### Acceptance Criteria

1. THE system SHALL consist of at least 3 independently deployed components: Fast_Lazy_Bee (ECS Fargate), Event_Processor (Lambda), and WebSocket_Gateway (ECS Fargate).
2. THE system SHALL use at least 3 AWS-native services, including at least one stateful service: SQS_Queue, Analytics_Store (DynamoDB), and Dead_Letter_Queue qualify; S3 for Dashboard hosting is additional.
3. THE system SHALL include exactly one FaaS component: Event_Processor (AWS Lambda).
4. THE system SHALL include exactly one real-time communication technology: WebSocket connections between Dashboard and WebSocket_Gateway.
5. THE GitHub repository SHALL contain a README with clear instructions for building, deploying, and testing the system.
6. THE Fast_Lazy_Bee container image SHALL be stored in AWS ECR and deployed via an ECS Task Definition with environment variables injected at runtime (SQS URL, MongoDB URL) — no secrets hardcoded in the image.

---

## Open Questions / Needs Further Discussion

1. **Metrics publishing to dashboard (bonus)** — Requirement 7 mentions CloudWatch for latency percentiles, but the bonus asks for p50/p95/p99 live on the dashboard itself. We haven't decided how Lambda emits latency data to the WebSocket gateway in real time. Options: include it in the HTTP POST payload to the gateway, or poll CloudWatch from a backend proxy. Needs a decision before implementation.

2. **Load testing tool** — Requirement 8 says "k6 or Artillery" but we haven't committed to one. Artillery gives HTML reports out of the box; k6 integrates better with CloudWatch. Needs a final decision.

3. **Metrics storage — DynamoDB vs CloudWatch** — We haven't decided where metrics live. DynamoDB stores aggregated view counts (what the dashboard reads). CloudWatch collects Lambda/SQS operational metrics automatically. But for the report graphs (latency, throughput over time), we need to decide: do we rely purely on CloudWatch exports, or do we store time-series data ourselves? If we want historical latency charts on the dashboard, CloudWatch alone won't work without a proxy layer.

4. **Chart types and data shape** — The dashboard needs at least one Chart.js graph. We haven't defined what charts exactly: top movies bar chart? view count over time line chart? latency p50/p95/p99 line chart (bonus)? Each requires different data structures from DynamoDB or Lambda. Needs a decision before designing the DynamoDB schema and WebSocket payload format.

3. **WebSocket Gateway — scaling vs simplicity** — Currently specced as in-memory (`wss.clients.size`) on a single ECS Fargate container. This is fine for demo scale but means if the container restarts, all connections drop. We agreed this is acceptable, but it's worth confirming before implementation since it affects the resilience section of the report.

4. **How Lambda reaches WebSocket Gateway** — Requirement 3.6 says Lambda sends an HTTP POST to the gateway. This requires the gateway to have a stable internal URL reachable from Lambda. We need to decide: use an internal ALB, a service discovery mechanism, or just a hardcoded ECS service URL via environment variable. Not yet discussed.

5. **DynamoDB data model for "recent activity" and "top movies"** — Requirement 6.3 says the dashboard shows top movies and recent activity. Top movies can be derived from `viewCount` in DynamoDB, but "recent activity" (last N views) needs a time-ordered structure. A single `viewCount` per `movieId` doesn't support this — we may need a separate DynamoDB table or a sort key. Not yet designed.

6. **HTTPS / WSS for production** — The dashboard on S3 needs to connect via `wss://` (secure WebSocket) for browsers to allow it. This means the WebSocket Gateway needs TLS termination — likely via an ALB with an ACM certificate. Not yet discussed.

7. **MongoDB Atlas network access** — Atlas free tier connects over the public internet. ECS Fargate tasks will need outbound internet access (NAT Gateway or public subnet) to reach Atlas. This has cost and security implications worth confirming.

8. **Infrastructure as Code — AWS CDK** — Leaning towards using AWS CDK (TypeScript) to provision all infrastructure (SQS, Lambda, DynamoDB, ECS services, S3, IAM roles, etc.) instead of clicking through the console. This keeps everything reproducible and version-controlled, and satisfies the README/deployment instructions requirement cleanly. Needs team agreement and a decision on whether CDK lives in the same repo as the services or a separate `infra/` directory.

# 1. Arhitectura Sistemului (System Architecture)

## 1.1 Overview

The Realtime Analytics Dashboard is a cloud-native distributed system designed to collect, process, and visualize movie-view events in real time. The system is composed of four independently deployed components that communicate asynchronously through AWS-managed services, ensuring loose coupling, scalability, and resilience.

The architecture follows the **event-driven microservices pattern**, where each component has a single responsibility and communicates through well-defined interfaces. This design satisfies the university assignment requirements for:
- Minimum 3 independently deployed services ✓ (Service A, Event Processor, WebSocket Gateway)
- Minimum 3 AWS-native services ✓ (SQS, Lambda, DynamoDB)
- At least one FaaS component ✓ (AWS Lambda)
- Real-time communication technology ✓ (WebSocket)

## 1.2 Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          REALTIME ANALYTICS DASHBOARD                       │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                            CLIENT LAYER                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│  Browser Client (HTML + Vanilla JavaScript)                                  │
│  - Connects via WebSocket to Gateway                                         │
│  - Renders live top-10 movies, connected users, latency metrics              │
│  - Implements exponential backoff reconnection (1s → 30s, max 10 attempts)   │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket (ws://)
                                    │ stats_update messages
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         REAL-TIME DELIVERY LAYER                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  WebSocket Gateway (Node.js / ws library)                                    │
│  - Hosted on AWS ECS Fargate (always-on container)                           │
│  - Maintains in-memory connection registry (wss.clients)                     │
│  - Receives HTTP POST notifications from Lambda                              │
│  - Queries DynamoDB for top-10 movies                                        │
│  - Broadcasts stats_update to all connected clients                          │
│  - Implements backpressure: coalesces > 100 events/s to 1 push/s per client │
│  - Exposes /health endpoint for monitoring                                   │
└──────────────────────────────────────────────────────────────────────────────┘
                    ▲                                    │
                    │ HTTP POST                          │ Query top-10
                    │ /internal/notify                   │ (GSI on viewCount)
                    │                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                      ASYNCHRONOUS PROCESSING LAYER                           │
├──────────────────────────────────────────────────────────────────────────────┤
│  Event Processor (AWS Lambda)                                                │
│  - Triggered by SQS event source mapping (batch size ≤ 10)                   │
│  - Timeout: 30 seconds, Memory: ≥ 256 MB                                     │
│  - Processing per event:                                                     │
│    1. Idempotency check: conditional PutItem on ProcessedEvents table        │
│    2. Atomic counter increment: ADD viewCount on MovieStats                  │
│    3. Notification: HTTP POST to Gateway with updated stats                  │
│    4. Metrics: CloudWatch Metrics (duration, success/error counts)           │
│  - Batch failure handling: ReportBatchItemFailures (retry only failed items) │
└──────────────────────────────────────────────────────────────────────────────┘
                    ▲                                    │
                    │ SQS messages                       │ DynamoDB writes
                    │ (batch ≤ 10)                       │ (atomic ADD)
                    │                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         MESSAGE QUEUE LAYER                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│  AWS SQS Standard Queue: view-events                                         │
│  - Visibility Timeout: 60 seconds (exceeds Lambda 30s timeout)               │
│  - Batch Size: 10 messages per Lambda invocation                             │
│  - Retry Policy: maxReceiveCount = 3                                         │
│  - Dead Letter Queue: view-events-dlq (retention 4 days)                     │
│  - Guarantees: At-least-once delivery with automatic retries                 │
└──────────────────────────────────────────────────────────────────────────────┘
                    ▲                                    │
                    │ SQS SendMessage                    │ DynamoDB writes
                    │ (fire-and-forget)                  │ (idempotency check)
                    │                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         DATA PERSISTENCE LAYER                               │
├──────────────────────────────────────────────────────────────────────────────┤
│  AWS DynamoDB Tables (on-demand billing)                                     │
│                                                                              │
│  Table 1: MovieStats                                                         │
│  - Partition Key: movieId (String)                                           │
│  - Attributes: viewCount (Number), lastViewedAt, updatedAt (Strings)        │
│  - GSI: pk (STATS) + viewCount (descending) for top-10 queries              │
│  - Access Pattern: Atomic ADD on viewCount, Query top-10 by viewCount       │
│                                                                              │
│  Table 2: ProcessedEvents (Idempotency Store)                               │
│  - Partition Key: requestId (String, UUID v4)                               │
│  - Attributes: movieId, processedAt, ttl (Unix epoch)                       │
│  - TTL: Automatic expiration after 24 hours                                 │
│  - Access Pattern: Conditional PutItem (attribute_not_exists check)         │
│  - Purpose: Detect and skip duplicate events from SQS retries               │
└──────────────────────────────────────────────────────────────────────────────┘
                    ▲                                    │
                    │ GET /movies/:id                    │ Publish View_Event
                    │ (HTTP 200)                         │ (fire-and-forget)
                    │                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         REST API LAYER                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│  Service A: Fast Lazy Bee (Node.js / Fastify v5)                            │
│  - Hosted on AWS ECS Fargate (always-on container)                           │
│  - Endpoints:                                                                │
│    • GET /api/v1/movies/:movie_id → Returns movie JSON                      │
│    • GET /api/v1/metrics → Returns publish metrics                          │
│  - On successful GET /movies/:id:                                           │
│    1. Fetch movie from MongoDB                                              │
│    2. Publish View_Event to SQS (non-blocking, fire-and-forget)             │
│    3. Return HTTP 200 with movie data                                       │
│  - SQS publish never delays HTTP response (async, no await)                 │
│  - Metrics tracked: totalPublished, publishErrors, avgPublishLatencyMs      │
└──────────────────────────────────────────────────────────────────────────────┘
                    │
                    │ Read movie data
                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         DATA SOURCE LAYER                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│  MongoDB Atlas (External)                                                    │
│  - Collection: movies                                                        │
│  - Contains: movie metadata (title, year, genres, etc.)                      │
│  - Access: Read-only from Service A                                         │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 1.3 Data Flow Sequence

### Main Flow: Movie View → Dashboard Update

```
Time  Actor              Action                          Details
────────────────────────────────────────────────────────────────────────────
T0    Browser Client     GET /movies/:id                 HTTP request to Service A
      
T1    Service A          Fetch from MongoDB              Query movie by ID
      
T2    Service A          Return HTTP 200                 Movie JSON sent to client
      
T3    Service A          Publish View_Event to SQS       Fire-and-forget (async)
                         {
                           schemaVersion: "1.0",
                           requestId: UUID,
                           movieId: "tt0111161",
                           publishedAt: ISO8601_UTC
                         }
      
T4    SQS Queue          Buffer message                  Message in queue, visible
      
T5    SQS → Lambda       Trigger event source mapping    Batch ≤ 10 messages
      
T6    Lambda             Receive SQS batch               Parse View_Event objects
      
T7    Lambda             Idempotency check               PutItem on ProcessedEvents
                         Condition: attribute_not_exists(requestId)
      
T8    Lambda             Atomic counter increment        UpdateItem MovieStats
                         ADD viewCount :one
      
T9    Lambda             Notify Gateway                  HTTP POST /internal/notify
                         {
                           movieId: "tt0111161",
                           viewCount: 4821,
                           publishedAt: ISO8601_UTC
                         }
      
T10   Gateway            Query DynamoDB                  GSI query: top-10 by viewCount
      
T11   Gateway            Stamp delivery timestamp        deliveredAt = now()
      
T12   Gateway            Broadcast to clients            WebSocket push to all connected
                         {
                           type: "stats_update",
                           publishedAt: ISO8601_UTC,
                           deliveredAt: ISO8601_UTC,
                           connectedClients: N,
                           top10: [...]
                         }
      
T13   Browser Client     Receive stats_update            WebSocket onmessage event
      
T14   Browser Client     Compute latency                 latencyMs = deliveredAt - publishedAt
      
T15   Browser Client     Update DOM                      Render new top-10, update chart
      
────────────────────────────────────────────────────────────────────────────
End-to-End Latency: T0 → T15 (typically 200–500 ms under normal load)
```

## 1.4 Component Responsibilities

### Service A — Fast Lazy Bee (ECS Fargate)

**Role**: REST API gateway and event publisher

**Responsibilities**:
- Serve movie metadata from MongoDB
- Publish View_Event to SQS on every successful `GET /movies/:id`
- Track and expose publish metrics via `/metrics` endpoint
- Never block HTTP responses on SQS publish (fire-and-forget pattern)

**Key Design Decision**: SQS publishing is **non-blocking**. The HTTP response is sent immediately after fetching the movie, and the SQS publish happens asynchronously in the background. This ensures:
- Client latency is not affected by SQS or Lambda processing
- If SQS is temporarily unavailable, the API remains responsive
- Errors in SQS publishing are logged but do not fail the HTTP request

**Deployment**: Always-on ECS Fargate task in a public subnet, port 3000.

---

### Event Processor (AWS Lambda)

**Role**: Asynchronous event aggregator and state writer

**Responsibilities**:
- Consume SQS batches (up to 10 messages per invocation)
- Enforce idempotency via conditional writes to ProcessedEvents table
- Atomically increment view counts in MovieStats table
- Notify WebSocket Gateway of updated statistics
- Emit CloudWatch metrics for observability

**Key Design Decision**: **Idempotency via ProcessedEvents table**. Because SQS guarantees at-least-once delivery, messages may be redelivered if Lambda fails or times out. To prevent duplicate view counts:
1. Each View_Event carries a unique `requestId` (UUID v4)
2. Before writing to MovieStats, Lambda performs a conditional `PutItem` on ProcessedEvents with `ConditionExpression: attribute_not_exists(requestId)`
3. If the condition fails (event already processed), the message is skipped
4. ProcessedEvents items expire after 24 hours via DynamoDB TTL, keeping the table small

This approach is safe and efficient: no read-before-write, no optimistic locking, no distributed transactions.

**Deployment**: AWS Lambda function, 30-second timeout, ≥ 256 MB memory, triggered by SQS event source mapping.

---

### WebSocket Gateway (ECS Fargate)

**Role**: Real-time push notification broker

**Responsibilities**:
- Accept and maintain WebSocket connections from browser clients
- Receive HTTP POST notifications from Lambda
- Query DynamoDB for current top-10 movies
- Broadcast stats_update messages to all connected clients
- Apply backpressure when event rate exceeds 100/s
- Expose `/health` endpoint for monitoring

**Key Design Decision**: **Direct HTTP POST from Lambda to Gateway** (not a second SQS queue). Rationale:
- **Simplicity**: No polling loop needed; direct HTTP is synchronous and fast (< 10 ms on same VPC)
- **Latency**: Keeps end-to-end latency within the 500 ms budget
- **Acceptable coupling**: Gateway URL is injected via environment variable; Lambda retries POST up to 2 times on failure
- **Self-healing**: Because Gateway always queries DynamoDB for fresh stats before pushing, out-of-order or dropped notifications are automatically corrected by the next successful notification

**Backpressure Implementation**: When incoming notification rate exceeds 100 events/s, the Gateway activates backpressure mode:
- A per-client timer coalesces all pending updates into a single `stats_update` message
- Each client receives at most 1 push per second during backpressure
- This prevents WebSocket frame flooding and keeps CPU usage bounded

**Deployment**: Always-on ECS Fargate task, port 8080 (public WebSocket), port 8081 (internal HTTP for Lambda).

---

### Frontend (Static SPA)

**Role**: Real-time dashboard UI

**Responsibilities**:
- Connect to WebSocket Gateway on page load
- Render live top-10 movies, connected-user count, recent activity
- Display p50/p95/p99 latency percentiles in a chart
- Handle WebSocket disconnection and reconnect with exponential backoff
- Compute end-to-end latency from `publishedAt` and `deliveredAt` timestamps

**Key Design Decision**: **Vanilla JavaScript, no build step**. The frontend is a single HTML file with inline JavaScript and CSS from CDN (Chart.js, Tailwind). This satisfies the assignment requirement for a "minimal dashboard" and simplifies deployment (just serve static files).

**Reconnection Strategy**: Exponential backoff starting at 1000 ms, multiplier 2, cap 30 000 ms, max 10 attempts. After 10 failures, display "Connection lost. Please refresh the page."

**Deployment**: Served by the WebSocket Gateway's HTTP server (or S3 + CloudFront for static hosting).

---

## 1.5 Data Models

### DynamoDB: MovieStats Table

| Attribute | Type | Description | Example |
|---|---|---|---|
| `movieId` | String (PK) | Unique movie identifier | `"tt0111161"` |
| `pk` | String | Partition key for GSI (sparse, always "STATS") | `"STATS"` |
| `viewCount` | Number | Total view count (atomically incremented) | `4821` |
| `lastViewedAt` | String | ISO 8601 UTC timestamp of most recent view | `"2025-07-14T10:23:45.123Z"` |
| `updatedAt` | String | ISO 8601 UTC timestamp of last DynamoDB write | `"2025-07-14T10:23:45.200Z"` |

**Global Secondary Index: `pk-viewCount-index`**
- Partition Key: `pk` (String, always "STATS")
- Sort Key: `viewCount` (Number, descending)
- Projection: ALL
- Used by Gateway to query top-10 movies efficiently: `Query(pk="STATS", ScanIndexForward=false, Limit=10)`

**Billing**: PAY_PER_REQUEST (on-demand capacity)

---

### DynamoDB: ProcessedEvents Table (Idempotency Store)

| Attribute | Type | Description | Example |
|---|---|---|---|
| `requestId` | String (PK) | UUID v4 from View_Event | `"550e8400-e29b-41d4-a716-446655440000"` |
| `movieId` | String | Movie that was viewed | `"tt0111161"` |
| `processedAt` | String | ISO 8601 UTC timestamp of processing | `"2025-07-14T10:23:45.200Z"` |
| `ttl` | Number | Unix epoch seconds; DynamoDB TTL attribute | `1752518625` (now + 86400) |

**Access Pattern**: Single-key lookup by `requestId` (no GSI needed)

**TTL**: Automatic expiration after 24 hours (DynamoDB native TTL feature)

**Billing**: PAY_PER_REQUEST (on-demand capacity)

---

### SQS Message: View_Event

```json
{
  "schemaVersion": "1.0",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "movieId": "tt0111161",
  "publishedAt": "2025-07-14T10:23:44.900Z"
}
```

**Size**: ~150 bytes (well under SQS 256 KB limit)

**Retention**: Default 4 days (configurable)

---

### WebSocket Message: stats_update

```json
{
  "type": "stats_update",
  "publishedAt": "2025-07-14T10:23:44.900Z",
  "deliveredAt": "2025-07-14T10:23:45.350Z",
  "connectedClients": 12,
  "top10": [
    {
      "movieId": "tt0111161",
      "viewCount": 4821,
      "lastViewedAt": "2025-07-14T10:23:45.123Z"
    },
    {
      "movieId": "tt0068646",
      "viewCount": 3102,
      "lastViewedAt": "2025-07-14T10:22:11.000Z"
    }
  ]
}
```

**Size**: ~500–800 bytes (depends on number of movies in top-10)

**Frequency**: At most 1 per second per client (due to backpressure coalescing)

---

## 1.6 Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        AWS ACCOUNT                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  VPC (Virtual Private Cloud)                             │  │
│  │                                                          │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │  Public Subnet                                     │ │  │
│  │  │                                                    │ │  │
│  │  │  ┌──────────────────┐  ┌──────────────────────┐  │ │  │
│  │  │  │ Service A        │  │ WebSocket Gateway    │  │ │  │
│  │  │  │ (ECS Fargate)    │  │ (ECS Fargate)        │  │ │  │
│  │  │  │ Port 3000        │  │ Port 8080 (public)   │  │ │  │
│  │  │  │ Port 8081 (int)  │  │ Port 8081 (internal) │  │ │  │
│  │  │  └──────────────────┘  └──────────────────────┘  │ │  │
│  │  │         │                       ▲                 │ │  │
│  │  │         │ Outbound to MongoDB   │ HTTP POST       │ │  │
│  │  │         │ Atlas (public)        │ /internal/notify│ │  │
│  │  │         │                       │                 │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  │                                                          │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │  AWS Managed Services (VPC Endpoints)             │ │  │
│  │  │                                                    │ │  │
│  │  │  • SQS (view-events queue + DLQ)                  │ │  │
│  │  │  • DynamoDB (MovieStats + ProcessedEvents)        │ │  │
│  │  │  • Lambda (Event Processor)                       │ │  │
│  │  │  • CloudWatch (Logs + Metrics)                    │ │  │
│  │  │                                                    │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL SERVICES                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  • MongoDB Atlas (movies collection)                           │
│  • S3 (Frontend static files, optional)                        │
│  • CloudFront (CDN for frontend, optional)                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1.7 Key Architectural Principles

### 1. Loose Coupling via Asynchronous Messaging

Service A does not wait for Lambda to process events. Instead, it publishes to SQS and returns immediately. This decouples the API from the analytics pipeline:
- If Lambda is slow or unavailable, the API remains responsive
- Service A can scale independently of Event Processor
- Failures in one component do not cascade to others

### 2. Idempotency for Reliability

Because SQS guarantees at-least-once delivery (not exactly-once), the system must handle duplicate events. The ProcessedEvents table with TTL ensures:
- Duplicate events are detected and skipped
- No data races or double-counting
- Automatic cleanup after 24 hours (no manual maintenance)

### 3. Atomic Operations for Consistency

DynamoDB's `ADD` expression on viewCount is atomic at the database level:
- No read-before-write cycle
- No optimistic locking or retries needed
- Concurrent increments from multiple Lambda instances are correctly aggregated

### 4. Backpressure for Stability

When event rate exceeds 100/s, the Gateway coalesces updates to 1 push/s per client:
- Prevents WebSocket frame flooding
- Keeps CPU and memory usage bounded
- Clients still receive accurate, up-to-date statistics

### 5. Real-Time Delivery via WebSocket

WebSocket provides bidirectional, low-latency communication:
- Server can push updates without client polling
- Reduces latency from seconds (polling) to milliseconds (push)
- Enables live dashboard updates within 500 ms

---

## 1.8 Scalability Considerations

### Horizontal Scaling

- **Service A**: ECS Fargate auto-scaling based on CPU/memory metrics. Multiple instances behind an ALB.
- **Event Processor**: Lambda scales automatically; SQS manages queue depth and triggers additional Lambda instances as needed.
- **WebSocket Gateway**: Multiple ECS Fargate instances behind an ALB. Requires a shared connection registry (e.g., Redis) to broadcast across instances. Current implementation uses in-memory registry (single instance only).
- **DynamoDB**: On-demand billing automatically scales read/write capacity with traffic.

### Vertical Scaling

- **Service A**: Increase ECS task CPU/memory allocation.
- **Event Processor**: Increase Lambda memory (also increases CPU allocation).
- **WebSocket Gateway**: Increase ECS task CPU/memory allocation.

### Bottleneck Analysis

1. **MongoDB Atlas**: External dependency; latency depends on network and Atlas performance. Mitigation: connection pooling, read replicas.
2. **SQS visibility timeout**: Set to 60s (exceeds Lambda 30s timeout) to prevent message redelivery during processing.
3. **DynamoDB GSI**: Top-10 query on `viewCount` GSI is efficient (< 10 ms). No bottleneck expected.
4. **WebSocket Gateway**: In-memory connection registry limits to single instance. Mitigation: use Redis for distributed connection registry.

---

This completes the **Architecture Section** of your scientific report. It covers:
✓ System overview and component diagram
✓ Data flow sequence
✓ Component responsibilities
✓ Data models (DynamoDB, SQS, WebSocket messages)
✓ Deployment architecture
✓ Key architectural principles
✓ Scalability considerations

**Next steps**: Would you like me to help with the next section (Communication Analysis, Consistency Analysis, Performance & Scalability, Resilience, or Real Systems Comparison)?

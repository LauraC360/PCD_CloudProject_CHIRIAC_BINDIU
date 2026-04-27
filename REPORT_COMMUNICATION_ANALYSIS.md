# 2. Analiza Comunicării (Communication Analysis)

## 2.1 Overview

This section analyzes the communication patterns between components in the Realtime Analytics Dashboard system. For each interaction, we justify the choice between synchronous and asynchronous communication, considering factors such as latency requirements, coupling, reliability, and scalability.

The system employs a **hybrid communication model**:
- **Synchronous (HTTP)**: Client → Service A, Gateway → DynamoDB, Lambda → Gateway
- **Asynchronous (SQS)**: Service A → Event Processor
- **Real-time push (WebSocket)**: Gateway → Browser clients

Each choice is deliberate and optimized for the specific interaction's requirements.

---

## 2.2 Communication Patterns

### Pattern 1: Browser Client → Service A (HTTP GET)

**Interaction**: `GET /api/v1/movies/:movie_id`

**Communication Type**: **Synchronous (HTTP)**

**Justification**:

| Factor | Analysis |
|---|---|
| **Latency Requirement** | Client expects immediate response (< 200 ms). Synchronous HTTP is the standard for REST APIs. |
| **Coupling** | Acceptable. Client must know the API endpoint and movie ID. |
| **Reliability** | HTTP includes built-in retry semantics (browser retries on 5xx). |
| **Ordering** | Not required. Each request is independent. |
| **Scalability** | Service A can scale horizontally behind an ALB. |

**Trade-offs**:
- ✓ Low latency, immediate feedback to user
- ✓ Simple, standard protocol (HTTP/REST)
- ✗ Client must wait for response (blocking)
- ✗ If Service A is slow, client experiences delay

**Alternative Considered**: Asynchronous (client polls for result)
- **Rejected**: Polling adds latency and complexity. REST API is the standard for this use case.

---

### Pattern 2: Service A → Event Processor (SQS)

**Interaction**: Publish View_Event to SQS queue

**Communication Type**: **Asynchronous (SQS)**

**Justification**:

| Factor | Analysis |
|---|---|
| **Latency Requirement** | Event processing can be delayed (eventual consistency acceptable). No need to block HTTP response. |
| **Coupling** | Loose coupling desired. Service A should not depend on Event Processor availability. |
| **Reliability** | SQS guarantees at-least-once delivery with automatic retries and DLQ. |
| **Ordering** | Not required. View events are independent; no strict ordering per movie. |
| **Scalability** | SQS buffers events during Lambda burst traffic; Lambda scales independently. |

**Trade-offs**:
- ✓ Service A remains responsive even if Event Processor is slow/unavailable
- ✓ Loose coupling: Service A does not know about Event Processor
- ✓ SQS buffers events during traffic spikes
- ✓ Automatic retries and DLQ for failed messages
- ✗ Events are processed with delay (eventual consistency)
- ✗ Requires idempotency handling (duplicate events possible)

**Implementation Detail**: **Fire-and-forget pattern**

Service A publishes to SQS without awaiting the result:

```typescript
// Inside GET /movies/:id handler
const movie = await this.dataStore.fetchMovie(params.movie_id);

// Fire-and-forget — does not delay HTTP response
this.sqsPublisher.publish({
  schemaVersion: '1.0',
  requestId: crypto.randomUUID(),
  movieId: params.movie_id,
  publishedAt: new Date().toISOString()
});

reply.code(HttpStatusCodes.OK).send(movie);
```

The HTTP response is sent immediately after fetching the movie. The SQS publish happens asynchronously in the background. If SQS fails, the error is logged but does not affect the HTTP response.

**Alternative Considered**: Synchronous (wait for Event Processor to acknowledge)
- **Rejected**: Would add 100–500 ms latency to every API request. Unacceptable for a REST API.

**Alternative Considered**: Direct HTTP call to Event Processor
- **Rejected**: Would create tight coupling. If Event Processor is unavailable, API requests fail. SQS provides buffering and retry semantics.

---

### Pattern 3: Event Processor → DynamoDB (Atomic Write)

**Interaction**: Increment viewCount in MovieStats table

**Communication Type**: **Synchronous (DynamoDB UpdateItem)**

**Justification**:

| Factor | Analysis |
|---|---|
| **Latency Requirement** | Lambda must complete within 30-second timeout. DynamoDB writes are fast (< 10 ms). |
| **Coupling** | Acceptable. Event Processor must write to DynamoDB; this is its primary responsibility. |
| **Reliability** | DynamoDB is a managed AWS service with 99.99% availability SLA. |
| **Ordering** | Not required. Concurrent increments are correctly aggregated via atomic ADD. |
| **Scalability** | DynamoDB on-demand billing scales automatically. |

**Trade-offs**:
- ✓ Atomic operation: no read-before-write, no race conditions
- ✓ Fast (< 10 ms latency)
- ✓ Managed service: no operational overhead
- ✗ Synchronous: Lambda must wait for write to complete
- ✗ If DynamoDB is unavailable, Lambda fails (but SQS retries)

**Atomic Increment Implementation**:

```typescript
// DynamoDB UpdateExpression with atomic ADD
const params = {
  TableName: 'MovieStats',
  Key: { movieId: event.movieId },
  UpdateExpression: 'ADD viewCount :one SET lastViewedAt = :ts, updatedAt = :now',
  ExpressionAttributeValues: {
    ':one': 1,
    ':ts': event.publishedAt,
    ':now': new Date().toISOString()
  }
};

await dynamodb.send(new UpdateCommand(params));
```

The `ADD` expression is atomic at the database level. Multiple Lambda instances can execute this concurrently on the same `movieId`, and DynamoDB correctly aggregates the increments.

**Alternative Considered**: Asynchronous (queue writes, batch later)
- **Rejected**: Adds complexity and latency. DynamoDB is fast enough for synchronous writes.

---

### Pattern 4: Event Processor → WebSocket Gateway (HTTP POST)

**Interaction**: Notify Gateway of updated statistics

**Communication Type**: **Synchronous (HTTP POST)**

**Justification**:

| Factor | Analysis |
|---|---|
| **Latency Requirement** | End-to-end latency budget is 500 ms. HTTP POST is fast (< 10 ms on same VPC). |
| **Coupling** | Acceptable. Event Processor must notify Gateway; this is part of the event processing flow. |
| **Reliability** | HTTP includes retry semantics. Lambda retries POST up to 2 times on failure. |
| **Ordering** | Not required. Gateway always queries DynamoDB for fresh stats before pushing. |
| **Scalability** | Gateway can scale horizontally; Lambda retries handle temporary unavailability. |

**Trade-offs**:
- ✓ Low latency (< 10 ms on same VPC)
- ✓ Simple: direct HTTP POST
- ✓ Gateway always has fresh data (queries DynamoDB)
- ✗ Synchronous: Lambda must wait for POST to complete
- ✗ If Gateway is unavailable, Lambda retries (adds latency)

**Implementation Detail**: **Retry logic**

```typescript
// Lambda notifies Gateway with retry logic
async function notifyGateway(movieId, viewCount, publishedAt) {
  const url = `${process.env.GATEWAY_INTERNAL_URL}/internal/notify`;
  const payload = { movieId, viewCount, publishedAt };
  
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 5000
      });
      
      if (response.ok) {
        return; // Success
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    
    if (attempt < 2) {
      await sleep(100 * Math.pow(2, attempt)); // Exponential backoff
    }
  }
  
  // Log failure but do not fail the SQS message
  console.warn(`Failed to notify Gateway after 3 attempts: ${lastError.message}`);
}
```

If all 3 attempts fail, the error is logged but the SQS message is marked as successful. The next event will carry fresh stats, so the push is self-healing.

**Alternative Considered**: Asynchronous (second SQS queue)
- **Rejected**: Would require Gateway to run a polling loop, adding latency and complexity. Direct HTTP is simpler and faster for a single consumer.

**Alternative Considered**: SNS (fan-out to multiple subscribers)
- **Rejected**: Overkill for a single subscriber (Gateway). SQS or direct HTTP is simpler.

---

### Pattern 5: WebSocket Gateway → DynamoDB (Query)

**Interaction**: Fetch top-10 movies by viewCount

**Communication Type**: **Synchronous (DynamoDB Query)**

**Justification**:

| Factor | Analysis |
|---|---|
| **Latency Requirement** | Gateway must respond to Lambda notification within 100 ms to meet 500 ms end-to-end budget. |
| **Coupling** | Acceptable. Gateway must read from DynamoDB; this is its primary data source. |
| **Reliability** | DynamoDB is a managed service with 99.99% availability. |
| **Ordering** | Required. Top-10 must be sorted by viewCount descending. |
| **Scalability** | DynamoDB GSI scales automatically. Query is efficient (< 10 ms). |

**Trade-offs**:
- ✓ Fast (< 10 ms latency)
- ✓ Sorted results (GSI on viewCount descending)
- ✓ Managed service: no operational overhead
- ✗ Synchronous: Gateway must wait for query to complete
- ✗ If DynamoDB is unavailable, Gateway cannot push updates

**Query Implementation**:

```typescript
// Query top-10 movies by viewCount (descending)
const params = {
  TableName: 'MovieStats',
  IndexName: 'pk-viewCount-index',
  KeyConditionExpression: 'pk = :pk',
  ExpressionAttributeValues: {
    ':pk': 'STATS'
  },
  ScanIndexForward: false, // Descending order
  Limit: 10
};

const result = await dynamodb.send(new QueryCommand(params));
const top10 = result.Items;
```

The GSI has a partition key `pk` (always "STATS") and a sort key `viewCount` (descending). This enables an efficient query for the top-10 movies.

**Alternative Considered**: Cache top-10 in memory
- **Rejected**: Would require cache invalidation logic. DynamoDB query is fast enough (< 10 ms).

---

### Pattern 6: WebSocket Gateway → Browser Clients (WebSocket Push)

**Interaction**: Broadcast stats_update to all connected clients

**Communication Type**: **Asynchronous (WebSocket push)**

**Justification**:

| Factor | Analysis |
|---|---|
| **Latency Requirement** | Dashboard should update within 500 ms of a view event. WebSocket push is fast (< 100 ms). |
| **Coupling** | Loose coupling. Gateway does not know client implementation details. |
| **Reliability** | WebSocket includes connection lifecycle events (onclose, onerror). Clients reconnect on failure. |
| **Ordering** | Not required. Each push contains the current state; out-of-order pushes are self-correcting. |
| **Scalability** | Gateway maintains in-memory connection registry. Scales to thousands of concurrent connections. |

**Trade-offs**:
- ✓ Low latency (< 100 ms)
- ✓ Server-initiated push (no polling)
- ✓ Bidirectional communication (future extensibility)
- ✗ Asynchronous: clients may receive updates out of order
- ✗ Requires connection management (onclose, onerror handlers)
- ✗ Single Gateway instance limits scalability (in-memory registry)

**Implementation Detail**: **Broadcast to all clients**

```typescript
// Gateway broadcasts stats_update to all connected clients
function broadcastStatsUpdate(top10, connectedClients, deliveredAt, publishedAt) {
  const message = JSON.stringify({
    type: 'stats_update',
    publishedAt,
    deliveredAt,
    connectedClients,
    top10
  });
  
  let successCount = 0;
  let failureCount = 0;
  
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message, (error) => {
        if (error) {
          failureCount++;
          client.close(); // Remove failed client
        } else {
          successCount++;
        }
      });
    }
  }
  
  console.log(`Broadcast: ${successCount} success, ${failureCount} failures`);
}
```

**Alternative Considered**: Polling (clients poll for updates)
- **Rejected**: Polling adds latency (seconds) and server load. WebSocket push is more efficient.

**Alternative Considered**: Server-Sent Events (SSE)
- **Rejected**: WebSocket is more efficient for bidirectional communication. SSE is unidirectional (server → client only).

---

### Pattern 7: Browser Client → WebSocket Gateway (WebSocket Connect)

**Interaction**: Establish WebSocket connection

**Communication Type**: **Asynchronous (WebSocket handshake)**

**Justification**:

| Factor | Analysis |
|---|---|
| **Latency Requirement** | Connection should establish within 1 second. WebSocket handshake is fast (< 100 ms). |
| **Coupling** | Loose coupling. Client knows Gateway URL; Gateway does not know client details. |
| **Reliability** | WebSocket includes connection lifecycle events. Clients reconnect on failure. |
| **Ordering** | Not required. Each connection is independent. |
| **Scalability** | Gateway maintains in-memory connection registry. Scales to thousands of concurrent connections. |

**Trade-offs**:
- ✓ Low latency (< 100 ms)
- ✓ Persistent connection (no repeated handshakes)
- ✓ Bidirectional communication
- ✗ Asynchronous: connection may fail
- ✗ Requires reconnection logic on client

**Implementation Detail**: **Exponential backoff reconnection**

```javascript
// Browser client reconnects with exponential backoff
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

function connectWebSocket() {
  const ws = new WebSocket(`ws://${window.location.host}/ws`);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
    reconnectAttempts = 0; // Reset on successful connection
  };
  
  ws.onclose = () => {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const backoffMs = Math.min(
        INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts),
        MAX_BACKOFF_MS
      );
      console.log(`Reconnecting in ${backoffMs}ms...`);
      setTimeout(connectWebSocket, backoffMs);
      reconnectAttempts++;
    } else {
      console.error('Max reconnection attempts reached');
      displayError('Connection lost. Please refresh the page.');
    }
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleStatsUpdate(message);
  };
}
```

---

## 2.3 Communication Matrix

| From | To | Protocol | Type | Latency | Reliability | Coupling |
|---|---|---|---|---|---|---|
| Browser | Service A | HTTP | Sync | < 200 ms | High (HTTP retries) | Tight |
| Service A | Event Processor | SQS | Async | 100–500 ms | Very High (at-least-once) | Loose |
| Event Processor | DynamoDB | DynamoDB API | Sync | < 10 ms | Very High (99.99% SLA) | Tight |
| Event Processor | Gateway | HTTP POST | Sync | < 10 ms | High (3 retries) | Tight |
| Gateway | DynamoDB | DynamoDB API | Sync | < 10 ms | Very High (99.99% SLA) | Tight |
| Gateway | Browser | WebSocket | Async | < 100 ms | Medium (reconnect logic) | Loose |
| Browser | Gateway | WebSocket | Async | < 100 ms | Medium (reconnect logic) | Loose |

---

## 2.4 Consistency Model Implications

### Eventual Consistency

The system uses **eventual consistency** for view counts:

1. **Service A** publishes View_Event to SQS (immediate)
2. **Event Processor** processes event and updates DynamoDB (100–500 ms delay)
3. **Gateway** queries DynamoDB and pushes to clients (< 100 ms after Event Processor)
4. **Browser** receives update and renders (< 100 ms after Gateway push)

**Total end-to-end latency**: 200–700 ms (typically 300–500 ms)

**Consistency window**: During this window, the dashboard may show stale view counts. After the window closes, all clients see the same, up-to-date counts.

**Trade-off**: Eventual consistency allows loose coupling and asynchronous processing. The alternative (strong consistency) would require synchronous processing, adding latency and coupling.

---

## 2.5 Failure Scenarios and Communication Resilience

### Scenario 1: Event Processor Unavailable

**What happens**:
1. Service A publishes View_Event to SQS (succeeds)
2. SQS buffers messages (no Lambda to consume)
3. When Event Processor recovers, SQS delivers buffered messages
4. Dashboard eventually updates with all buffered events

**Resilience**: ✓ High. SQS buffers events; no data loss.

---

### Scenario 2: DynamoDB Unavailable

**What happens**:
1. Event Processor receives SQS message
2. Attempts to write to DynamoDB (fails)
3. Lambda reports failure via `ReportBatchItemFailures`
4. SQS retries message (up to 3 times)
5. If all retries fail, message goes to DLQ

**Resilience**: ✓ Medium. Message is retried; if DynamoDB remains unavailable, message is isolated in DLQ.

---

### Scenario 3: Gateway Unavailable

**What happens**:
1. Event Processor receives SQS message
2. Writes to DynamoDB (succeeds)
3. Attempts HTTP POST to Gateway (fails)
4. Lambda retries POST (up to 3 times)
5. If all retries fail, error is logged; SQS message is marked successful

**Resilience**: ✓ Medium. View counts are written to DynamoDB; Gateway push is skipped. Next event will carry fresh stats.

---

### Scenario 4: Browser WebSocket Disconnects

**What happens**:
1. Browser detects `onclose` event
2. Starts exponential backoff reconnection (1s, 2s, 4s, ..., 30s)
3. After 10 failed attempts, displays "Connection lost. Please refresh the page."
4. When Gateway recovers, browser reconnects and receives `initial_state` message

**Resilience**: ✓ High. Client automatically reconnects; no manual intervention needed.

---

## 2.6 Summary: Communication Design Decisions

| Decision | Rationale | Trade-off |
|---|---|---|
| **Service A → Event Processor: Async (SQS)** | Loose coupling, buffering, reliability | Eventual consistency (200–500 ms delay) |
| **Event Processor → DynamoDB: Sync** | Atomic operations, fast, managed service | Tight coupling, synchronous failure |
| **Event Processor → Gateway: Sync (HTTP)** | Low latency, simple, self-healing | Tight coupling, retry logic needed |
| **Gateway → DynamoDB: Sync** | Fast queries, sorted results, managed service | Tight coupling, synchronous failure |
| **Gateway → Browser: Async (WebSocket)** | Low latency push, no polling, bidirectional | Loose consistency, reconnection logic |

**Overall**: The system uses a **hybrid model** optimized for each interaction:
- **Asynchronous** where loose coupling and buffering are valuable (Service A → Event Processor)
- **Synchronous** where latency and atomicity are critical (Event Processor → DynamoDB, Gateway → DynamoDB)
- **Real-time push** where low latency and user experience matter (Gateway → Browser)

This design balances **latency**, **reliability**, **coupling**, and **scalability** for the specific requirements of a real-time analytics dashboard.

---

This completes the **Communication Analysis** section. It covers:
✓ Justification for each communication pattern (sync vs async)
✓ Trade-offs for each choice
✓ Implementation details with code examples
✓ Communication matrix
✓ Consistency model implications
✓ Failure scenarios and resilience
✓ Summary of design decisions

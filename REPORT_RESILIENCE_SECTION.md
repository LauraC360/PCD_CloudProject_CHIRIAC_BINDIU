# 4. Reziliență (Resilience)

## 4.1 Overview

This section analyzes how the Realtime Analytics Dashboard system behaves when components fail, how it recovers, and what mechanisms are in place to ensure graceful degradation. Resilience is the system's ability to continue operating (possibly in a degraded state) despite failures and to recover automatically without manual intervention.

The system is designed with **fault isolation** and **graceful degradation** as core principles:
- Each component can fail independently without cascading to others
- The system continues operating in a reduced capacity rather than failing completely
- Automatic recovery mechanisms (retries, reconnection, buffering) restore full functionality

---

## 4.2 Failure Modes and Recovery

### Failure Mode 1: Service A (REST API) Crashes

**Scenario**: The Fastify server on ECS Fargate becomes unresponsive or crashes.

**What happens**:
1. Browser clients receive connection errors when calling `GET /movies/:id`
2. ECS health check fails (no response to `/health` endpoint)
3. ECS automatically restarts the container (within 30 seconds)
4. Browser clients retry the request (HTTP client-side retry logic)
5. After restart, Service A is available again

**Recovery time**: 30–60 seconds (ECS restart + browser retry)

**Impact on system**:
- ✗ API is unavailable during restart
- ✓ SQS queue is unaffected (no new events published during downtime)
- ✓ Event Processor continues processing buffered events
- ✓ Dashboard continues displaying cached data

**Mitigation**:
- ECS auto-scaling: Deploy multiple instances of Service A behind an ALB
- Health checks: ECS monitors `/health` endpoint and restarts failed instances
- Graceful shutdown: Service A completes in-flight requests before shutting down

**Code example** (ECS health check):
```typescript
// Fastify health check endpoint
fastify.get('/health', async (request, reply) => {
  const mongoConnected = await checkMongoConnection();
  const sqsConnected = await checkSQSConnection();
  
  if (mongoConnected && sqsConnected) {
    reply.code(200).send({ status: 'ok' });
  } else {
    reply.code(503).send({ status: 'degraded' });
  }
});
```

---

### Failure Mode 2: Event Processor (Lambda) Crashes or Times Out

**Scenario**: Lambda function fails to process an SQS message (exception, timeout, out-of-memory).

**What happens**:
1. Lambda throws an exception or times out (30-second limit)
2. Lambda reports the failure via `ReportBatchItemFailures`
3. SQS makes the failed message visible again (visibility timeout expires)
4. SQS retries the message (up to `maxReceiveCount = 3` times)
5. After 3 failed attempts, SQS routes the message to the Dead Letter Queue (DLQ)

**Recovery time**: 
- First retry: 60 seconds (visibility timeout)
- Second retry: 60 seconds
- Third retry: 60 seconds
- Total: ~3 minutes before message goes to DLQ

**Impact on system**:
- ✗ Affected events are not processed immediately
- ✓ Other events in the queue are processed normally (batch failure isolation)
- ✓ API remains responsive (SQS is asynchronous)
- ✓ Dashboard continues displaying cached data

**Mitigation**:
- Batch failure isolation: Use `ReportBatchItemFailures` to retry only failed messages
- DLQ monitoring: CloudWatch alarms alert on DLQ messages
- Manual intervention: Operators can inspect DLQ and replay messages

**Code example** (batch failure handling):
```typescript
// Lambda handler with batch failure reporting
export async function handler(event) {
  const batchItemFailures = [];
  
  for (const record of event.Records) {
    try {
      await processEvent(record);
    } catch (error) {
      console.error(`Failed to process message ${record.messageId}:`, error);
      batchItemFailures.push({
        itemIdentifier: record.messageId
      });
    }
  }
  
  return { batchItemFailures };
}
```

---

### Failure Mode 3: DynamoDB Temporarily Unavailable

**Scenario**: DynamoDB is unreachable (network issue, AWS service degradation, throttling).

**What happens**:
1. Event Processor attempts to write to DynamoDB (fails)
2. Lambda catches the exception and reports failure via `ReportBatchItemFailures`
3. SQS retries the message (up to 3 times)
4. If DynamoDB recovers, the retry succeeds
5. If DynamoDB remains unavailable, message goes to DLQ

**Recovery time**: Depends on DynamoDB recovery (typically < 1 minute for transient issues)

**Impact on system**:
- ✗ View counts are not updated during outage
- ✓ API remains responsive (SQS is asynchronous)
- ✓ Dashboard displays cached data (no errors)
- ✓ When DynamoDB recovers, buffered events are processed

**Mitigation**:
- DynamoDB on-demand billing: Automatically scales capacity (no throttling)
- Multi-AZ deployment: DynamoDB replicates across availability zones
- CloudWatch alarms: Alert on DynamoDB errors
- Exponential backoff: Lambda retries with increasing delays

**Code example** (exponential backoff retry):
```typescript
// Retry with exponential backoff
async function writeWithRetry(params, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await dynamodb.send(new UpdateCommand(params));
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      
      const backoffMs = Math.pow(2, attempt) * 100; // 100ms, 200ms, 400ms
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}
```

---

### Failure Mode 4: WebSocket Gateway Crashes

**Scenario**: The Node.js WebSocket server on ECS Fargate crashes or becomes unresponsive.

**What happens**:
1. Browser clients detect `onclose` event (WebSocket connection drops)
2. Browser clients start exponential backoff reconnection (1s, 2s, 4s, ..., 30s)
3. ECS health check fails; ECS restarts the container (within 30 seconds)
4. Browser clients reconnect to the restarted Gateway
5. Gateway sends `initial_state` message with current top-10 movies

**Recovery time**: 30–60 seconds (ECS restart + browser reconnection)

**Impact on system**:
- ✗ Dashboard is not updated during outage
- ✓ API continues working (Service A is independent)
- ✓ Event Processor continues processing (independent)
- ✓ When Gateway recovers, clients reconnect and receive fresh data

**Mitigation**:
- ECS auto-scaling: Deploy multiple instances of Gateway behind an ALB
- Health checks: ECS monitors `/health` endpoint
- Client-side reconnection: Browser implements exponential backoff
- Graceful shutdown: Gateway closes connections cleanly

**Code example** (Gateway health check):
```typescript
// WebSocket Gateway health check
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    connectedClients: wss.clients.size,
    backpressureActive: backpressure.isActive(),
    uptime: process.uptime()
  };
  res.json(health);
});
```

**Code example** (Browser reconnection):
```javascript
// Browser exponential backoff reconnection
let reconnectAttempts = 0;
const MAX_ATTEMPTS = 10;
const INITIAL_BACKOFF = 1000;
const MAX_BACKOFF = 30000;

function connectWebSocket() {
  const ws = new WebSocket(`ws://${window.location.host}/ws`);
  
  ws.onopen = () => {
    console.log('Connected');
    reconnectAttempts = 0;
  };
  
  ws.onclose = () => {
    if (reconnectAttempts < MAX_ATTEMPTS) {
      const backoff = Math.min(
        INITIAL_BACKOFF * Math.pow(2, reconnectAttempts),
        MAX_BACKOFF
      );
      console.log(`Reconnecting in ${backoff}ms...`);
      setTimeout(connectWebSocket, backoff);
      reconnectAttempts++;
    } else {
      displayError('Connection lost. Please refresh the page.');
    }
  };
}
```

---

### Failure Mode 5: Network Partition (Service A ↔ Event Processor)

**Scenario**: Network connectivity between Service A and SQS is lost (or between Lambda and DynamoDB).

**What happens**:
1. Service A attempts to publish to SQS (fails with timeout)
2. Service A logs the error and returns HTTP 200 anyway (fire-and-forget)
3. Browser client receives the movie data (API is responsive)
4. When network recovers, Service A publishes buffered events (if any)
5. Event Processor processes events normally

**Recovery time**: Depends on network recovery (typically < 1 minute)

**Impact on system**:
- ✓ API remains responsive (fire-and-forget pattern)
- ✗ Events published during partition are lost (not buffered by Service A)
- ✓ When network recovers, new events are published normally
- ✓ Dashboard may show stale data temporarily

**Mitigation**:
- Fire-and-forget pattern: API never blocks on SQS publish
- Metrics tracking: Service A tracks publish errors
- Network redundancy: Deploy components in multiple AZs
- Monitoring: CloudWatch alarms on publish errors

**Code example** (fire-and-forget with error handling):
```typescript
// Service A publishes without awaiting
async function publishViewEvent(movieId) {
  try {
    // Non-blocking publish (no await)
    this.sqsPublisher.publish({
      schemaVersion: '1.0',
      requestId: crypto.randomUUID(),
      movieId,
      publishedAt: new Date().toISOString()
    });
    
    this.metrics.totalPublished++;
  } catch (error) {
    console.error('Failed to publish View_Event:', error);
    this.metrics.publishErrors++;
    // Do NOT throw — API response is not affected
  }
}
```

---

### Failure Mode 6: MongoDB Atlas Unavailable

**Scenario**: MongoDB Atlas (external service) is unreachable or slow.

**What happens**:
1. Service A attempts to fetch movie from MongoDB (fails or times out)
2. Service A returns HTTP 503 (Service Unavailable)
3. Browser client receives error; may retry or display error message
4. No View_Event is published (because movie fetch failed)
5. When MongoDB recovers, API works normally

**Recovery time**: Depends on MongoDB recovery (typically < 1 minute)

**Impact on system**:
- ✗ API is unavailable
- ✓ Event Processor continues processing buffered events
- ✓ Dashboard continues displaying cached data
- ✓ No events are lost (because none were published)

**Mitigation**:
- Connection pooling: Reuse connections to MongoDB
- Read replicas: MongoDB Atlas provides automatic failover
- Timeouts: Service A times out after 5 seconds (does not hang)
- Monitoring: CloudWatch alarms on MongoDB errors

**Code example** (MongoDB timeout):
```typescript
// Fastify MongoDB plugin with timeout
const mongoClient = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 5000,
  connectTimeoutMS: 5000
});
```

---

## 4.3 Resilience Patterns

### Pattern 1: Bulkhead Isolation

**Definition**: Isolate failures to prevent them from cascading to other components.

**Implementation**:
- Service A publishes to SQS (fire-and-forget) — SQS failure does not affect API
- Event Processor writes to DynamoDB — DynamoDB failure does not affect SQS processing
- Gateway queries DynamoDB — DynamoDB failure does not affect WebSocket connections

**Example**:
```
Service A failure → Event Processor continues processing buffered events
Event Processor failure → API continues serving requests
Gateway failure → API and Event Processor continue working
```

---

### Pattern 2: Retry with Exponential Backoff

**Definition**: Retry failed operations with increasing delays to avoid overwhelming the system.

**Implementation**:
- SQS retries failed messages (3 times, 60-second visibility timeout)
- Lambda retries HTTP POST to Gateway (3 times, exponential backoff)
- Browser reconnects to WebSocket (10 times, exponential backoff)

**Example**:
```
Attempt 1: Immediate
Attempt 2: Wait 100ms, retry
Attempt 3: Wait 200ms, retry
Attempt 4: Wait 400ms, retry
...
Attempt N: Wait min(2^(N-1) * 100ms, 30s), retry
```

---

### Pattern 3: Dead Letter Queue (DLQ)

**Definition**: Route permanently failed messages to a separate queue for inspection and manual recovery.

**Implementation**:
- SQS DLQ: Messages that fail 3 times go to `view-events-dlq`
- DLQ retention: 4 days (allows time for investigation)
- Monitoring: CloudWatch alarms on DLQ messages

**Example**:
```
Message fails 3 times → SQS routes to DLQ
Operator inspects DLQ → Identifies root cause
Operator replays message → Event is processed
```

---

### Pattern 4: Graceful Degradation

**Definition**: Continue operating in a reduced capacity when components fail.

**Implementation**:
- API remains responsive even if Event Processor is unavailable
- Dashboard displays cached data even if Gateway is unavailable
- Event Processor continues processing even if Gateway is unavailable

**Example**:
```
Normal: API → SQS → Lambda → DynamoDB → Gateway → Dashboard
Degraded (Gateway down): API → SQS → Lambda → DynamoDB (no push to Dashboard)
Degraded (Lambda down): API → SQS (buffered) (no updates to Dashboard)
Degraded (API down): (no new events) (Dashboard shows cached data)
```

---

### Pattern 5: Health Checks and Auto-Recovery

**Definition**: Monitor component health and automatically restart failed instances.

**Implementation**:
- ECS health checks: `/health` endpoint on Service A and Gateway
- Auto-restart: ECS restarts failed containers within 30 seconds
- CloudWatch alarms: Alert on repeated failures

**Example**:
```
ECS detects Service A health check failure
ECS waits 30 seconds (grace period)
ECS restarts Service A container
Service A recovers and becomes available
```

---

### Pattern 6: Idempotency

**Definition**: Ensure that retried operations produce the same result as the original operation.

**Implementation**:
- ProcessedEvents table: Tracks processed `requestId` values
- Conditional writes: `PutItem` with `attribute_not_exists(requestId)`
- TTL: Idempotency records expire after 24 hours

**Example**:
```
Event 1: requestId=UUID-A → processed, stored in ProcessedEvents
Event 1 (retry): requestId=UUID-A → skipped (already in ProcessedEvents)
Result: viewCount incremented once (not twice)
```

---

## 4.4 Failure Scenarios and Recovery

### Scenario 1: Cascading Failure (Service A → Event Processor → DynamoDB)

**What happens**:
1. Service A publishes View_Event to SQS
2. Event Processor receives message
3. Event Processor attempts to write to DynamoDB (fails)
4. Event Processor reports failure via `ReportBatchItemFailures`
5. SQS retries message (up to 3 times)
6. If DynamoDB remains unavailable, message goes to DLQ

**Recovery**:
- ✓ When DynamoDB recovers, SQS retries the message
- ✓ Event Processor processes the message successfully
- ✓ Dashboard updates with the delayed event

**Time to recovery**: 3–5 minutes (3 retries × 60-second visibility timeout)

---

### Scenario 2: Partial Failure (Some Events Fail, Others Succeed)

**What happens**:
1. Event Processor receives batch of 10 messages
2. 8 messages are processed successfully
3. 2 messages fail (e.g., invalid movieId)
4. Event Processor reports 2 failures via `ReportBatchItemFailures`
5. SQS retries only the 2 failed messages

**Recovery**:
- ✓ 8 successful events are processed immediately
- ✓ 2 failed events are retried (may eventually go to DLQ)
- ✓ Dashboard updates with the 8 successful events

**Time to recovery**: Immediate for successful events; 3–5 minutes for failed events

---

### Scenario 3: Cascading Failure (Gateway → Browser Clients)

**What happens**:
1. Gateway crashes
2. All connected browser clients receive `onclose` event
3. Browser clients start exponential backoff reconnection
4. ECS restarts Gateway container
5. Browser clients reconnect

**Recovery**:
- ✓ Browser clients automatically reconnect
- ✓ Gateway sends `initial_state` message with current data
- ✓ Dashboard updates with fresh data

**Time to recovery**: 30–60 seconds (ECS restart + browser reconnection)

---

### Scenario 4: Permanent Failure (Unrecoverable Error)

**What happens**:
1. Event Processor receives message with invalid JSON
2. Event Processor fails to parse message
3. Event Processor reports failure via `ReportBatchItemFailures`
4. SQS retries message 3 times (all fail)
5. Message goes to DLQ

**Recovery**:
- ✓ Operator inspects DLQ
- ✓ Operator identifies root cause (invalid JSON)
- ✓ Operator fixes the issue (e.g., update Service A to validate JSON)
- ✓ Operator replays message (or discards if unrecoverable)

**Time to recovery**: Manual (depends on operator response time)

---

## 4.5 Resilience Metrics

### Metrics to Track

| Metric | Target | Measurement |
|---|---|---|
| **Availability** | 99.9% | Uptime / Total time |
| **Mean Time to Recovery (MTTR)** | < 5 minutes | Time from failure to recovery |
| **Mean Time Between Failures (MTBF)** | > 30 days | Time between failures |
| **Error Rate** | < 0.1% | Failed requests / Total requests |
| **DLQ Message Rate** | < 0.01% | DLQ messages / Total messages |
| **Retry Success Rate** | > 99% | Successful retries / Total retries |

### CloudWatch Alarms

```typescript
// CloudWatch alarm: DLQ messages
new Alarm(stack, 'DLQMessagesAlarm', {
  metric: new Metric({
    namespace: 'AWS/SQS',
    metricName: 'ApproximateNumberOfMessagesVisible',
    dimensions: { QueueName: 'view-events-dlq' }
  }),
  threshold: 10,
  evaluationPeriods: 1,
  alarmDescription: 'Alert if DLQ has > 10 messages'
});

// CloudWatch alarm: Lambda errors
new Alarm(stack, 'LambdaErrorsAlarm', {
  metric: new Metric({
    namespace: 'AWS/Lambda',
    metricName: 'Errors',
    dimensions: { FunctionName: 'event-processor' }
  }),
  threshold: 10,
  evaluationPeriods: 5,
  alarmDescription: 'Alert if Lambda has > 10 errors in 5 minutes'
});

// CloudWatch alarm: DynamoDB throttling
new Alarm(stack, 'DynamoDBThrottlingAlarm', {
  metric: new Metric({
    namespace: 'AWS/DynamoDB',
    metricName: 'UserErrors',
    dimensions: { TableName: 'MovieStats' }
  }),
  threshold: 1,
  evaluationPeriods: 1,
  alarmDescription: 'Alert if DynamoDB has throttling errors'
});
```

---

## 4.6 Resilience Testing

### Test 1: Chaos Engineering — Kill Event Processor

**Objective**: Verify that the system continues operating when Event Processor is unavailable.

**Test procedure**:
1. Start the system (Service A, Event Processor, Gateway, Dashboard)
2. Publish 100 View_Events to SQS
3. Kill the Event Processor Lambda function
4. Verify that Service A continues serving requests (API is responsive)
5. Verify that Dashboard displays cached data (no errors)
6. Restart Event Processor
7. Verify that buffered events are processed (viewCount increases)

**Expected result**: ✓ System continues operating; events are processed after recovery

---

### Test 2: Chaos Engineering — Simulate DynamoDB Throttling

**Objective**: Verify that the system recovers from DynamoDB throttling.

**Test procedure**:
1. Start the system
2. Publish 1000 View_Events rapidly (simulate traffic spike)
3. DynamoDB throttles (returns 400 errors)
4. Verify that Event Processor retries (exponential backoff)
5. Verify that SQS buffers messages
6. Wait for DynamoDB to recover
7. Verify that buffered events are processed

**Expected result**: ✓ System recovers; all events are eventually processed

---

### Test 3: Chaos Engineering — Kill Gateway

**Objective**: Verify that browser clients reconnect when Gateway crashes.

**Test procedure**:
1. Start the system
2. Connect 10 browser clients to Gateway
3. Verify that clients receive stats_update messages
4. Kill the Gateway container
5. Verify that clients detect disconnection (onclose event)
6. Verify that clients start exponential backoff reconnection
7. Restart Gateway
8. Verify that clients reconnect and receive initial_state message

**Expected result**: ✓ Clients automatically reconnect; no manual intervention needed

---

### Test 4: Resilience Under Load

**Objective**: Verify that the system remains resilient under high load.

**Test procedure**:
1. Start the system
2. Simulate 200 concurrent users (load test)
3. Each user calls GET /movies/:id every 1 second
4. Publish 200 View_Events per second to SQS
5. Monitor error rate, latency, and DLQ messages
6. Verify that error rate < 0.1%
7. Verify that DLQ messages < 0.01%
8. Verify that latency p99 < 500 ms

**Expected result**: ✓ System remains resilient under load

---

## 4.7 Resilience Best Practices

### 1. Design for Failure

- Assume every component will fail at some point
- Design the system to continue operating (possibly degraded) when components fail
- Use bulkhead isolation to prevent cascading failures

### 2. Implement Retries with Exponential Backoff

- Retry failed operations with increasing delays
- Avoid overwhelming the system with rapid retries
- Set a maximum number of retries (e.g., 3)

### 3. Use Dead Letter Queues

- Route permanently failed messages to a separate queue
- Monitor DLQ for failures
- Implement manual recovery procedures

### 4. Monitor and Alert

- Track key metrics (availability, error rate, DLQ messages)
- Set up CloudWatch alarms for anomalies
- Respond quickly to alerts

### 5. Test Resilience

- Use chaos engineering to test failure scenarios
- Verify that the system recovers automatically
- Document recovery procedures

### 6. Implement Health Checks

- Expose `/health` endpoints on all components
- Use health checks for auto-recovery (ECS restarts)
- Monitor health check failures

### 7. Use Idempotency

- Ensure that retried operations produce the same result
- Use unique identifiers (requestId) to detect duplicates
- Store processed identifiers with TTL for cleanup

---

## 4.8 Summary: Resilience Analysis

| Aspect | Implementation | Benefit |
|---|---|---|
| **Bulkhead Isolation** | Fire-and-forget SQS, independent components | Failures don't cascade |
| **Retry Logic** | SQS retries, exponential backoff | Transient failures are recovered |
| **Dead Letter Queue** | DLQ for permanently failed messages | Failures are isolated and visible |
| **Graceful Degradation** | API responsive even if Event Processor down | System continues operating |
| **Health Checks** | `/health` endpoints, ECS auto-restart | Failures are detected and recovered |
| **Idempotency** | ProcessedEvents table with TTL | Retries don't cause duplicates |
| **Client Reconnection** | Exponential backoff in browser | Clients automatically recover |

**Conclusion**: The system is designed to be resilient to common failure modes. Each component can fail independently without cascading to others. Automatic recovery mechanisms (retries, reconnection, buffering) restore full functionality without manual intervention. The system continues operating in a degraded state when components fail, ensuring high availability for the analytics dashboard.

---

This completes the **Resilience Section**. It covers:
✓ 6 failure modes and recovery procedures
✓ 6 resilience patterns (bulkhead, retry, DLQ, degradation, health checks, idempotency)
✓ 4 failure scenarios with recovery analysis
✓ Resilience metrics and CloudWatch alarms
✓ 4 chaos engineering tests
✓ 7 resilience best practices
✓ Summary of resilience implementation

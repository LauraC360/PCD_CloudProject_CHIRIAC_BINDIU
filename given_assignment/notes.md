# Project Notes

## Decisions

- **Project:** Project 1 - Dashboard de Analytics in Timp Real
- **Base app:** Fast Lazy Bee (movies API, Node.js / Fastify / MongoDB)
- **Cloud provider:** AWS
- **Fast Lazy Bee deployment:** ECS Fargate
- **MongoDB:** MongoDB Atlas free tier (M0) — swap `MONGO_URL` env var in ECS, no code changes needed
- **Frontend:** Vanilla HTML + JS, Tailwind CSS (CDN), Chart.js (CDN) for graphs
- **Frontend hosting:** S3 static website

## Architecture Notes

### SQS → Lambda (Event Processing)

- SQS batch size: 5 — Lambda is triggered per batch, not per message
- Multiple batches can trigger parallel Lambda instances (e.g. 11 messages → 2 Lambdas running simultaneously)
- Each Lambda aggregates its batch first (e.g. movie A: 3 views, movie B: 2 views) before writing
- Writes to DynamoDB use atomic `ADD` operations — no read-then-write, so no data races even with parallel Lambdas
- DynamoDB handles concurrency at the DB level, making parallel Lambda execution safe

This also satisfies the assignment's idempotency requirement for at-least-once SQS delivery.

### Fast Lazy Bee — Deployment (ECS Fargate)

- **ECS Fargate** — runs the existing Docker container without managing EC2 instances
- Flow: build image → push to ECR → create Task Definition → create ECS Service
- **ECR** stores the Docker image (AWS's private registry)
- **Task Definition** = config (image, CPU, memory, env vars)
- **ECS Service** = keeps the task running, restarts on crash
- **IAM role** on the task for SQS access
- **Environment variables** injected via ECS (SQS URL, MongoDB URL, etc.) — never hardcode

```bash
# build and push to ECR
docker build -t fast-lazy-bee .
aws ecr get-login-password | docker login --username AWS --password-stdin <ecr-url>
docker tag fast-lazy-bee:latest <ecr-url>/fast-lazy-bee:latest
docker push <ecr-url>/fast-lazy-bee:latest
```

### Fast Lazy Bee — SQS Integration

Use a Fastify `onResponse` hook (global middleware) to publish to SQS on every `GET /movies/:id` call — keeps route handlers clean and unaware of SQS.

### SQS Configuration

- **Queue type:** Standard (not FIFO) — higher throughput, ordering not needed
- **Visibility timeout:** must be higher than Lambda timeout (e.g. Lambda = 30s → visibility timeout = 60s), otherwise SQS re-delivers while Lambda is still running
- **Dead Letter Queue (DLQ):** route repeatedly failing messages here instead of infinite retry loop
- **Batch size:** 5

### Lambda Configuration

- **SQS event source mapping** to connect SQS → Lambda and control batch size
- **Partial batch response** (`ReportBatchItemFailures`) — on failure, only the failed message goes back to SQS, not the whole batch
- **Timeout:** 30s
- **IAM permissions:** read from SQS, write to DynamoDB

### DynamoDB Configuration

- **Partition key:** `movieId` (string)
- **Atomic increments:** use `ADD` in `UpdateExpression` — no read-then-write needed
- **Capacity mode:** on-demand — scales automatically with Lambda bursts, no provisioning needed
- **TTL:** optional, can auto-expire old stats

## TODO

- Deep dive on metrics storage and measurement (DynamoDB vs CloudWatch, load testing setup)
- Deep dive on metrics publishing (how to get latency data to the frontend dashboard for the bonus)

## WebSocket Gateway (up for debate)

Leaning towards **Option 2: custom Node.js WebSocket server on ECS Fargate** (using `ws` library):
- Simpler to build and debug
- Connected users count is just `wss.clients.size` — no extra infra
- Lambda notifies it via HTTP POST, server broadcasts to all clients
- In-memory connections — doesn't scale horizontally, but load testing targets Fast Lazy Bee not the gateway, so this is fine for the project

Option 1 (API Gateway WebSocket) is the more "correct" AWS-native approach but adds complexity (DynamoDB for connection IDs, API Gateway route config).

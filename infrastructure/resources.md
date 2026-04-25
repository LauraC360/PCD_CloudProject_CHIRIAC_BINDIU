# Infrastructure Resources

This file documents all AWS resources provisioned for the Realtime Analytics Dashboard.
Replace placeholder values (`<region>`, `<account-id>`, `<arn>`, `<url>`) with actual values
after running the provisioning scripts.

---

## SQS Queues

### `view-events` (Standard Queue)

| Field                  | Value                                                                 |
|------------------------|-----------------------------------------------------------------------|
| **Queue Name**         | `view-events`                                                         |
| **Queue URL**          | `https://sqs.<region>.amazonaws.com/<account-id>/view-events`        |
| **Queue ARN**          | `arn:aws:sqs:<region>:<account-id>:view-events`                      |
| **VisibilityTimeout**  | 60 seconds                                                            |
| **MessageRetention**   | 86400 seconds (24 hours)                                              |
| **maxReceiveCount**    | 3 (before routing to DLQ)                                            |
| **Dead Letter Queue**  | `view-events-dlq`                                                     |
| **Provisioning script**| `infrastructure/sqs/create-queues.sh`                                |

> Validates: Requirement 8.4 — SQS_Queue SHALL be configured with a minimum of 3 retries
> before sending to DLQ and a VisibilityTimeout of 60 seconds.

---

### `view-events-dlq` (Dead Letter Queue)

| Field                  | Value                                                                 |
|------------------------|-----------------------------------------------------------------------|
| **Queue Name**         | `view-events-dlq`                                                     |
| **Queue URL**          | `https://sqs.<region>.amazonaws.com/<account-id>/view-events-dlq`   |
| **Queue ARN**          | `arn:aws:sqs:<region>:<account-id>:view-events-dlq`                 |
| **MessageRetention**   | 1209600 seconds (14 days)                                             |
| **Provisioning script**| `infrastructure/sqs/create-queues.sh`                                |

---

## DynamoDB Tables

> Tables will be documented here after Task 2.3 and 2.4 are completed.

### `MovieStats` _(pending Task 2.3)_

| Field          | Value       |
|----------------|-------------|
| **Table Name** | `MovieStats` |
| **Table ARN**  | `<arn>`      |
| **Billing**    | PAY_PER_REQUEST |
| **Partition Key** | `movieId` (String) |
| **GSI**        | `viewCount-index` (pk String, viewCount Number) |

---

### `ProcessedEvents` _(pending Task 2.4)_

| Field          | Value            |
|----------------|------------------|
| **Table Name** | `ProcessedEvents` |
| **Table ARN**  | `<arn>`           |
| **Billing**    | PAY_PER_REQUEST   |
| **Partition Key** | `requestId` (String) |
| **TTL Attribute** | `ttl`          |

---

## IAM Roles

> Roles will be documented here after Tasks 2.5 and 2.6 are completed.

### Lambda Execution Role _(pending Task 2.5)_

| Field         | Value   |
|---------------|---------|
| **Role Name** | `<name>` |
| **Role ARN**  | `<arn>`  |

### ECS Task Role _(pending Task 2.6)_

| Field         | Value   |
|---------------|---------|
| **Role Name** | `<name>` |
| **Role ARN**  | `<arn>`  |

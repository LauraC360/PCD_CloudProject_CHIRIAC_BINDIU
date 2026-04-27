# Infrastructure Resources

> **After deploying**, run `cdk deploy --profile pers` and replace all placeholder values:
> - `<account-id>` → your AWS account ID (e.g. `123456789012`)
> - `<region>` → your deployment region (e.g. `us-east-1`)
> - `<vpc-id>`, `<subnet-id-*>`, `<namespace-id>` → values from CDK stack outputs
>
> Run `aws cloudformation describe-stacks --stack-name InfraStack --profile pers --region us-east-1 --query "Stacks[0].Outputs"` to retrieve all output values at once.

---

## VPC

| Field | Value |
|---|---|
| Name | `AnalyticsVpc` |
| VPC ID | `<vpc-id>` |
| CIDR | `10.0.0.0/16` (CDK default) |
| AZs | 2 |
| Public Subnets | `<subnet-id-pub-1>`, `<subnet-id-pub-2>` |
| Private Subnets | `<subnet-id-priv-1>`, `<subnet-id-priv-2>` |
| NAT Gateway | None (App Runner has outbound internet natively) |
| CDK export — VPC ID | `AnalyticsVpcId` |
| CDK export — Public subnet IDs | `AnalyticsPublicSubnetIds` |
| CDK export — Private subnet IDs | `AnalyticsPrivateSubnetIds` |

---

## SQS Queues

### `view-events` (Standard Queue)

| Field | Value |
|---|---|
| Queue Name | `view-events` |
| Queue URL | `https://sqs.<region>.amazonaws.com/<account-id>/view-events` |
| Queue ARN | `arn:aws:sqs:<region>:<account-id>:view-events` |
| Visibility Timeout | 60 seconds |
| Retention Period | 4 days |
| Max Receive Count | 3 (then routed to DLQ) |
| Dead Letter Queue | `view-events-dlq` |
| CDK export — URL | `AnalyticsViewEventsQueueUrl` |
| CDK export — ARN | `AnalyticsViewEventsQueueArn` |

### `view-events-dlq` (Dead Letter Queue)

| Field | Value |
|---|---|
| Queue Name | `view-events-dlq` |
| Queue URL | `https://sqs.<region>.amazonaws.com/<account-id>/view-events-dlq` |
| Queue ARN | `arn:aws:sqs:<region>:<account-id>:view-events-dlq` |
| Retention Period | 4 days |
| CDK export — URL | `AnalyticsViewEventsDlqUrl` |
| CDK export — ARN | `AnalyticsViewEventsDlqArn` |

---

## DynamoDB Tables

### `MovieStats`

| Field | Value |
|---|---|
| Table Name | `MovieStats` |
| Table ARN | `arn:aws:dynamodb:<region>:<account-id>:table/MovieStats` |
| Billing Mode | `PAY_PER_REQUEST` |
| Partition Key | `movieId` (String) |
| GSI | `viewCount-index` — PK `pk` (String), SK `viewCount` (Number), projection `ALL` |
| Removal Policy | `DESTROY` |
| CDK export — Name | `AnalyticsMovieStatsTableName` |
| CDK export — ARN | `AnalyticsMovieStatsTableArn` |

### `ProcessedEvents`

| Field | Value |
|---|---|
| Table Name | `ProcessedEvents` |
| Table ARN | `arn:aws:dynamodb:<region>:<account-id>:table/ProcessedEvents` |
| Billing Mode | `PAY_PER_REQUEST` |
| Partition Key | `requestId` (String) |
| TTL Attribute | `ttl` (items expire after 24 h — idempotency window) |
| Removal Policy | `DESTROY` |
| CDK export — Name | `AnalyticsProcessedEventsTableName` |
| CDK export — ARN | `AnalyticsProcessedEventsTableArn` |

### `RecentActivity`

| Field | Value |
|---|---|
| Table Name | `RecentActivity` |
| Table ARN | `arn:aws:dynamodb:<region>:<account-id>:table/RecentActivity` |
| Billing Mode | `PAY_PER_REQUEST` |
| Partition Key | `pk` (String, day-scoped `ACTIVITY#YYYY-MM-DD`) |
| Sort Key | `viewedAt` (Number, epoch ms) |
| TTL Attribute | `ttl` |
| Removal Policy | `DESTROY` |
| CDK export — Name | `AnalyticsRecentActivityTableName` |
| CDK export — ARN | `AnalyticsRecentActivityTableArn` |

---

## Cloud Map

### Namespace `local`

| Field | Value |
|---|---|
| Namespace Name | `local` |
| Namespace ID | `<namespace-id>` |
| Type | Private DNS (VPC-scoped) |
| VPC | `AnalyticsVpc` |
| Registered Service | `wsg` → resolves to `wsg.local` |
| DNS Record Type | A |
| DNS TTL | 60 seconds |
| Internal URL (Lambda → WSG) | `http://wsg.local:8081` |
| CDK export — Namespace ID | `AnalyticsCloudMapNamespaceId` |

---

## CDK Stack Outputs

This is the reference for wiring up env vars across services. All exports are in CloudFormation stack `InfraStack`.

| CDK Export Name | Contains | Used by |
|---|---|---|
| `AnalyticsVpcId` | VPC ID | ECS, Lambda CDK constructs |
| `AnalyticsPublicSubnetIds` | Comma-separated public subnet IDs | ECS Fargate service, ALB |
| `AnalyticsPrivateSubnetIds` | Comma-separated private subnet IDs | Lambda, ECS tasks |
| `AnalyticsViewEventsQueueUrl` | `view-events` queue URL | Service A (`SQS_QUEUE_URL`) |
| `AnalyticsViewEventsQueueArn` | `view-events` queue ARN | Lambda event source mapping |
| `AnalyticsViewEventsDlqUrl` | `view-events-dlq` queue URL | Monitoring / alerting |
| `AnalyticsViewEventsDlqArn` | `view-events-dlq` queue ARN | IAM policies |
| `AnalyticsMovieStatsTableName` | `MovieStats` table name | Lambda (`DYNAMODB_TABLE_STATS`), WSG (`DYNAMODB_TABLE_STATS`) |
| `AnalyticsMovieStatsTableArn` | `MovieStats` table ARN | IAM policies |
| `AnalyticsProcessedEventsTableName` | `ProcessedEvents` table name | Lambda (`DYNAMODB_TABLE_EVENTS`) |
| `AnalyticsProcessedEventsTableArn` | `ProcessedEvents` table ARN | IAM policies |
| `AnalyticsRecentActivityTableName` | `RecentActivity` table name | Lambda (`DYNAMODB_TABLE_RECENT_ACTIVITY`), WSG (`DYNAMODB_TABLE_RECENT_ACTIVITY`) |
| `AnalyticsRecentActivityTableArn` | `RecentActivity` table ARN | IAM policies |
| `AnalyticsCloudMapNamespaceId` | Cloud Map namespace ID | ECS service registration (Task 3.7) |

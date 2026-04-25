#!/usr/bin/env bash
# =============================================================================
# create-queues.sh
# Provisions the SQS queues required by the Realtime Analytics Dashboard.
#
# Queues created:
#   1. view-events-dlq  — Dead Letter Queue (must exist before the main queue)
#   2. view-events      — Standard queue with VisibilityTimeout=60s and a
#                         redrive policy pointing to view-events-dlq
#                         (maxReceiveCount=3)
#
# Usage:
#   export AWS_REGION=us-east-1
#   export AWS_ACCOUNT_ID=123456789012
#   bash infrastructure/sqs/create-queues.sh
#
# The script is idempotent: it checks whether each queue already exists before
# attempting to create it.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Validate required environment variables
# ---------------------------------------------------------------------------
: "${AWS_REGION:?Environment variable AWS_REGION is required}"
: "${AWS_ACCOUNT_ID:?Environment variable AWS_ACCOUNT_ID is required}"

DLQ_NAME="view-events-dlq"
QUEUE_NAME="view-events"

echo "==> AWS Region:     ${AWS_REGION}"
echo "==> AWS Account ID: ${AWS_ACCOUNT_ID}"
echo ""

# ---------------------------------------------------------------------------
# Helper: get queue URL if it already exists, or empty string
# ---------------------------------------------------------------------------
get_queue_url() {
  local name="$1"
  aws sqs get-queue-url \
    --queue-name "${name}" \
    --region "${AWS_REGION}" \
    --query 'QueueUrl' \
    --output text 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Step 1: Create the Dead Letter Queue (view-events-dlq)
# ---------------------------------------------------------------------------
echo "==> Checking for existing DLQ: ${DLQ_NAME}"
DLQ_URL=$(get_queue_url "${DLQ_NAME}")

if [ -n "${DLQ_URL}" ] && [ "${DLQ_URL}" != "None" ]; then
  echo "    DLQ already exists: ${DLQ_URL}"
else
  echo "    Creating DLQ: ${DLQ_NAME}"
  DLQ_URL=$(aws sqs create-queue \
    --queue-name "${DLQ_NAME}" \
    --region "${AWS_REGION}" \
    --attributes '{
      "MessageRetentionPeriod": "1209600"
    }' \
    --query 'QueueUrl' \
    --output text)
  echo "    Created DLQ: ${DLQ_URL}"
fi

# Derive the DLQ ARN from the known naming convention
DLQ_ARN="arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${DLQ_NAME}"
echo "    DLQ ARN: ${DLQ_ARN}"
echo ""

# ---------------------------------------------------------------------------
# Step 2: Create the main queue (view-events)
# ---------------------------------------------------------------------------
echo "==> Checking for existing queue: ${QUEUE_NAME}"
QUEUE_URL=$(get_queue_url "${QUEUE_NAME}")

# Build the redrive policy JSON
REDRIVE_POLICY=$(printf '{"maxReceiveCount":"3","deadLetterTargetArn":"%s"}' "${DLQ_ARN}")

if [ -n "${QUEUE_URL}" ] && [ "${QUEUE_URL}" != "None" ]; then
  echo "    Queue already exists: ${QUEUE_URL}"
  echo "    Updating redrive policy to ensure it is current..."
  aws sqs set-queue-attributes \
    --queue-url "${QUEUE_URL}" \
    --region "${AWS_REGION}" \
    --attributes "{
      \"VisibilityTimeout\": \"60\",
      \"RedrivePolicy\": ${REDRIVE_POLICY}
    }"
  echo "    Attributes updated."
else
  echo "    Creating queue: ${QUEUE_NAME}"
  QUEUE_URL=$(aws sqs create-queue \
    --queue-name "${QUEUE_NAME}" \
    --region "${AWS_REGION}" \
    --attributes "{
      \"VisibilityTimeout\": \"60\",
      \"MessageRetentionPeriod\": \"86400\",
      \"RedrivePolicy\": ${REDRIVE_POLICY}
    }" \
    --query 'QueueUrl' \
    --output text)
  echo "    Created queue: ${QUEUE_URL}"
fi

QUEUE_ARN="arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${QUEUE_NAME}"
echo "    Queue ARN: ${QUEUE_ARN}"
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "============================================================"
echo "  SQS Queue Provisioning Complete"
echo "============================================================"
echo "  DLQ Name:   ${DLQ_NAME}"
echo "  DLQ URL:    ${DLQ_URL}"
echo "  DLQ ARN:    ${DLQ_ARN}"
echo ""
echo "  Queue Name: ${QUEUE_NAME}"
echo "  Queue URL:  ${QUEUE_URL}"
echo "  Queue ARN:  ${QUEUE_ARN}"
echo ""
echo "  VisibilityTimeout : 60 seconds"
echo "  maxReceiveCount   : 3  (then routed to DLQ)"
echo "============================================================"

'use strict';

const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const region = process.env.AWS_REGION || 'us-east-1';
const NAMESPACE = 'AnalyticsDashboard';

const cwClient = new CloudWatchClient({ region });

/**
 * Publishes batch processing metrics to CloudWatch.
 * Called once per Lambda invocation after all processing is complete.
 *
 * @param {{ durationMs: number, duplicatesSkipped: number, dynamoWriteErrors: number }} metrics
 */
async function publishMetrics({ durationMs, duplicatesSkipped, dynamoWriteErrors }) {
  const timestamp = new Date();

  console.info(
    `[metrics] INFO: publishing to CloudWatch namespace=${NAMESPACE} durationMs=${durationMs} duplicatesSkipped=${duplicatesSkipped} dynamoWriteErrors=${dynamoWriteErrors}`
  );

  try {
    await cwClient.send(
      new PutMetricDataCommand({
        Namespace: NAMESPACE,
        MetricData: [
          {
            MetricName: 'BatchProcessingDuration',
            Value: durationMs,
            Unit: 'Milliseconds',
            Timestamp: timestamp,
          },
          {
            MetricName: 'DuplicatesSkipped',
            Value: duplicatesSkipped,
            Unit: 'Count',
            Timestamp: timestamp,
          },
          {
            MetricName: 'DynamoWriteErrors',
            Value: dynamoWriteErrors,
            Unit: 'Count',
            Timestamp: timestamp,
          },
        ],
      })
    );
    console.info(`[metrics] INFO: CloudWatch metrics published ok timestamp=${timestamp.toISOString()}`);
  } catch (err) {
    console.warn(`[metrics] WARN: failed to publish CloudWatch metrics errorName=${err.name} message=${err.message}`);
  }
}

module.exports = { publishMetrics };

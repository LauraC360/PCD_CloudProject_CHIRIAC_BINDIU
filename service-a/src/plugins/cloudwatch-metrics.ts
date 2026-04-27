import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
  StandardUnit
} from '@aws-sdk/client-cloudwatch';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const NAMESPACE = 'AnalyticsDashboard';

interface CloudWatchMetrics {
  recordInvocation: () => void;
  recordSqsPublishLatency: (latencyMs: number) => void;
  recordSqsPublishError: () => void;
  /** Flush immediately — exposed for tests and graceful shutdown. */
  flush: () => Promise<void>;
}

const cloudwatchMetricsPlugin = fp(
  async (fastify: FastifyInstance) => {
    const region = fastify.config.AWS_REGION;
    const flushIntervalMs = fastify.config.CLOUDWATCH_METRICS_FLUSH_INTERVAL_MS;
    const client = new CloudWatchClient({ region });

    // Batched counters / latency samples — reset on each flush.
    let invocationCount = 0;
    let sqsPublishErrorCount = 0;
    let sqsPublishLatencySamples: number[] = [];

    const recordInvocation = (): void => {
      invocationCount++;
    };

    const recordSqsPublishError = (): void => {
      sqsPublishErrorCount++;
    };

    const recordSqsPublishLatency = (latencyMs: number): void => {
      sqsPublishLatencySamples.push(latencyMs);
    };

    const buildLatencyDatum = (samples: number[]): MetricDatum | null => {
      if (samples.length === 0) return null;
      let sum = 0;
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const v of samples) {
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return {
        MetricName: 'SqsPublishLatency',
        Unit: StandardUnit.Milliseconds,
        StatisticValues: {
          SampleCount: samples.length,
          Sum: sum,
          Minimum: min,
          Maximum: max
        }
      };
    };

    const flush = async (): Promise<void> => {
      // Snapshot and reset counters first so concurrent writes don't get dropped.
      const invocations = invocationCount;
      const errors = sqsPublishErrorCount;
      const latencies = sqsPublishLatencySamples;
      invocationCount = 0;
      sqsPublishErrorCount = 0;
      sqsPublishLatencySamples = [];

      const metricData: MetricDatum[] = [];

      if (invocations > 0) {
        metricData.push({
          MetricName: 'GetMovieInvocations',
          Unit: StandardUnit.Count,
          Value: invocations
        });
      }
      if (errors > 0) {
        metricData.push({
          MetricName: 'SqsPublishErrors',
          Unit: StandardUnit.Count,
          Value: errors
        });
      }
      const latencyDatum = buildLatencyDatum(latencies);
      if (latencyDatum !== null) {
        metricData.push(latencyDatum);
      }

      if (metricData.length === 0) {
        return;
      }

      try {
        await client.send(
          new PutMetricDataCommand({
            Namespace: NAMESPACE,
            MetricData: metricData
          })
        );
      } catch (err) {
        fastify.log.error({ err }, 'Failed to flush CloudWatch metrics');
      }
    };

    const timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    // Don't block process exit just for metrics.
    timer.unref?.();

    fastify.addHook('onClose', async () => {
      clearInterval(timer);
      await flush();
    });

    const cwMetrics: CloudWatchMetrics = {
      recordInvocation,
      recordSqsPublishLatency,
      recordSqsPublishError,
      flush
    };

    fastify.decorate('cwMetrics', cwMetrics);
  },
  { name: 'cloudwatch-metrics', dependencies: ['server-config'] }
);

export default cloudwatchMetricsPlugin;
export type { CloudWatchMetrics };

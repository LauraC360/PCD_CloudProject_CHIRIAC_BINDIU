import fp from 'fastify-plugin';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { FastifyInstance } from 'fastify';

/**
 * View Event — published to SQS when a movie is viewed
 */
export interface ViewEvent {
  schemaVersion: string;
  requestId: string;
  movieId: string;
  publishedAt: string;
}

/**
 * SQS Publisher — publishes View Events to SQS
 */
export interface SqsPublisher {
  publish(event: ViewEvent): void;
  getMetrics(): {
    totalPublished: number;
    publishErrors: number;
    avgPublishLatencyMs: number;
  };
}

/**
 * SQS Plugin
 *
 * Registers an SQS client and exposes a fire-and-forget publish method.
 * Maintains in-memory metrics for observability.
 *
 * Usage:
 *   this.sqsPublisher.publish({ schemaVersion, requestId, movieId, publishedAt })
 *
 * Metrics:
 *   this.sqsPublisher.getMetrics() → { totalPublished, publishErrors, avgPublishLatencyMs }
 */
const sqsPlugin = fp(
  async (fastify: FastifyInstance) => {
    // Metrics
    let totalPublished = 0;
    let publishErrors = 0;
    let totalPublishLatencyMs = 0;

    // Initialize SQS client
    const sqsClient = new SQSClient({
      region: fastify.config.AWS_REGION
    });

    // Create publisher
    const publisher: SqsPublisher = {
      publish(event: ViewEvent): void {
        // Fire-and-forget — do not await
        const startTime = Date.now();

        (async () => {
          try {
            const command = new SendMessageCommand({
              QueueUrl: fastify.config.SQS_QUEUE_URL,
              MessageBody: JSON.stringify(event)
            });

            await sqsClient.send(command);

            totalPublished++;
            const latency = Date.now() - startTime;
            totalPublishLatencyMs += latency;

            fastify.log.debug(
              {
                movieId: event.movieId,
                requestId: event.requestId,
                latencyMs: latency
              },
              'Published View_Event to SQS'
            );
          } catch (err) {
            publishErrors++;
            fastify.log.error(
              {
                movieId: event.movieId,
                requestId: event.requestId,
                error: err instanceof Error ? err.message : String(err)
              },
              'Failed to publish View_Event to SQS'
            );
          }
        })();
      },

      getMetrics() {
        return {
          totalPublished,
          publishErrors,
          avgPublishLatencyMs: totalPublished > 0 ? totalPublishLatencyMs / totalPublished : 0
        };
      }
    };

    // Decorate fastify instance
    fastify.decorate('sqsPublisher', publisher);

    // Graceful shutdown
    fastify.addHook('onClose', async () => {
      await sqsClient.destroy();
    });
  },
  {
    name: 'sqs-plugin',
    dependencies: ['server-config']
  }
);

export default sqsPlugin;

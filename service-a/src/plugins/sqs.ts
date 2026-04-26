import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

interface SqsPublisherMetrics {
  totalPublished: number;
  publishErrors: number;
  avgPublishLatencyMs: number;
}

interface SqsPublisher {
  publish: (event: ViewEvent) => void;
  getMetrics: () => SqsPublisherMetrics;
}

const sqsPlugin = fp(
  async (fastify: FastifyInstance) => {
    const queueUrl = fastify.config.SQS_QUEUE_URL;
    const isLocalDev = queueUrl.includes('fake-queue-url') || process.env.NODE_ENV === 'development';

    let totalPublished = 0;
    let publishErrors = 0;
    let totalPublishLatencyMs = 0;

    let client: SQSClient | null = null;

    // Only initialize real SQS client if not in local dev mode
    if (!isLocalDev) {
      client = new SQSClient({ region: fastify.config.AWS_REGION });
    }

    const publish = (event: ViewEvent): void => {
      const startMs = Date.now();

      if (isLocalDev) {
        // Mock mode: simulate SQS publish with a small delay
        setTimeout(() => {
          totalPublished++;
          totalPublishLatencyMs += Date.now() - startMs;
          fastify.log.info(
            { movieId: event.movieId, requestId: event.requestId, event },
            '[MOCK SQS] Published View_Event'
          );
        }, Math.random() * 50); // Simulate 0-50ms latency
      } else {
        // Real SQS mode: fire-and-forget
        client!
          .send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify(event)
            })
          )
          .then(() => {
            totalPublished++;
            totalPublishLatencyMs += Date.now() - startMs;
          })
          .catch((err: unknown) => {
            publishErrors++;
            fastify.log.error(
              { err, movieId: event.movieId, requestId: event.requestId },
              'Failed to publish View_Event to SQS'
            );
          });
      }
    };

    const getMetrics = (): SqsPublisherMetrics => ({
      totalPublished,
      publishErrors,
      avgPublishLatencyMs: totalPublished > 0 ? totalPublishLatencyMs / totalPublished : 0
    });

    const sqsPublisher: SqsPublisher = { publish, getMetrics };

    fastify.decorate('sqsPublisher', sqsPublisher);
  },
  { name: 'sqs', dependencies: ['server-config'] }
);

export default sqsPlugin;
export type { SqsPublisher, SqsPublisherMetrics };

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
    const client = new SQSClient({ region: fastify.config.AWS_REGION });
    const queueUrl = fastify.config.SQS_QUEUE_URL;

    let totalPublished = 0;
    let publishErrors = 0;
    let totalPublishLatencyMs = 0;

    const publish = (event: ViewEvent): void => {
      const startMs = Date.now();

      // Fire-and-forget: intentionally not awaited so the HTTP response is never delayed
      client
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

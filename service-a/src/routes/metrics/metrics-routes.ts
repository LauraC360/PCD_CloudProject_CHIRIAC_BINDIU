import type { FastifyInstance, RouteOptions } from 'fastify';
import { HttpMethods, HttpStatusCodes, RouteTags } from '../../utils/constants/enums';
import { API_ENDPOINTS } from '../../utils/constants/constants';
import { registerEndpointRoutes } from '../../utils/routing-utils';

const endpoint = API_ENDPOINTS.METRICS;
const tags: RouteTags[] = [RouteTags.DIAGNOSTICS] as const;

const routes: RouteOptions[] = [
  {
    method: HttpMethods.GET,
    url: endpoint,
    schema: {
      summary: 'Get SQS publisher metrics',
      tags,
      response: {
        [HttpStatusCodes.OK]: {
          description: 'SQS publisher metrics',
          type: 'object',
          properties: {
            totalPublished: { type: 'number', description: 'Total number of successfully published events' },
            publishErrors: { type: 'number', description: 'Total number of publish errors' },
            avgPublishLatencyMs: { type: 'number', description: 'Average publish latency in milliseconds' }
          },
          required: ['totalPublished', 'publishErrors', 'avgPublishLatencyMs']
        }
      }
    },
    handler: async function getMetrics(_, reply) {
      const metrics = this.sqsPublisher.getMetrics();
      reply.code(HttpStatusCodes.OK).send(metrics);
    }
  } as const
] as const;

const metricsRoutes = async (fastify: FastifyInstance): Promise<void> => {
  await registerEndpointRoutes(fastify, endpoint, routes);
};

export default metricsRoutes;

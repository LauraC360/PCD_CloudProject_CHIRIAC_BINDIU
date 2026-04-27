import fastifyMongo, { type FastifyMongodbOptions } from '@fastify/mongodb';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const mongoPlugin = fp(
  async (fastify: FastifyInstance) => {
    const options: FastifyMongodbOptions = {
      forceClose: true,
      url: fastify.config.MONGO_URL
    };
    await fastify.register(fastifyMongo, options);
  },
  { name: 'mongo', dependencies: ['server-config'] }
);

export default mongoPlugin;

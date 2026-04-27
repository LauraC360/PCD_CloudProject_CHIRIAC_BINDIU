import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import fastifyMongo, { type FastifyMongodbOptions } from '@fastify/mongodb';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

// Production-only MongoDB plugin — always connects via MONGO_URL env var.
// If MONGO_URL is not set directly, falls back to fetching from SSM via MONGO_URL_SSM_ARN.
const mongoPlugin = fp(
  async (fastify: FastifyInstance) => {
    let mongoUrl = fastify.config.MONGO_URL;

    // If MONGO_URL is the default local value, try fetching from SSM
    if (mongoUrl === 'mongodb://localhost:27027/sample_mflix' || !mongoUrl) {
      const ssmArn = process.env.MONGO_URL_SSM_ARN;
      if (ssmArn) {
        const ssmClient = new SSMClient({ region: fastify.config.AWS_REGION });
        const paramName = ssmArn.split(':parameter')[1];
        const result = await ssmClient.send(new GetParameterCommand({
          Name: paramName,
          WithDecryption: true
        }));
        mongoUrl = result.Parameter?.Value ?? mongoUrl;
        fastify.log.info('Fetched MONGO_URL from SSM');
      }
    }

    const options: FastifyMongodbOptions = {
      forceClose: true,
      url: mongoUrl
    };
    await fastify.register(fastifyMongo, options);
  },
  { name: 'mongo', dependencies: ['server-config'] }
);

export default mongoPlugin;

import type { FastifyServerOptions } from 'fastify';

const serverOptions: FastifyServerOptions = {
  caseSensitive: false,
  logger: { level: 'info' },
  pluginTimeout: 100000
};

export { serverOptions };

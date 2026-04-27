import { type Static, Type } from '@sinclair/typebox';
import { CONFIG_DEFAULTS } from '../utils/constants/constants';

const EnvSchema = Type.Object({
  NODE_ENV: Type.String({ default: CONFIG_DEFAULTS.ENV }),
  APP_PORT: Type.Number({ default: CONFIG_DEFAULTS.PORT }),
  MONGO_IMAGE: Type.String({ default: CONFIG_DEFAULTS.MONGO_IMAGE }),
  MONGO_URL: Type.String({ default: CONFIG_DEFAULTS.MONGO_URL }),
  MONGO_DB_NAME: Type.String({ default: CONFIG_DEFAULTS.MONGO_DB_NAME }),
  SQS_QUEUE_URL: Type.String(),
  AWS_REGION: Type.String({ default: 'us-east-1' }),
  COGNITO_JWKS_URL: Type.String(),
  CLOUDWATCH_METRICS_FLUSH_INTERVAL_MS: Type.Number({ default: 30000 })
});

type EnvSchemaType = Static<typeof EnvSchema>;

export { EnvSchema, type EnvSchemaType };

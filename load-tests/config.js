'use strict';

// ── Load-test configuration ──
// Override any value via environment variables.

const config = {
  // Service A base URL (ECS Fargate / App Runner)
  SERVICE_A_URL: process.env.SERVICE_A_URL || 'https://vvsusbtfkg.us-east-1.awsapprunner.com',

  // WebSocket Gateway public URL (ws:// or wss://)
  WS_GATEWAY_URL: process.env.WS_GATEWAY_URL || 'wss://d368d1sswys5zs.cloudfront.net',

  // WebSocket Gateway internal HTTP URL (for health checks)
  WS_GATEWAY_HEALTH_URL: process.env.WS_GATEWAY_HEALTH_URL || 'http://wsg-alb-245456620.us-east-1.elb.amazonaws.com',

  // DynamoDB stats query URL (Gateway's /health or a custom stats endpoint)
  STATS_URL: process.env.STATS_URL || 'http://wsg-alb-245456620.us-east-1.elb.amazonaws.com',

  // JWT token for authenticated requests to Service A
  JWT_TOKEN: process.env.JWT_TOKEN || '',

  // Cognito credentials (used to auto-fetch JWT if JWT_TOKEN is empty)
  COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID || '4t06qivno4u8b5nqq4qqs6usr5',
  COGNITO_USERNAME: process.env.COGNITO_USERNAME || 'test@test.com',
  COGNITO_PASSWORD: process.env.COGNITO_PASSWORD || 'Test1234!Perm',
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  AWS_PROFILE: process.env.AWS_PROFILE || 'pers',

  // Movie IDs from the sample_mflix dataset (same as run_gets.sh)
  MOVIE_IDS: [
    '573a13d3f29313caabd9473c',
    '573a13b3f29313caabd3c7ac',
    '573a13cff29313caabd88f5b',
    '573a1393f29313caabcddbed',
    '573a13b8f29313caabd4d540',
    '573a13d3f29313caabd967ef',
    '573a13d6f29313caabd9e2d7',
    '573a13dcf29313caabdb2dec',
    '573a13d9f29313caabdaa62d',
    '573a13d7f29313caabda5079',
    '573a13cef29313caabd86ddc',
    '573a139cf29313caabcf560f',
    '573a13a0f29313caabcfac7c',
    '573a13a3f29313caabcff87e',
    '573a13a4f29313caabcff87e',
  ],

  API_PREFIX: '/api/v1',
};

module.exports = config;

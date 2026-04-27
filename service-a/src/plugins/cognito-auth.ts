import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import buildGetJwks, { type GetJwks } from 'get-jwks';
import jsonwebtoken, { type JwtPayload } from 'jsonwebtoken';

/**
 * Cognito JWT validator.
 *
 * Validates incoming `Authorization: Bearer <token>` headers against the
 * Cognito User Pool's JWKS endpoint configured via COGNITO_JWKS_URL.
 *
 * Kept separate from the internal `auth.ts` plugin (which handles the legacy
 * `/login` route). The two do not share the `@fastify/jwt` registration.
 *
 * Paths that bypass validation (prefix match, with or without the
 * `/api/v1` prefix applied by the autoloader):
 *   - `/health`
 *   - `/metrics`
 *   - `/docs`       (swagger-ui)
 *   - `/login`      (legacy login route issues its own JWT)
 */

// Public, unauthenticated path prefixes. Match against request.url which
// starts with the API v1 prefix when set by the autoloader.
const PUBLIC_PATH_SUFFIXES = ['/health', '/metrics', '/docs', '/login'] as const;

const isPublicPath = (url: string): boolean => {
  // Strip query string for matching.
  const pathOnly = url.split('?')[0] ?? url;
  return PUBLIC_PATH_SUFFIXES.some(
    (p) => pathOnly === p || pathOnly.endsWith(p) || pathOnly.includes(`${p}/`)
  );
};

interface CognitoJwtPayload extends JwtPayload {
  sub?: string;
  email?: string;
  token_use?: string;
}

const extractBearerToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
};

/**
 * Derives the JWKS base URL from `COGNITO_JWKS_URL`.
 * `get-jwks` expects a base (the issuer / jwksUri without the path), which it
 * combines with `/.well-known/jwks.json` itself. We accept both forms.
 */
const deriveJwksBase = (jwksUrl: string): string => {
  const marker = '/.well-known/jwks.json';
  if (jwksUrl.endsWith(marker)) {
    return jwksUrl.slice(0, -marker.length);
  }
  return jwksUrl.replace(/\/+$/, '');
};

const cognitoAuthPlugin = fp(
  async (fastify: FastifyInstance) => {
    // In test / development mode we skip Cognito validation entirely so the
    // legacy `/login`-based internal JWT flow (and the existing route tests)
    // keep working without needing a real User Pool.
    if (fastify.config.NODE_ENV !== 'production') {
      fastify.log.info(
        { NODE_ENV: fastify.config.NODE_ENV },
        'Cognito JWT validation disabled outside production'
      );
      return;
    }

    const jwksUrl = fastify.config.COGNITO_JWKS_URL;
    const issuer = deriveJwksBase(jwksUrl);

    const getJwks: GetJwks = buildGetJwks({
      max: 5,
      ttl: 10 * 60 * 1000, // 10 min
      issuersWhitelist: [issuer]
    });

    fastify.addHook('preHandler', async (request, reply) => {
      if (isPublicPath(request.url)) {
        return;
      }

      const token = extractBearerToken(request);
      if (token === null) {
        fastify.log.warn({ path: request.url }, 'Cognito JWT missing or malformed');
        return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
      }

      let decodedHeader: { kid?: string; alg?: string } | null = null;
      let decodedPayload: CognitoJwtPayload | null = null;
      try {
        const decoded = jsonwebtoken.decode(token, { complete: true });
        if (decoded !== null && typeof decoded === 'object') {
          decodedHeader = decoded.header as { kid?: string; alg?: string };
          decodedPayload = decoded.payload as CognitoJwtPayload;
        }
      } catch {
        decodedHeader = null;
      }

      if (
        decodedHeader === null ||
        typeof decodedHeader.kid !== 'string' ||
        typeof decodedPayload?.iss !== 'string'
      ) {
        fastify.log.warn({ path: request.url }, 'Cognito JWT header/payload unreadable');
        return reply.code(401).send({ error: 'Invalid JWT' });
      }

      try {
        const publicKey = await getJwks.getPublicKey({
          kid: decodedHeader.kid,
          alg: decodedHeader.alg ?? 'RS256',
          domain: decodedPayload.iss
        });
        const verified = jsonwebtoken.verify(token, publicKey, {
          issuer: decodedPayload.iss,
          algorithms: ['RS256']
        });
        // Attach the verified payload so downstream handlers can read claims.
        (request as FastifyRequest & { user?: unknown }).user = verified;
      } catch (err) {
        fastify.log.warn({ path: request.url, err }, 'Cognito JWT validation failed');
        return reply.code(401).send({ error: 'Invalid or expired JWT' });
      }
    });
  },
  { name: 'cognito-auth', dependencies: ['server-config'] }
);

export default cognitoAuthPlugin;

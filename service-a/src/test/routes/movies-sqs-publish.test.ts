import fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import errorHandlingPlugin from '../../plugins/errors';
import movieRoutes from '../../routes/movies/movie_id/movie-id-routes';
import { API_V1_PREFIX, MOVIE_ENDPOINT } from '../../utils/constants/constants';
import { HttpMethods, HttpStatusCodes } from '../../utils/constants/enums';

/**
 * Task 9.8 — Unit tests that the `GET /movies/:id` handler calls
 * `sqsPublisher.publish` with the correct shape on success, and does NOT
 * publish on a 404.
 *
 * These tests stand up a minimal Fastify instance with a mocked `dataStore`
 * and `sqsPublisher` — no MongoDB / testcontainers needed, so they run in
 * any CI environment.
 */

interface PublishedEvent {
  schemaVersion: string;
  requestId: string;
  movieId: string;
  title: string;
  publishedAt: number;
}

const buildMinimalInstance = (
  fetchMovieImpl: (id: string) => Promise<unknown>
): { app: FastifyInstance; publishMock: jest.Mock<void, [PublishedEvent]> } => {
  const app = fastify({ logger: false });

  const publishMock = jest.fn<void, [PublishedEvent]>();

  // Use the real error-handling plugin so thrown errors with `statusCode`
  // are mapped to the RFC 9457 response shape the route schema expects.
  app.register(errorHandlingPlugin);

  // Stub the decorators the route uses on `this`.
  app.register(
    fp(async (fastifyInstance) => {
      fastifyInstance.decorate('dataStore', {
        fetchMovie: fetchMovieImpl,
        checkUser: async () => { throw new Error('not implemented'); },
        registerUser: async () => {},
        countMovies: async () => 0,
        countMovieComments: async () => 0,
        fetchMovies: async () => [],
        fetchMovieComments: async () => [],
        createMovie: async () => '',
        createMovieComment: async () => {},
        replaceMovie: async () => {},
        updateMovie: async () => {},
        deleteMovie: async () => {}
      });
      fastifyInstance.decorate('sqsPublisher', {
        publish: publishMock,
        getMetrics: () => ({
          totalPublished: 0,
          publishErrors: 0,
          avgPublishLatencyMs: 0
        })
      });
      // `cwMetrics?.recordInvocation()` is called inside the route — a
      // minimal no-op stub keeps the call-site happy.
      fastifyInstance.decorate('cwMetrics', {
        recordInvocation: () => undefined,
        recordSqsPublishLatency: () => undefined,
        recordSqsPublishError: () => undefined,
        flush: async () => undefined
      });
    })
  );

  // Mount the same route module used in production, under the same prefix.
  app.register(movieRoutes, { prefix: API_V1_PREFIX });

  return { app, publishMock };
};

describe('GET /movies/:movie_id → sqsPublisher.publish', () => {
  const movieId = '670f5e20c286545ba702aade';
  const movieTitle = 'The Shawshank Redemption';
  const endpoint = API_V1_PREFIX + MOVIE_ENDPOINT(movieId);

  // Shape that satisfies the FetchMovie response schema (type + year required).
  const fullMovie = {
    _id: movieId,
    title: movieTitle,
    type: 'movie' as const,
    year: 1994
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('publishes a View_Event with movieId, title, and epoch-ms publishedAt on a 200 response', async () => {
    const fetchMovie = jest.fn().mockResolvedValue(fullMovie);
    const { app, publishMock } = buildMinimalInstance(fetchMovie);
    await app.ready();

    const beforeMs = Date.now();
    const response = await app.inject({ method: HttpMethods.GET, url: endpoint });
    const afterMs = Date.now();

    expect(response.statusCode).toBe(HttpStatusCodes.OK);
    expect(publishMock).toHaveBeenCalledTimes(1);

    const published = publishMock.mock.calls[0][0];
    expect(published.schemaVersion).toBe('1.0');
    expect(typeof published.requestId).toBe('string');
    expect(published.requestId.length).toBeGreaterThan(0);
    expect(published.movieId).toBe(movieId);
    expect(published.title).toBe(movieTitle);
    expect(typeof published.publishedAt).toBe('number');
    expect(Number.isFinite(published.publishedAt)).toBe(true);
    expect(published.publishedAt).toBeGreaterThanOrEqual(beforeMs);
    expect(published.publishedAt).toBeLessThanOrEqual(afterMs);

    await app.close();
  });

  it('uses the `x-requested-at` header as publishedAt when provided', async () => {
    const fetchMovie = jest.fn().mockResolvedValue(fullMovie);
    const { app, publishMock } = buildMinimalInstance(fetchMovie);
    await app.ready();

    const requestedAt = 1700000000000;
    const response = await app.inject({
      method: HttpMethods.GET,
      url: endpoint,
      headers: { 'x-requested-at': String(requestedAt) }
    });

    expect(response.statusCode).toBe(HttpStatusCodes.OK);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock.mock.calls[0][0].publishedAt).toBe(requestedAt);

    await app.close();
  });

  it('falls back to Date.now() when `x-requested-at` is a non-numeric string', async () => {
    const fetchMovie = jest.fn().mockResolvedValue(fullMovie);
    const { app, publishMock } = buildMinimalInstance(fetchMovie);
    await app.ready();

    const response = await app.inject({
      method: HttpMethods.GET,
      url: endpoint,
      headers: { 'x-requested-at': 'not-a-number' }
    });

    expect(response.statusCode).toBe(HttpStatusCodes.OK);
    const published = publishMock.mock.calls[0][0];
    expect(typeof published.publishedAt).toBe('number');
    expect(Number.isFinite(published.publishedAt)).toBe(true);
    expect(published.publishedAt).toBeGreaterThan(1_600_000_000_000);

    await app.close();
  });

  it('does NOT publish when the movie is not found (404 path)', async () => {
    // Real `genNotFoundError` returns a plain object; Fastify needs a real
    // Error instance here so its default handler respects `statusCode`.
    class NotFoundError extends Error {
      statusCode = 404;
      constructor() {
        super('Could not find movie');
        this.name = 'NotFoundError';
      }
    }
    const fetchMovie = jest.fn().mockRejectedValue(new NotFoundError());
    const { app, publishMock } = buildMinimalInstance(fetchMovie);
    await app.ready();

    const response = await app.inject({ method: HttpMethods.GET, url: endpoint });

    expect(response.statusCode).toBe(HttpStatusCodes.NOT_FOUND);
    expect(publishMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('emits unique requestId values across requests', async () => {
    const fetchMovie = jest.fn().mockResolvedValue(fullMovie);
    const { app, publishMock } = buildMinimalInstance(fetchMovie);
    await app.ready();

    await app.inject({ method: HttpMethods.GET, url: endpoint });
    await app.inject({ method: HttpMethods.GET, url: endpoint });

    expect(publishMock).toHaveBeenCalledTimes(2);
    const id1 = publishMock.mock.calls[0][0].requestId;
    const id2 = publishMock.mock.calls[1][0].requestId;
    expect(id1).not.toBe(id2);

    await app.close();
  });
});

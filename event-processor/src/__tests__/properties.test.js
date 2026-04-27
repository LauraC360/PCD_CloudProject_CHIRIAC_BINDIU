'use strict';

// Feature: realtime-analytics-dashboard

const fc = require('fast-check');

jest.mock('../lib/idempotency');
jest.mock('../lib/statsWriter');
jest.mock('../lib/recentActivityWriter');
jest.mock('../lib/gatewayNotifier');
jest.mock('../lib/metrics');

const { markProcessed } = require('../lib/idempotency');
const { writeStats } = require('../lib/statsWriter');
const { writeRecentActivity } = require('../lib/recentActivityWriter');
const { notifyGateway } = require('../lib/gatewayNotifier');
const { publishMetrics } = require('../lib/metrics');
const { handler } = require('../handler');

// Arbitraries
const movieIdArb = fc.stringMatching(/^tt\d{7}$/);
const titleArb = fc.string({ minLength: 1, maxLength: 50 });
const publishedAtArb = fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 });

function makeBody({ requestId, movieId, title, publishedAt }) {
  return JSON.stringify({ schemaVersion: '1.0', requestId, movieId, title, publishedAt });
}

function makeRecord(messageId, body) {
  return { messageId, body };
}

function resetMocks() {
  jest.clearAllMocks();
  markProcessed.mockResolvedValue(true);
  writeStats.mockResolvedValue();
  writeRecentActivity.mockResolvedValue();
  notifyGateway.mockResolvedValue();
  publishMetrics.mockResolvedValue();
}

beforeEach(resetMocks);

// Property 1: Counter Invariant
// For N events with the same movieId, writeStats is called with delta = N
test('P1 (Counter Invariant): delta equals number of unique events for a movieId', async () => {
  // Feature: realtime-analytics-dashboard, Property 1: Counter Invariant
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 10 }),
      movieIdArb,
      titleArb,
      async (n, movieId, title) => {
        resetMocks();

        const records = Array.from({ length: n }, (_, i) =>
          makeRecord(
            `msg-${i}`,
            makeBody({ requestId: `req-${i}-${i}`, movieId, title, publishedAt: 1700000000000 + i })
          )
        );

        await handler({ Records: records });

        const statsCall = writeStats.mock.calls.find(([args]) => args.movieId === movieId);
        expect(statsCall).toBeDefined();
        expect(statsCall[0].delta).toBe(n);
      }
    ),
    { numRuns: 100 }
  );
});

// Property 2: Idempotency
// Duplicate requestIds must not increase the delta beyond the count of unique requestIds
test('P2 (Idempotency): duplicate requestIds do not inflate the delta', async () => {
  // Feature: realtime-analytics-dashboard, Property 2: Idempotency
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 1, max: 5 }),
      movieIdArb,
      titleArb,
      async (uniqueCount, dupCount, movieId, title) => {
        resetMocks();

        // First uniqueCount calls → new; remaining dupCount calls → duplicate
        let callCount = 0;
        markProcessed.mockImplementation(async () => {
          callCount += 1;
          return callCount <= uniqueCount;
        });

        const records = Array.from({ length: uniqueCount + dupCount }, (_, i) =>
          makeRecord(
            `msg-${i}`,
            makeBody({ requestId: `req-${i}`, movieId, title, publishedAt: 1700000000000 + i })
          )
        );

        await handler({ Records: records });

        if (uniqueCount > 0) {
          const statsCall = writeStats.mock.calls.find(([args]) => args.movieId === movieId);
          expect(statsCall).toBeDefined();
          expect(statsCall[0].delta).toBe(uniqueCount);
        } else {
          expect(writeStats).not.toHaveBeenCalled();
        }
      }
    ),
    { numRuns: 100 }
  );
});

// Property 3: Movie Isolation
// Events for different movieIds must produce independent deltas
test('P3 (Movie Isolation): each movieId gets its own independent delta', async () => {
  // Feature: realtime-analytics-dashboard, Property 3: Movie Isolation
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(movieIdArb, { minLength: 2, maxLength: 4 }),
      fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 2, maxLength: 4 }),
      titleArb,
      async (movieIds, counts, title) => {
        resetMocks();

        const len = Math.min(movieIds.length, counts.length);
        const pairs = movieIds.slice(0, len).map((id, i) => ({ movieId: id, count: counts[i] }));

        let msgIdx = 0;
        const records = pairs.flatMap(({ movieId, count }) =>
          Array.from({ length: count }, (_, i) =>
            makeRecord(
              `msg-${msgIdx++}`,
              makeBody({ requestId: `${movieId}-req-${i}-${msgIdx}`, movieId, title, publishedAt: 1700000000000 + i })
            )
          )
        );

        await handler({ Records: records });

        for (const { movieId, count } of pairs) {
          const statsCall = writeStats.mock.calls.find(([args]) => args.movieId === movieId);
          expect(statsCall).toBeDefined();
          expect(statsCall[0].delta).toBe(count);
        }
      }
    ),
    { numRuns: 100 }
  );
});

// Property 6: Invalid Input Rejection
// Records with missing/malformed required fields must appear in batchItemFailures
// and must not affect processing of valid records in the same batch
test('P6 (Invalid Input Rejection): invalid records land in batchItemFailures without affecting valid ones', async () => {
  // Feature: realtime-analytics-dashboard, Property 6: Invalid Input Rejection
  const invalidBodies = [
    'not-json',
    JSON.stringify({ schemaVersion: '1.0', title: 'A', publishedAt: 1000 }), // missing requestId + movieId
    JSON.stringify({ schemaVersion: '1.0', requestId: 'r1', title: 'A', publishedAt: 1000 }), // missing movieId
    JSON.stringify({ schemaVersion: '1.0', requestId: 'r1', movieId: '', title: 'A', publishedAt: 1000 }), // empty movieId
    JSON.stringify({ schemaVersion: '1.0', requestId: 'r1', movieId: 'tt0111161', title: 'A', publishedAt: 'not-a-number' }), // string publishedAt
  ];

  await fc.assert(
    fc.asyncProperty(
      movieIdArb,
      titleArb,
      publishedAtArb,
      fc.integer({ min: 0, max: invalidBodies.length - 1 }),
      async (movieId, title, publishedAt, invalidIdx) => {
        resetMocks();

        const invalidBody = invalidBodies[invalidIdx];
        const validBody = makeBody({ requestId: `req-valid-${Math.random()}`, movieId, title, publishedAt });
        const records = [
          makeRecord('invalid-msg', invalidBody),
          makeRecord('valid-msg', validBody),
        ];

        const result = await handler({ Records: records });

        expect(result.batchItemFailures.map((f) => f.itemIdentifier)).toContain('invalid-msg');
        expect(result.batchItemFailures.map((f) => f.itemIdentifier)).not.toContain('valid-msg');
        expect(writeStats).toHaveBeenCalledWith(expect.objectContaining({ movieId, delta: 1 }));
      }
    ),
    { numRuns: 100 }
  );
});

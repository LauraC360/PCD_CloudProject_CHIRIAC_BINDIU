'use strict';

// Mock all lib modules before requiring handler
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

// Helper to build a valid SQS record
function makeRecord(overrides = {}) {
  const defaults = {
    messageId: 'msg-1',
    body: JSON.stringify({
      schemaVersion: '1.0',
      requestId: 'req-1',
      movieId: 'tt0111161',
      title: 'The Shawshank Redemption',
      publishedAt: 1700000000000,
    }),
  };
  return { ...defaults, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  markProcessed.mockResolvedValue(true);
  writeStats.mockResolvedValue();
  writeRecentActivity.mockResolvedValue();
  notifyGateway.mockResolvedValue();
  publishMetrics.mockResolvedValue();
});

const { handler } = require('../handler');

describe('handler — basic flow', () => {
  it('processes a single valid event end-to-end', async () => {
    const result = await handler({ Records: [makeRecord()] });

    expect(markProcessed).toHaveBeenCalledWith('req-1');
    expect(writeStats).toHaveBeenCalledWith(
      expect.objectContaining({ movieId: 'tt0111161', delta: 1 })
    );
    expect(writeRecentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ movieId: 'tt0111161', publishedAt: 1700000000000 })
    );
    expect(notifyGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        movieId: 'tt0111161',
        viewCount: 1,
        publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), // ISO string
      })
    );
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it('returns empty batchItemFailures when all records succeed', async () => {
    const records = [
      makeRecord({ messageId: 'msg-1', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r1', movieId: 'tt0111161', title: 'A', publishedAt: 1000 }) }),
      makeRecord({ messageId: 'msg-2', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r2', movieId: 'tt0068646', title: 'B', publishedAt: 2000 }) }),
    ];
    const result = await handler({ Records: records });
    expect(result.batchItemFailures).toHaveLength(0);
  });
});

describe('handler — aggregation', () => {
  it('aggregates multiple events for the same movieId into one writeStats call with correct delta', async () => {
    const records = [
      makeRecord({ messageId: 'msg-1', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r1', movieId: 'tt0111161', title: 'Movie A', publishedAt: 1000 }) }),
      makeRecord({ messageId: 'msg-2', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r2', movieId: 'tt0111161', title: 'Movie A', publishedAt: 2000 }) }),
      makeRecord({ messageId: 'msg-3', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r3', movieId: 'tt0111161', title: 'Movie A', publishedAt: 3000 }) }),
    ];

    await handler({ Records: records });

    expect(writeStats).toHaveBeenCalledTimes(1);
    expect(writeStats).toHaveBeenCalledWith(
      expect.objectContaining({ movieId: 'tt0111161', delta: 3 })
    );
    expect(notifyGateway).toHaveBeenCalledTimes(1);
    expect(notifyGateway).toHaveBeenCalledWith(
      expect.objectContaining({ movieId: 'tt0111161', viewCount: 3 })
    );
  });

  it('calls writeStats and notifyGateway once per unique movieId', async () => {
    const records = [
      makeRecord({ messageId: 'msg-1', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r1', movieId: 'tt0111161', title: 'A', publishedAt: 1000 }) }),
      makeRecord({ messageId: 'msg-2', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r2', movieId: 'tt0068646', title: 'B', publishedAt: 2000 }) }),
    ];

    await handler({ Records: records });

    expect(writeStats).toHaveBeenCalledTimes(2);
    expect(notifyGateway).toHaveBeenCalledTimes(2);
    // recentActivityWriter called once per event
    expect(writeRecentActivity).toHaveBeenCalledTimes(2);
  });
});

describe('handler — idempotency', () => {
  it('skips duplicate events and does not write them to DynamoDB', async () => {
    markProcessed
      .mockResolvedValueOnce(true)   // first event: new
      .mockResolvedValueOnce(false); // second event: duplicate

    const records = [
      makeRecord({ messageId: 'msg-1', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r1', movieId: 'tt0111161', title: 'A', publishedAt: 1000 }) }),
      makeRecord({ messageId: 'msg-2', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r1', movieId: 'tt0111161', title: 'A', publishedAt: 1000 }) }),
    ];

    const result = await handler({ Records: records });

    expect(writeStats).toHaveBeenCalledTimes(1);
    expect(writeStats).toHaveBeenCalledWith(expect.objectContaining({ delta: 1 }));
    expect(writeRecentActivity).toHaveBeenCalledTimes(1);
    expect(result.batchItemFailures).toHaveLength(0);
  });
});

describe('handler — batch failure reporting', () => {
  it('adds messageId to batchItemFailures when record body is invalid JSON', async () => {
    const records = [
      { messageId: 'bad-msg', body: 'not-json' },
      makeRecord({ messageId: 'good-msg' }),
    ];

    const result = await handler({ Records: records });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-msg' }]);
    expect(writeStats).toHaveBeenCalledTimes(1); // good record still processed
  });

  it('adds messageId to batchItemFailures when required field is missing', async () => {
    const records = [
      { messageId: 'missing-movieId', body: JSON.stringify({ schemaVersion: '1.0', requestId: 'r1', title: 'A', publishedAt: 1000 }) },
    ];

    const result = await handler({ Records: records });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'missing-movieId' }]);
  });

  it('gateway notify failure does not add to batchItemFailures', async () => {
    notifyGateway.mockRejectedValueOnce(new Error('network error'));

    // notifyGateway swallows errors internally — handler should not fail
    const result = await handler({ Records: [makeRecord()] });
    expect(result.batchItemFailures).toHaveLength(0);
  });
});

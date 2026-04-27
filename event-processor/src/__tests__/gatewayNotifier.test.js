'use strict';

describe('gatewayNotifier.notifyGateway', () => {
  let mockFetch;

  beforeEach(() => {
    jest.resetModules();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    process.env.GATEWAY_INTERNAL_URL = 'http://localhost:8081';
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('logs WARN and does not throw on non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { notifyGateway } = require('../lib/gatewayNotifier');
    await expect(
      notifyGateway({ movieId: 'tt0111161', viewCount: 3, publishedAt: '2024-01-01T00:00:00.000Z' })
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('notify failed'));
    warnSpy.mockRestore();
  });

  it('logs WARN and does not throw on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { notifyGateway } = require('../lib/gatewayNotifier');
    await expect(
      notifyGateway({ movieId: 'tt0111161', viewCount: 1, publishedAt: '2024-01-01T00:00:00.000Z' })
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('network error'));
    warnSpy.mockRestore();
  });

  it('does not log WARN on successful 200 response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { notifyGateway } = require('../lib/gatewayNotifier');
    await notifyGateway({ movieId: 'tt0111161', viewCount: 1, publishedAt: '2024-01-01T00:00:00.000Z' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('POSTs to the correct URL with correct body shape', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const { notifyGateway } = require('../lib/gatewayNotifier');
    await notifyGateway({ movieId: 'tt0111161', viewCount: 2, publishedAt: '2024-06-01T12:00:00.000Z' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8081/internal/notify',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ movieId: 'tt0111161', viewCount: 2, publishedAt: '2024-06-01T12:00:00.000Z' }),
      })
    );
  });
});

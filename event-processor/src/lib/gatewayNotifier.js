'use strict';

const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || 'http://wsg.local:8081';

/**
 * Notifies the WebSocket Gateway of a view event.
 * Matches the current gateway httpServer.js contract:
 *   POST /internal/notify { movieId, viewCount, publishedAt (ISO string) }
 *
 * Best-effort: logs WARN on failure, never throws.
 *
 * @param {{ movieId: string, viewCount: number, publishedAt: string }} params
 */
async function notifyGateway({ movieId, viewCount, publishedAt }) {
  const url = `${gatewayUrl}/internal/notify`;
  const payload = { movieId, viewCount, publishedAt };

  console.info(
    `[gatewayNotifier] INFO: sending notify url=${url} movieId=${movieId} viewCount=${viewCount} publishedAt=${publishedAt}`
  );

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(
        `[gatewayNotifier] WARN: notify failed movieId=${movieId} status=${res.status} url=${url}`
      );
    } else {
      console.info(
        `[gatewayNotifier] INFO: notify ok movieId=${movieId} status=${res.status}`
      );
    }
  } catch (err) {
    console.warn(
      `[gatewayNotifier] WARN: notify network error movieId=${movieId} url=${url} errorName=${err.name} message=${err.message}`
    );
    // intentionally swallowed — gateway notify is best-effort
  }
}

module.exports = { notifyGateway };

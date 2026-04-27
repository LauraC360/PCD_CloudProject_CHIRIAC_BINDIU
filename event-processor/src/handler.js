'use strict';

const { markProcessed } = require('./lib/idempotency');
const { writeStats } = require('./lib/statsWriter');
const { writeRecentActivity } = require('./lib/recentActivityWriter');
const { notifyGateway } = require('./lib/gatewayNotifier');
const { publishMetrics } = require('./lib/metrics');

// Log non-secret env vars once on cold start
const SECRET_KEYS = new Set(['INTERNAL_SECRET', 'INTERNAL_SECRET_ARN']);
const safeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !SECRET_KEYS.has(k))
);
console.info(`[handler] INFO: cold start — env=${JSON.stringify(safeEnv)}`);

/**
 * Parses and validates a single SQS record body.
 * Returns the parsed event or throws if invalid.
 *
 * @param {string} body
 * @returns {{ schemaVersion: string, requestId: string, movieId: string, title: string, publishedAt: number }}
 */
function parseRecord(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Record body is not valid JSON');
  }

  const { requestId, movieId, title, publishedAt } = parsed;

  if (typeof requestId !== 'string' || requestId.trim() === '') {
    throw new Error('Missing or invalid requestId');
  }
  if (typeof movieId !== 'string' || movieId.trim() === '') {
    throw new Error('Missing or invalid movieId');
  }
  if (typeof title !== 'string') {
    throw new Error('Missing or invalid title');
  }
  if (typeof publishedAt !== 'number' || !Number.isFinite(publishedAt)) {
    throw new Error('Missing or invalid publishedAt (must be epoch ms number)');
  }

  return parsed;
}

/**
 * Main Lambda handler — processes a batch of SQS view events.
 *
 * Flow:
 *  1. Parse + validate each record
 *  2. Idempotency check (skip duplicates)
 *  3. Aggregate deltas by movieId
 *  4. Write MovieStats (one UpdateItem per unique movieId)
 *  5. Write RecentActivity (one PutItem per non-duplicate event)
 *  6. Notify gateway (one POST per unique movieId)
 *  7. Publish CloudWatch metrics
 *  8. Return batchItemFailures for any failed records
 */
exports.handler = async (event) => {
  const startMs = Date.now();
  const batchItemFailures = [];
  const totalRecords = event.Records?.length ?? 0;

  let duplicatesSkipped = 0;
  let dynamoWriteErrors = 0;

  console.info(`[handler] INFO: invocation started totalRecords=${totalRecords}`);

  // --- Step 1 & 2: parse records and run idempotency checks ---

  const validEvents = new Map(); // messageId → parsed event

  await Promise.all(
    (event.Records || []).map(async (record) => {
      const { messageId, body } = record;
      console.info(`[handler] INFO: processing record messageId=${messageId} bodyLength=${body?.length ?? 0}`);
      try {
        const parsed = parseRecord(body);
        console.info(
          `[handler] INFO: parsed record messageId=${messageId} requestId=${parsed.requestId} movieId=${parsed.movieId} title="${parsed.title}" publishedAt=${parsed.publishedAt}`
        );
        const isNew = await markProcessed(parsed.requestId);
        if (!isNew) {
          duplicatesSkipped += 1;
          console.info(
            `[handler] INFO: duplicate skipped messageId=${messageId} requestId=${parsed.requestId} movieId=${parsed.movieId}`
          );
          return;
        }
        console.info(`[handler] INFO: record accepted messageId=${messageId} requestId=${parsed.requestId} movieId=${parsed.movieId}`);
        validEvents.set(messageId, parsed);
      } catch (err) {
        console.error(
          `[handler] ERROR: failed to process record messageId=${messageId} errorName=${err.name} message=${err.message}`
        );
        batchItemFailures.push({ itemIdentifier: messageId });
      }
    })
  );

  const uniqueEvents = Array.from(validEvents.values());

  console.info(
    `[handler] INFO: idempotency phase complete totalRecords=${totalRecords} ` +
    `duplicatesSkipped=${duplicatesSkipped} validEvents=${uniqueEvents.length} ` +
    `parseOrIdempotencyFailures=${batchItemFailures.length}`
  );

  if (uniqueEvents.length === 0) {
    console.info(`[handler] INFO: no valid events to process — publishing metrics and returning`);
    await publishMetrics({ durationMs: Date.now() - startMs, duplicatesSkipped, dynamoWriteErrors });
    return { batchItemFailures };
  }

  // --- Step 3: aggregate deltas by movieId ---
  const aggregated = new Map(); // movieId → { delta, lastViewedAt, title }

  for (const ev of uniqueEvents) {
    const existing = aggregated.get(ev.movieId);
    if (existing) {
      existing.delta += 1;
      if (ev.publishedAt > existing.lastViewedAt) {
        existing.lastViewedAt = ev.publishedAt;
        existing.title = ev.title;
      }
      console.info(
        `[handler] INFO: aggregated existing movieId=${ev.movieId} newDelta=${existing.delta} requestId=${ev.requestId}`
      );
    } else {
      aggregated.set(ev.movieId, { delta: 1, lastViewedAt: ev.publishedAt, title: ev.title });
      console.info(
        `[handler] INFO: aggregated new movieId=${ev.movieId} delta=1 requestId=${ev.requestId}`
      );
    }
  }

  console.info(
    `[handler] INFO: aggregation complete uniqueMovieIds=${aggregated.size} ` +
    `aggregation=${JSON.stringify(Array.from(aggregated.entries()).map(([id, v]) => ({ movieId: id, delta: v.delta })))}`
  );

  // --- Step 4: write MovieStats (one UpdateItem per unique movieId) ---
  console.info(`[handler] INFO: starting MovieStats writes count=${aggregated.size}`);
  await Promise.all(
    Array.from(aggregated.entries()).map(async ([movieId, { delta, lastViewedAt, title }]) => {
      try {
        await writeStats({ movieId, title, delta, lastViewedAt });
      } catch (err) {
        dynamoWriteErrors += 1;
        console.error(
          `[handler] ERROR: writeStats failed movieId=${movieId} delta=${delta} errorName=${err.name} message=${err.message}`
        );
        for (const [msgId, ev] of validEvents.entries()) {
          if (ev.movieId === movieId) {
            console.warn(`[handler] WARN: marking messageId=${msgId} as failed due to writeStats error movieId=${movieId}`);
            batchItemFailures.push({ itemIdentifier: msgId });
          }
        }
      }
    })
  );
  console.info(`[handler] INFO: MovieStats writes done dynamoWriteErrors=${dynamoWriteErrors}`);

  // --- Step 5: write RecentActivity (one PutItem per non-duplicate event) ---
  console.info(`[handler] INFO: starting RecentActivity writes count=${uniqueEvents.length}`);
  await Promise.all(
    uniqueEvents.map(async (ev) => {
      try {
        await writeRecentActivity({
          movieId: ev.movieId,
          title: ev.title,
          publishedAt: ev.publishedAt,
        });
      } catch (err) {
        dynamoWriteErrors += 1;
        console.error(
          `[handler] ERROR: writeRecentActivity failed requestId=${ev.requestId} movieId=${ev.movieId} errorName=${err.name} message=${err.message}`
        );
      }
    })
  );
  console.info(`[handler] INFO: RecentActivity writes done dynamoWriteErrors=${dynamoWriteErrors}`);

  // --- Step 6: notify gateway (one POST per unique movieId) ---
  console.info(`[handler] INFO: starting gateway notifications count=${aggregated.size}`);
  await Promise.all(
    Array.from(aggregated.entries()).map(async ([movieId, { delta, lastViewedAt }]) => {
      const publishedAtIso = new Date(lastViewedAt).toISOString();
      console.info(`[handler] INFO: notifying gateway movieId=${movieId} viewCount=${delta} publishedAt=${publishedAtIso}`);
      try {
        await notifyGateway({
          movieId,
          viewCount: delta,
          publishedAt: publishedAtIso,
        });
      } catch (err) {
        console.warn(`[handler] WARN: notifyGateway threw unexpectedly movieId=${movieId} errorName=${err.name} message=${err.message}`);
      }
    })
  );
  console.info(`[handler] INFO: gateway notifications done`);

  // --- Step 7: publish CloudWatch metrics ---
  const durationMs = Date.now() - startMs;
  console.info(
    `[handler] INFO: batch complete — publishing metrics durationMs=${durationMs} ` +
    `duplicatesSkipped=${duplicatesSkipped} dynamoWriteErrors=${dynamoWriteErrors} ` +
    `batchItemFailures=${batchItemFailures.length}`
  );
  await publishMetrics({ durationMs, duplicatesSkipped, dynamoWriteErrors });

  console.info(
    `[handler] INFO: invocation done durationMs=${durationMs} batchItemFailures=${JSON.stringify(batchItemFailures)}`
  );

  return { batchItemFailures };
};

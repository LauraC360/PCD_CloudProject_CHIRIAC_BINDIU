/**
 * PLACEHOLDER — event-processor Lambda handler
 * Logs env vars (excluding secrets) and the incoming event for verification.
 * Replace with real implementation in Task 10.
 */

// Env vars that contain secrets — never log these
const SECRET_KEYS = new Set(['INTERNAL_SECRET', 'INTERNAL_SECRET_ARN']);

exports.handler = async (event) => {
  console.log('[placeholder] event-processor invoked');

  // Log non-secret env vars
  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !SECRET_KEYS.has(k))
  );
  console.log('[placeholder] env vars:', JSON.stringify(safeEnv, null, 2));

  // Log the incoming SQS event (records only, no message body secrets)
  const summary = (event.Records || []).map(r => ({
    messageId: r.messageId,
    eventSource: r.eventSource,
    body: r.body, // View_Event body — no secrets here
  }));
  console.log('[placeholder] records:', JSON.stringify(summary, null, 2));

  // Return empty batch item failures — all records "succeeded"
  return { batchItemFailures: [] };
};

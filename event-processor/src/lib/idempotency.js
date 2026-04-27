'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const region = process.env.AWS_REGION || 'us-east-1';
const tableName = process.env.DYNAMODB_TABLE_EVENTS || 'ProcessedEvents';

const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Attempts to record a requestId as processed.
 * Uses a conditional PutItem so only the first call succeeds.
 *
 * @param {string} requestId
 * @returns {Promise<boolean>} true if new (written), false if duplicate (already exists)
 */
async function markProcessed(requestId) {
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24h from now
  const processedAt = new Date().toISOString();

  console.info(`[idempotency] INFO: checking requestId=${requestId} table=${tableName}`);

  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: { requestId, ttl, processedAt },
        ConditionExpression: 'attribute_not_exists(requestId)',
      })
    );
    console.info(`[idempotency] INFO: new event recorded requestId=${requestId} ttl=${ttl} processedAt=${processedAt}`);
    return true; // new event
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.info(`[idempotency] INFO: duplicate detected requestId=${requestId} — skipping`);
      return false; // duplicate
    }
    console.error(`[idempotency] ERROR: unexpected DynamoDB error for requestId=${requestId} errorName=${err.name} message=${err.message}`);
    throw err; // unexpected error — let handler surface it
  }
}

module.exports = { markProcessed };

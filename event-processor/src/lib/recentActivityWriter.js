'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const region = process.env.AWS_REGION || 'us-east-1';
const tableName = process.env.DYNAMODB_TABLE_RECENT_ACTIVITY || 'RecentActivity';

const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Derives a UTC date string YYYY-MM-DD from an epoch ms timestamp.
 * @param {number} epochMs
 * @returns {string}
 */
function toUtcDateString(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Writes a recent activity record for a single view event.
 *
 * @param {{ movieId: string, title: string, publishedAt: number }} event - publishedAt is epoch ms
 */
async function writeRecentActivity({ movieId, title, publishedAt }) {
  const date = toUtcDateString(publishedAt);
  const pk = `ACTIVITY#${date}`;
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24h TTL

  console.info(
    `[recentActivityWriter] INFO: writing activity pk=${pk} movieId=${movieId} title="${title}" viewedAt=${publishedAt} ttl=${ttl} table=${tableName}`
  );

  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk,
          viewedAt: publishedAt,
          movieId,
          title,
          ttl,
        },
      })
    );
    console.info(`[recentActivityWriter] INFO: activity written ok pk=${pk} movieId=${movieId}`);
  } catch (err) {
    console.error(
      `[recentActivityWriter] ERROR: PutItem failed pk=${pk} movieId=${movieId} errorName=${err.name} message=${err.message}`
    );
    throw err;
  }
}

module.exports = { writeRecentActivity, toUtcDateString };

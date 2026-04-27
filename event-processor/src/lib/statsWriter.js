'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const region = process.env.AWS_REGION || 'us-east-1';
const tableName = process.env.DYNAMODB_TABLE_STATS || 'MovieStats';

const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Atomically increments viewCount for a movie and updates metadata.
 * Sets pk = "STATS" so the GSI viewCount-index (queried by statsQuery.js) can find it.
 *
 * @param {{ movieId: string, title: string, delta: number, lastViewedAt: number }} params
 */
async function writeStats({ movieId, title, delta, lastViewedAt }) {
  const now = new Date().toISOString();

  console.info(
    `[statsWriter] INFO: writing stats movieId=${movieId} title="${title}" delta=${delta} lastViewedAt=${lastViewedAt} table=${tableName}`
  );

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { movieId },
        UpdateExpression:
          'ADD viewCount :delta SET pk = :pk, lastViewedAt = :ts, updatedAt = :now, title = :title',
        ExpressionAttributeValues: {
          ':delta': delta,
          ':pk': 'STATS',
          ':ts': lastViewedAt,
          ':now': now,
          ':title': title,
        },
      })
    );
    console.info(`[statsWriter] INFO: stats written ok movieId=${movieId} delta=${delta} updatedAt=${now}`);
  } catch (err) {
    console.error(
      `[statsWriter] ERROR: UpdateItem failed movieId=${movieId} delta=${delta} errorName=${err.name} message=${err.message}`
    );
    throw err;
  }
}

module.exports = { writeStats };

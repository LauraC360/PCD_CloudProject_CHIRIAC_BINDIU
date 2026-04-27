'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const region = process.env.AWS_REGION || 'us-east-1';
const tableName = process.env.DYNAMODB_TABLE_RECENT_ACTIVITY || 'RecentActivity';

const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Queries today's RecentActivity partition for the 20 most recent view events.
 * @returns {Promise<Array<{movieId: string, title: string, viewedAt: number}>>}
 */
async function queryRecentActivity() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const pk = `ACTIVITY#${today}`;

  console.info(`[recentActivityQuery] INFO: querying pk=${pk} table=${tableName}`);

  try {
    const response = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ScanIndexForward: false, // newest first
      Limit: 20,
    }));

    const items = (response.Items || []).map((item) => ({
      movieId: item.movieId,
      title: item.title,
      viewedAt: item.viewedAt,
    }));

    console.info(`[recentActivityQuery] INFO: query ok count=${items.length}`);
    return items;
  } catch (err) {
    console.error(`[recentActivityQuery] ERROR: query failed pk=${pk} errorName=${err.name} message=${err.message}`);
    throw err;
  }
}

module.exports = { queryRecentActivity };

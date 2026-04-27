'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const region = process.env.AWS_REGION || 'us-east-1';
const tableName = process.env.DYNAMODB_TABLE_STATS || 'MovieStats';

const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Queries the MovieStats GSI (viewCount-index) for the top 10 movies
async function queryTop10() {
  console.info(`[statsQuery] INFO: querying top10 table=${tableName} index=viewCount-index`);

  const command = new QueryCommand({
    TableName: tableName,
    IndexName: 'viewCount-index',
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': 'STATS',
    },
    ScanIndexForward: false, // descending by viewCount
    Limit: 10,
  });

  try {
    const response = await docClient.send(command);
    const items = (response.Items || []).map((item) => ({
      movieId: item.movieId,
      title: item.title,
      viewCount: item.viewCount,
      lastViewedAt: item.lastViewedAt,
    }));
    console.info(`[statsQuery] INFO: top10 query ok count=${items.length} top=${items[0]?.movieId ?? 'none'}`);
    return items;
  } catch (err) {
    console.error(`[statsQuery] ERROR: query failed table=${tableName} errorName=${err.name} message=${err.message}`);
    throw err;
  }
}

module.exports = { queryTop10 };

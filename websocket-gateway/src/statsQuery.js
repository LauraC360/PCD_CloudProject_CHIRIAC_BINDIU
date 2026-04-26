'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const region = process.env.AWS_REGION || 'us-east-1';
const tableName = process.env.DYNAMODB_TABLE_STATS || 'MovieStats';

const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Queries the MovieStats GSI (viewCount-index) for the top 10 movies
async function queryTop10() {
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

  const response = await docClient.send(command);

  return (response.Items || []).map((item) => ({
    movieId: item.movieId,
    viewCount: item.viewCount,
    lastViewedAt: item.lastViewedAt,
  }));
}

module.exports = { queryTop10 };

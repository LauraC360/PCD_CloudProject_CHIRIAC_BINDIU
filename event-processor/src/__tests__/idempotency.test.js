'use strict';

// Mock the AWS SDK modules at the top level
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockReturnValue({ send: mockSend }),
  },
  PutCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

beforeEach(() => {
  mockSend.mockReset();
});

describe('idempotency.markProcessed', () => {
  const { markProcessed } = require('../lib/idempotency');

  it('returns true when the item is new (PutItem succeeds)', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await markProcessed('req-001');
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns false when the item already exists (ConditionalCheckFailedException)', async () => {
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(err);
    const result = await markProcessed('req-001');
    expect(result).toBe(false);
  });

  it('rethrows unexpected DynamoDB errors', async () => {
    const err = new Error('ProvisionedThroughputExceededException');
    err.name = 'ProvisionedThroughputExceededException';
    mockSend.mockRejectedValueOnce(err);
    await expect(markProcessed('req-001')).rejects.toThrow('ProvisionedThroughputExceededException');
  });
});

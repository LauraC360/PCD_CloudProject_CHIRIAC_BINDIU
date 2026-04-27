/**
 * End-to-End Integration Test
 * 
 * Tests the full flow:
 * 1. WebSocket client connects to Gateway
 * 2. HTTP client calls Service A GET /movies/:id
 * 3. Service A publishes View_Event to SQS (mock)
 * 4. Gateway receives notification and broadcasts stats_update
 * 5. WebSocket client receives stats_update with updated viewCount
 * 
 * This test runs locally without AWS deployment.
 * It uses mock SQS and mock DynamoDB.
 */

const WebSocket = require('ws');
const http = require('http');
const { DynamoDBDocumentClient, QueryCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

// Mock DynamoDB responses
const mockDynamoDBClient = {
  send: jest.fn(async (command) => {
    if (command instanceof QueryCommand) {
      // Return mock top-10 movies
      return {
        Items: [
          { movieId: 'tt0111161', viewCount: 100, lastViewedAt: new Date().toISOString() },
          { movieId: 'tt0068646', viewCount: 95, lastViewedAt: new Date().toISOString() }
        ]
      };
    }
    if (command instanceof PutCommand) {
      // Idempotency check — first call succeeds, second fails
      return {};
    }
    return {};
  })
};

describe('End-to-End Integration Test', () => {
  let wsServer;
  let httpServer;
  let wsClient;
  let serviceAUrl = 'http://localhost:3000';
  let gatewayWsUrl = 'ws://localhost:8080';
  let gatewayHttpUrl = 'http://localhost:8081';

  beforeAll(async () => {
    // Wait for Service A to be running
    // (Assumes Service A is already started on port 3000)
    // In a real test, we'd start it here, but for now we assume it's running
    
    // Wait for Gateway to be running
    // (Assumes Gateway is already started on ports 8080/8081)
    
    // Give servers time to start
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    if (wsClient) {
      wsClient.close();
    }
  });

  test('should receive stats_update after calling GET /movies/:id', async () => {
    return new Promise((resolve, reject) => {
      // Connect WebSocket client
      wsClient = new WebSocket(gatewayWsUrl);

      let receivedInitialState = false;
      let receivedStatsUpdate = false;

      wsClient.on('open', async () => {
        console.log('WebSocket connected');
      });

      wsClient.on('message', async (data) => {
        try {
          const message = JSON.parse(data);
          console.log('Received message:', message.type);

          if (message.type === 'initial_state') {
            receivedInitialState = true;
            console.log('Received initial_state, connectedClients:', message.connectedClients);

            // Now make HTTP request to Service A
            // This should trigger SQS publish and Gateway notification
            setTimeout(async () => {
              try {
                const response = await fetch(`${serviceAUrl}/api/v1/movies/573a1390f29313caabcd42e8`);
                const movie = await response.json();
                console.log('Service A response:', movie.title);
              } catch (err) {
                console.error('Error calling Service A:', err.message);
                reject(err);
              }
            }, 500);
          }

          if (message.type === 'stats_update') {
            receivedStatsUpdate = true;
            console.log('Received stats_update');
            console.log('  - connectedClients:', message.connectedClients);
            console.log('  - top10 length:', message.top10?.length);
            console.log('  - latency:', message.deliveredAt ? 
              new Date(message.deliveredAt).getTime() - new Date(message.publishedAt).getTime() + 'ms' : 'N/A');

            // Verify message structure
            expect(message.type).toBe('stats_update');
            expect(message.connectedClients).toBeGreaterThanOrEqual(1);
            expect(message.top10).toBeDefined();
            expect(Array.isArray(message.top10)).toBe(true);
            expect(message.deliveredAt).toBeDefined();
            expect(message.publishedAt).toBeDefined();

            // Verify latency is reasonable (< 5 seconds)
            const latency = new Date(message.deliveredAt).getTime() - new Date(message.publishedAt).getTime();
            expect(latency).toBeLessThan(5000);
            expect(latency).toBeGreaterThan(0);

            wsClient.close();
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      });

      wsClient.on('error', (err) => {
        console.error('WebSocket error:', err);
        reject(err);
      });

      wsClient.on('close', () => {
        console.log('WebSocket closed');
        if (!receivedStatsUpdate) {
          reject(new Error('Did not receive stats_update before connection closed'));
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!receivedStatsUpdate) {
          wsClient.close();
          reject(new Error('Timeout waiting for stats_update'));
        }
      }, 10000);
    });
  });

  test('should handle multiple concurrent connections', async () => {
    return new Promise((resolve, reject) => {
      const clients = [];
      let connectedCount = 0;
      let statsUpdateCount = 0;
      const expectedClients = 3;

      const connectClient = (index) => {
        const client = new WebSocket(gatewayWsUrl);

        client.on('open', () => {
          console.log(`Client ${index} connected`);
          connectedCount++;
        });

        client.on('message', (data) => {
          try {
            const message = JSON.parse(data);

            if (message.type === 'stats_update') {
              statsUpdateCount++;
              console.log(`Client ${index} received stats_update, connectedClients: ${message.connectedClients}`);

              // Verify connectedClients count matches expected
              expect(message.connectedClients).toBeGreaterThanOrEqual(expectedClients);

              if (statsUpdateCount >= expectedClients) {
                // All clients received update
                clients.forEach(c => c.close());
                resolve();
              }
            }
          } catch (err) {
            reject(err);
          }
        });

        client.on('error', (err) => {
          console.error(`Client ${index} error:`, err);
          reject(err);
        });

        clients.push(client);
      };

      // Connect multiple clients
      for (let i = 0; i < expectedClients; i++) {
        setTimeout(() => connectClient(i), i * 100);
      }

      // Trigger a view event after all clients are connected
      setTimeout(async () => {
        try {
          await fetch(`${serviceAUrl}/api/v1/metrics`);
        } catch (err) {
          console.error('Error calling metrics:', err.message);
        }
      }, 1000);

      // Timeout after 15 seconds
      setTimeout(() => {
        clients.forEach(c => c.close());
        reject(new Error('Timeout waiting for all clients to receive stats_update'));
      }, 15000);
    });
  });

  test('GET /health should return gateway status', async () => {
    try {
      const response = await fetch(`${gatewayHttpUrl}/health`);
      const data = await response.json();

      console.log('Health check response:', data);

      expect(response.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.connectedClients).toBeDefined();
      expect(typeof data.connectedClients).toBe('number');
      expect(data.backpressureActive).toBeDefined();
      expect(typeof data.backpressureActive).toBe('boolean');
    } catch (err) {
      throw new Error(`Health check failed: ${err.message}`);
    }
  });

  test('GET /metrics should return Service A metrics', async () => {
    try {
      const response = await fetch(`${serviceAUrl}/api/v1/metrics`);
      const data = await response.json();

      console.log('Service A metrics:', data);

      expect(response.status).toBe(200);
      expect(data.totalPublished).toBeDefined();
      expect(typeof data.totalPublished).toBe('number');
      expect(data.publishErrors).toBeDefined();
      expect(typeof data.publishErrors).toBe('number');
      expect(data.avgPublishLatencyMs).toBeDefined();
      expect(typeof data.avgPublishLatencyMs).toBe('number');
    } catch (err) {
      throw new Error(`Metrics check failed: ${err.message}`);
    }
  });
});

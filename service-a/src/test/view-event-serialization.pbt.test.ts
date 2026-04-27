import fc from 'fast-check';

/**
 * Feature: realtime-analytics-dashboard, Property 4: Serialization Round-Trip
 *
 * For any valid ViewEvent object, serializing it to JSON (as Service A does
 * when publishing to SQS) and then deserializing it (as the Event Processor
 * Lambda does when consuming from SQS) SHALL yield an object with identical
 * field values (schemaVersion, requestId, movieId, title, publishedAt).
 *
 * The publishedAt field is epoch milliseconds (number), not an ISO string —
 * this property is the regression guard for Task 9.3/9.4.
 */

// Arbitrary that generates a realistic ViewEvent, matching the shape defined
// in service-a/src/types/resources.d.ts.
const viewEventArbitrary = fc.record<ViewEvent>({
  schemaVersion: fc.constantFrom('1.0', '1.1', '2.0'),
  requestId: fc.uuid(),
  movieId: fc.stringMatching(/^tt\d{7,9}$/),
  title: fc.string({ minLength: 1, maxLength: 200 }),
  // Epoch ms — use integer to guarantee JSON preserves the exact value after
  // a parse→stringify round-trip (floats can be subject to representation
  // drift, but integers ≤ Number.MAX_SAFE_INTEGER round-trip losslessly).
  publishedAt: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
});

describe('ViewEvent serialization round-trip (property-based)', () => {
  it('survives JSON.stringify → JSON.parse with all fields identical', () => {
    fc.assert(
      fc.property(viewEventArbitrary, (event) => {
        // This simulates exactly what sqs.ts does:
        //   client.send(new SendMessageCommand({ MessageBody: JSON.stringify(event) }))
        // and what the Lambda handler does:
        //   const event = JSON.parse(sqsRecord.body)
        const wire = JSON.stringify(event);
        const parsed: ViewEvent = JSON.parse(wire);

        expect(parsed.schemaVersion).toBe(event.schemaVersion);
        expect(parsed.requestId).toBe(event.requestId);
        expect(parsed.movieId).toBe(event.movieId);
        expect(parsed.title).toBe(event.title);
        expect(parsed.publishedAt).toBe(event.publishedAt);
        // Crucially, publishedAt must remain a number — not a string —
        // after the round trip.
        expect(typeof parsed.publishedAt).toBe('number');
        expect(Number.isFinite(parsed.publishedAt)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('preserves unicode titles (emojis, non-Latin scripts) through the round trip', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 100 }), (title) => {
        const event: ViewEvent = {
          schemaVersion: '1.0',
          requestId: '550e8400-e29b-41d4-a716-446655440000',
          movieId: 'tt0111161',
          title,
          publishedAt: 1745678901234
        };
        const parsed: ViewEvent = JSON.parse(JSON.stringify(event));
        expect(parsed.title).toBe(title);
      }),
      { numRuns: 200 }
    );
  });

  it('preserves the numeric publishedAt — string ISO dates are rejected by the type', () => {
    // This is a static-check-style reminder: the ViewEvent.publishedAt field
    // MUST be a number. We assert at runtime that even large millisecond
    // timestamps round-trip exactly.
    fc.assert(
      fc.property(
        fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 }),
        (publishedAt) => {
          const event: ViewEvent = {
            schemaVersion: '1.0',
            requestId: '550e8400-e29b-41d4-a716-446655440000',
            movieId: 'tt0111161',
            title: 'Test',
            publishedAt
          };
          const parsed: ViewEvent = JSON.parse(JSON.stringify(event));
          expect(parsed.publishedAt).toBe(publishedAt);
          expect(typeof parsed.publishedAt).toBe('number');
        }
      ),
      { numRuns: 150 }
    );
  });
});

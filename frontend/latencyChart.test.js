/**
 * latencyChart.test.js — Unit tests for latencyChart.js
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run with: node --test frontend/latencyChart.test.js
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ─── Module bootstrap ─────────────────────────────────────────────────────────
// latencyChart.js is an IIFE that references `window` and `Date.now`.
// We stub the minimum globals needed before requiring the module.

// Stub window so the IIFE can assign window.latencyChart without throwing.
global.window = {};

// Require the module — the conditional `module.exports` block at the bottom
// exposes the testable surface without breaking browser usage.
const latencyChart = require('./latencyChart.js');
const { addSample, getPercentiles, _getLatencySamples, _resetSamples } = latencyChart;

// ─── Time control ─────────────────────────────────────────────────────────────
// We replace Date.now with a controllable clock so tests are deterministic.

let _fakeNow = 0;
const _realDateNow = Date.now;

function setFakeNow(ms) {
  _fakeNow = ms;
  Date.now = () => _fakeNow;
}

function restoreDateNow() {
  Date.now = _realDateNow;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build an ISO 8601 timestamp that is `offsetMs` milliseconds after a fixed
 * epoch (2024-01-01T00:00:00.000Z = 1704067200000).
 */
const BASE_EPOCH = 1_704_067_200_000; // 2024-01-01T00:00:00.000Z

function isoAt(offsetMs) {
  return new Date(BASE_EPOCH + offsetMs).toISOString();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('latencyChart', () => {

  beforeEach(() => {
    // Reset module state and fix the clock before every test.
    _resetSamples();
    setFakeNow(BASE_EPOCH);
  });

  afterEach(() => {
    restoreDateNow();
  });

  // ── addSample: skip on missing publishedAt ──────────────────────────────────

  describe('addSample — skips entries with missing publishedAt', () => {

    test('skips when publishedAt is null', () => {
      addSample(null, isoAt(100));
      assert.equal(_getLatencySamples().length, 0);
    });

    test('skips when publishedAt is undefined', () => {
      addSample(undefined, isoAt(100));
      assert.equal(_getLatencySamples().length, 0);
    });

    test('skips when publishedAt is an empty string', () => {
      addSample('', isoAt(100));
      assert.equal(_getLatencySamples().length, 0);
    });

    test('records a sample when publishedAt is a valid ISO string', () => {
      addSample(isoAt(0), isoAt(200));
      assert.equal(_getLatencySamples().length, 1);
      assert.equal(_getLatencySamples()[0].latencyMs, 200);
    });

  });

  // ── getPercentiles: p50/p95/p99 for known sample sets ──────────────────────

  describe('getPercentiles — p50/p95/p99 calculation', () => {

    test('returns null percentiles when there are no samples', () => {
      const result = getPercentiles();
      assert.deepEqual(result, { p50: null, p95: null, p99: null });
    });

    test('returns the single value for all percentiles when there is one sample', () => {
      addSample(isoAt(0), isoAt(42));
      const { p50, p95, p99 } = getPercentiles();
      assert.equal(p50, 42);
      assert.equal(p95, 42);
      assert.equal(p99, 42);
    });

    test('p50/p95/p99 for 10 samples [10, 20, ..., 100]', () => {
      // Samples: latencyMs = 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
      // Sorted: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]  (n=10)
      // Nearest-rank: index = ceil(p/100 * n) - 1
      //   p50: ceil(0.5 * 10) - 1 = 5 - 1 = 4  → sorted[4] = 50
      //   p95: ceil(0.95 * 10) - 1 = 10 - 1 = 9 → sorted[9] = 100
      //   p99: ceil(0.99 * 10) - 1 = 10 - 1 = 9 → sorted[9] = 100
      for (let i = 1; i <= 10; i++) {
        addSample(isoAt(0), isoAt(i * 10));
      }
      const { p50, p95, p99 } = getPercentiles();
      assert.equal(p50, 50);
      assert.equal(p95, 100);
      assert.equal(p99, 100);
    });

    test('p50/p95/p99 for 100 samples [1, 2, ..., 100]', () => {
      // Sorted: [1, 2, ..., 100]  (n=100)
      // p50: ceil(0.50 * 100) - 1 = 50 - 1 = 49 → sorted[49] = 50
      // p95: ceil(0.95 * 100) - 1 = 95 - 1 = 94 → sorted[94] = 95
      // p99: ceil(0.99 * 100) - 1 = 99 - 1 = 98 → sorted[98] = 99
      for (let i = 1; i <= 100; i++) {
        addSample(isoAt(0), isoAt(i));
      }
      const { p50, p95, p99 } = getPercentiles();
      assert.equal(p50, 50);
      assert.equal(p95, 95);
      assert.equal(p99, 99);
    });

    test('p50/p95/p99 for 4 samples [10, 20, 30, 40]', () => {
      // Sorted: [10, 20, 30, 40]  (n=4)
      // p50: ceil(0.50 * 4) - 1 = 2 - 1 = 1 → sorted[1] = 20
      // p95: ceil(0.95 * 4) - 1 = 4 - 1 = 3 → sorted[3] = 40
      // p99: ceil(0.99 * 4) - 1 = 4 - 1 = 3 → sorted[3] = 40
      [10, 20, 30, 40].forEach(ms => addSample(isoAt(0), isoAt(ms)));
      const { p50, p95, p99 } = getPercentiles();
      assert.equal(p50, 20);
      assert.equal(p95, 40);
      assert.equal(p99, 40);
    });

    test('sorts samples correctly regardless of insertion order', () => {
      // Insert in reverse order: 100, 90, ..., 10
      for (let i = 10; i >= 1; i--) {
        addSample(isoAt(0), isoAt(i * 10));
      }
      const { p50 } = getPercentiles();
      // Same as ascending insertion: p50 should be 50
      assert.equal(p50, 50);
    });

  });

  // ── addSample: pruning samples older than 60 seconds ───────────────────────

  describe('addSample — prunes samples older than 60 seconds', () => {

    test('retains samples within the 60-second window', () => {
      // t=0: add a sample; clock stays at 0 → sample is fresh
      addSample(isoAt(0), isoAt(100));
      assert.equal(_getLatencySamples().length, 1);
    });

    test('prunes a sample that is exactly 60 seconds old when a new sample arrives', () => {
      // Add sample at t=0
      addSample(isoAt(0), isoAt(100));
      assert.equal(_getLatencySamples().length, 1);

      // Advance clock by 60 001 ms (just past the 60-second window)
      setFakeNow(BASE_EPOCH + 60_001);

      // Adding a new sample triggers pruning
      addSample(isoAt(60_001), isoAt(60_101));

      // The first sample (ts = BASE_EPOCH) is now older than 60 s → pruned
      // Only the new sample should remain
      assert.equal(_getLatencySamples().length, 1);
      assert.equal(_getLatencySamples()[0].latencyMs, 100);
    });

    test('prunes multiple old samples, keeps recent ones', () => {
      // Add 3 samples at t=0
      for (let i = 0; i < 3; i++) {
        addSample(isoAt(0), isoAt(i * 10));
      }
      assert.equal(_getLatencySamples().length, 3);

      // Advance clock by 61 seconds
      setFakeNow(BASE_EPOCH + 61_000);

      // Add 2 fresh samples — triggers pruning of the 3 old ones
      addSample(isoAt(61_000), isoAt(61_050));
      addSample(isoAt(61_000), isoAt(61_080));

      assert.equal(_getLatencySamples().length, 2);
    });

    test('getPercentiles prunes stale samples before computing', () => {
      // Add a sample at t=0
      addSample(isoAt(0), isoAt(500));

      // Advance clock past the window
      setFakeNow(BASE_EPOCH + 61_000);

      // getPercentiles should prune the stale sample and return nulls
      const { p50, p95, p99 } = getPercentiles();
      assert.equal(p50, null);
      assert.equal(p95, null);
      assert.equal(p99, null);
    });

    test('sample added exactly at the window boundary is NOT pruned', () => {
      // Add sample at t=0
      addSample(isoAt(0), isoAt(100));

      // Advance clock to exactly 60 000 ms — cutoff = BASE_EPOCH + 0
      // The sample ts = BASE_EPOCH, cutoff = BASE_EPOCH + 60000 - 60000 = BASE_EPOCH
      // Condition: ts < cutoff → BASE_EPOCH < BASE_EPOCH → false → NOT pruned
      setFakeNow(BASE_EPOCH + 60_000);

      addSample(isoAt(60_000), isoAt(60_200));

      // Both samples should still be present (the first is at the boundary, not past it)
      assert.equal(_getLatencySamples().length, 2);
    });

  });

});

/**
 * latencyChart.js — End-to-end latency percentile module
 *
 * Exposes three functions on window.latencyChart:
 *   - addSample(publishedAt, deliveredAt)
 *   - getPercentiles()
 *   - renderChart(canvas, percentiles?)
 *
 * Maintains a 60-second sliding window of latency samples and renders
 * p50 / p95 / p99 percentile lines on a Chart.js canvas.
 *
 * No external dependencies beyond Chart.js (loaded from CDN in index.html).
 *
 * Feature: realtime-analytics-dashboard
 */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  /** Sliding window duration in milliseconds. */
  const WINDOW_MS = 60_000;

  /** Maximum number of data points kept in the Chart.js dataset. */
  const MAX_CHART_POINTS = 60;

  // ─── State ────────────────────────────────────────────────────────────────

  /**
   * Array of latency samples within the current 60-second window.
   * Each entry: { ts: number (Date.now()), latencyMs: number }
   */
  let latencySamples = [];

  /**
   * Cached Chart.js instance — created lazily on first renderChart() call.
   * @type {Chart|null}
   */
  let chartInstance = null;

  // ─── addSample ────────────────────────────────────────────────────────────

  /**
   * Record a new latency sample.
   *
   * Computes latencyMs = Date.parse(deliveredAt) - Date.parse(publishedAt),
   * appends it to latencySamples, then prunes entries older than 60 seconds.
   * Skips silently if publishedAt is missing or falsy.
   *
   * @param {string|null|undefined} publishedAt - ISO 8601 UTC timestamp from View_Event
   * @param {string} deliveredAt               - ISO 8601 UTC timestamp stamped by Gateway
   */
  function addSample(publishedAt, deliveredAt) {
    // Skip if publishedAt is absent (initial_state messages have no publishedAt)
    if (!publishedAt) return;

    const published = Date.parse(publishedAt);
    const delivered = Date.parse(deliveredAt);

    // Skip if either timestamp is unparseable
    if (isNaN(published) || isNaN(delivered)) return;

    const latencyMs = delivered - published;
    const ts = Date.now();

    latencySamples.push({ ts, latencyMs });

    // Prune samples outside the 60-second window
    _pruneOldSamples();
  }

  /**
   * Remove samples older than WINDOW_MS from the front of the array.
   * @private
   */
  function _pruneOldSamples() {
    const cutoff = Date.now() - WINDOW_MS;
    // latencySamples is appended in chronological order, so we can slice from the front
    let i = 0;
    while (i < latencySamples.length && latencySamples[i].ts < cutoff) {
      i++;
    }
    if (i > 0) {
      latencySamples = latencySamples.slice(i);
    }
  }

  // ─── getPercentiles ───────────────────────────────────────────────────────

  /**
   * Compute p50, p95, and p99 from the current sample window.
   *
   * Uses index-based percentile selection on a sorted copy of latencyMs values.
   * Returns null for each percentile when there are no samples.
   *
   * @returns {{ p50: number|null, p95: number|null, p99: number|null }}
   */
  function getPercentiles() {
    _pruneOldSamples();

    if (latencySamples.length === 0) {
      return { p50: null, p95: null, p99: null };
    }

    // Sort a copy of the latency values ascending
    const sorted = latencySamples
      .map(function (s) { return s.latencyMs; })
      .sort(function (a, b) { return a - b; });

    return {
      p50: _percentile(sorted, 50),
      p95: _percentile(sorted, 95),
      p99: _percentile(sorted, 99),
    };
  }

  /**
   * Index-based percentile selection.
   *
   * Uses the "nearest rank" method:
   *   index = ceil(p / 100 * n) - 1   (clamped to [0, n-1])
   *
   * @param {number[]} sorted - ascending-sorted array of values
   * @param {number}   p      - percentile (0–100)
   * @returns {number}
   * @private
   */
  function _percentile(sorted, p) {
    const n = sorted.length;
    if (n === 0) return null;
    const index = Math.max(0, Math.ceil((p / 100) * n) - 1);
    return sorted[Math.min(index, n - 1)];
  }

  // ─── renderChart ──────────────────────────────────────────────────────────

  /**
   * Render or update the latency percentile chart on the provided canvas.
   *
   * Creates a Chart.js line chart on first call; subsequent calls update the
   * existing instance in-place (no flicker). Also updates the p50/p95/p99
   * badge elements in the page header.
   *
   * @param {HTMLCanvasElement} canvas      - the <canvas> element to draw on
   * @param {{ p50, p95, p99 }} [percentiles] - pre-computed percentiles;
   *   if omitted, getPercentiles() is called internally
   */
  function renderChart(canvas, percentiles) {
    if (!canvas) return;

    // Resolve percentiles
    const pct = percentiles || getPercentiles();

    // Update the badge elements in the header
    _updateBadge('latency-p50', pct.p50);
    _updateBadge('latency-p95', pct.p95);
    _updateBadge('latency-p99', pct.p99);

    // Build the rolling time-series label (last N points, one per sample)
    // We keep at most MAX_CHART_POINTS entries for readability
    _pruneOldSamples();
    const window60 = latencySamples.slice(-MAX_CHART_POINTS);

    const labels = window60.map(function (s) {
      return new Date(s.ts).toLocaleTimeString();
    });

    const rawData = window60.map(function (s) {
      return s.latencyMs;
    });

    // Compute a rolling p50/p95/p99 for each point in the visible window
    // so the chart lines show how percentiles evolved over time
    const p50Data = [];
    const p95Data = [];
    const p99Data = [];

    for (let i = 0; i < window60.length; i++) {
      // Use all samples up to and including index i
      const slice = window60.slice(0, i + 1).map(function (s) { return s.latencyMs; }).sort(function (a, b) { return a - b; });
      p50Data.push(_percentile(slice, 50));
      p95Data.push(_percentile(slice, 95));
      p99Data.push(_percentile(slice, 99));
    }

    if (!chartInstance) {
      // ── Create chart ──────────────────────────────────────────────────────
      chartInstance = new Chart(canvas, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'p50',
              data: p50Data,
              borderColor: 'rgb(129, 140, 248)',   // indigo-400
              backgroundColor: 'rgba(129, 140, 248, 0.08)',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.3,
              fill: false,
            },
            {
              label: 'p95',
              data: p95Data,
              borderColor: 'rgb(251, 191, 36)',    // amber-400
              backgroundColor: 'rgba(251, 191, 36, 0.08)',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.3,
              fill: false,
            },
            {
              label: 'p99',
              data: p99Data,
              borderColor: 'rgb(251, 113, 133)',   // rose-400
              backgroundColor: 'rgba(251, 113, 133, 0.08)',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.3,
              fill: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,           // disable animation for real-time updates
          interaction: {
            mode: 'index',
            intersect: false,
          },
          plugins: {
            legend: {
              display: true,
              labels: {
                color: 'rgb(156, 163, 175)',  // gray-400
                boxWidth: 12,
                padding: 16,
              },
            },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  return ctx.dataset.label + ': ' + (ctx.parsed.y != null ? ctx.parsed.y + ' ms' : '—');
                },
              },
            },
          },
          scales: {
            x: {
              ticks: {
                color: 'rgb(107, 114, 128)',  // gray-500
                maxTicksLimit: 8,
                maxRotation: 0,
              },
              grid: {
                color: 'rgba(55, 65, 81, 0.6)',  // gray-700 / 60%
              },
            },
            y: {
              title: {
                display: true,
                text: 'Latency (ms)',
                color: 'rgb(107, 114, 128)',
              },
              ticks: {
                color: 'rgb(107, 114, 128)',
                callback: function (value) { return value + ' ms'; },
              },
              grid: {
                color: 'rgba(55, 65, 81, 0.6)',
              },
              beginAtZero: true,
            },
          },
        },
      });
    } else {
      // ── Update existing chart in-place ────────────────────────────────────
      chartInstance.data.labels = labels;
      chartInstance.data.datasets[0].data = p50Data;
      chartInstance.data.datasets[1].data = p95Data;
      chartInstance.data.datasets[2].data = p99Data;
      chartInstance.update('none');  // 'none' skips animation for smooth real-time feel
    }
  }

  /**
   * Update a percentile badge element's text content.
   *
   * @param {string}        id    - element ID
   * @param {number|null}   value - latency in ms, or null when no data
   * @private
   */
  function _updateBadge(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (value != null) ? String(Math.round(value)) : '—';
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.latencyChart = {
    addSample: addSample,
    getPercentiles: getPercentiles,
    renderChart: renderChart,
  };

  // CommonJS export for unit testing (does not affect browser usage)
  if (typeof module !== 'undefined') {
    module.exports = {
      addSample: addSample,
      getPercentiles: getPercentiles,
      _getLatencySamples: function () { return latencySamples; },
      _resetSamples: function () { latencySamples = []; },
    };
  }

}());

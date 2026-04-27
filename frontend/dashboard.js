/**
 * dashboard.js — DOM update module for the Realtime Analytics Dashboard
 *
 * Exposes three functions on window.dashboard:
 *   - renderTop10(top10)
 *   - renderConnectedClients(count)
 *   - renderActivityFeed(event)
 *
 * All DOM operations are synchronous to satisfy the 500ms update requirement
 * (Requirement 6.2). No external dependencies — vanilla JS only.
 */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  /** Maximum number of items kept in the activity feed. */
  const FEED_MAX_ITEMS = 20;

  /**
   * Sentinel text content of the placeholder <li> inserted by index.html.
   * Used to detect and remove it on the first real activity event.
   */
  const FEED_PLACEHOLDER_TEXT = 'Waiting for activity…';

  // ─── renderTop10 ──────────────────────────────────────────────────────────

  /**
   * Render the top-10 movies table.
   *
   * Replaces all rows in #top-movies-tbody with fresh <tr> elements built
   * from the provided array. Rows are sorted descending by viewCount before
   * rendering (defensive sort — the Gateway should already sort, but we sort
   * locally too for resilience).
   *
   * @param {Array<{movieId: string, viewCount: number, lastViewedAt: string}>|null|undefined} top10
   *   Array of movie stat objects. Falsy or empty values render a "No data yet" row.
   */
  function renderTop10(top10) {
    const tbody = document.getElementById('top-movies-tbody');
    if (!tbody) return;

    // Clear existing rows
    tbody.textContent = '';

    // Guard: empty or falsy input → show placeholder row
    if (!top10 || !Array.isArray(top10) || top10.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.setAttribute('colspan', '4');
      td.className = 'px-5 py-8 text-center text-blue-500 text-sm';
      td.textContent = 'No data yet';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    // Defensive sort: descending by viewCount
    const sorted = top10.slice().sort(function (a, b) {
      return (Number(b.viewCount) || 0) - (Number(a.viewCount) || 0);
    });

    sorted.forEach(function (item, index) {
      const rank = index + 1;
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-blue-50 transition-colors text-sm';

      // # (rank)
      const tdRank = document.createElement('td');
      tdRank.className = 'px-5 py-3 text-blue-600 tabular-nums font-medium';
      tdRank.textContent = String(rank);

      // Title (with movieId as fallback)
      const tdMovieId = document.createElement('td');
      tdMovieId.className = 'px-5 py-3 text-purple-600 font-semibold';
      tdMovieId.textContent = item.title != null ? String(item.title) : (item.movieId != null ? String(item.movieId) : '—');

      // Views (formatted with toLocaleString)
      const tdViews = document.createElement('td');
      tdViews.className = 'px-5 py-3 text-right text-blue-700 tabular-nums font-medium';
      tdViews.textContent = item.viewCount != null
        ? Number(item.viewCount).toLocaleString()
        : '—';

      // Last Viewed (formatted as locale time string)
      const tdLastViewed = document.createElement('td');
      tdLastViewed.className = 'px-5 py-3 text-right text-blue-600 hidden sm:table-cell text-xs';
      if (item.lastViewedAt) {
        try {
          tdLastViewed.textContent = new Date(item.lastViewedAt).toLocaleTimeString();
        } catch (_) {
          tdLastViewed.textContent = String(item.lastViewedAt);
        }
      } else {
        tdLastViewed.textContent = '—';
      }

      tr.appendChild(tdRank);
      tr.appendChild(tdMovieId);
      tr.appendChild(tdViews);
      tr.appendChild(tdLastViewed);
      tbody.appendChild(tr);
    });
  }

  // ─── renderConnectedClients ───────────────────────────────────────────────

  /**
   * Update the connected-users counter.
   *
   * Sets the textContent of #connected-clients to the provided count.
   * Renders '—' when count is null or undefined.
   *
   * @param {number|null|undefined} count - number of currently connected clients
   */
  function renderConnectedClients(count) {
    const el = document.getElementById('connected-clients');
    if (!el) return;

    el.textContent = (count != null) ? String(count) : '—';
  }

  // ─── renderActivityFeed ───────────────────────────────────────────────────

  /**
   * Prepend a new activity event to the #activity-feed list.
   *
   * Behaviour:
   *  - Removes the "Waiting for activity…" placeholder on the first real item.
   *  - Prepends a new <li> with movieId and a formatted lastViewedAt timestamp.
   *  - Trims the list to at most FEED_MAX_ITEMS (20) items by removing the
   *    oldest entries from the end.
   *
   * @param {{ movieId: string, lastViewedAt: string }} event
   *   The stats_update message (or any object with movieId and lastViewedAt).
   */
  function renderActivityFeed(event) {
    const feed = document.getElementById('activity-feed');
    if (!feed) return;

    const { movieId, title, lastViewedAt, deliveredAt } = event || {};
    const displayName = title != null ? String(title) : (movieId != null ? String(movieId) : '—');
    const displayTime = deliveredAt || lastViewedAt;

    // Remove placeholder <li> if it is still present
    const items = feed.querySelectorAll('li');
    if (items.length === 1 && items[0].textContent.trim() === FEED_PLACEHOLDER_TEXT) {
      feed.removeChild(items[0]);
    }

    // Build new <li>
    const li = document.createElement('li');
    li.className = 'px-5 py-3 text-sm flex items-center justify-between gap-3 bg-purple-50 hover:bg-purple-100 transition-colors';

    // Title (with movieId as fallback)
    const movieSpan = document.createElement('span');
    movieSpan.className = 'font-semibold text-blue-600 truncate';
    movieSpan.textContent = displayName;

    // Timestamp
    const timeSpan = document.createElement('span');
    timeSpan.className = 'text-purple-600 text-xs whitespace-nowrap flex-shrink-0';
    if (displayTime) {
      try {
        timeSpan.textContent = new Date(displayTime).toLocaleTimeString();
      } catch (_) {
        timeSpan.textContent = String(lastViewedAt);
      }
    } else {
      timeSpan.textContent = '—';
    }

    li.appendChild(movieSpan);
    li.appendChild(timeSpan);

    // Prepend to the top of the feed
    feed.insertBefore(li, feed.firstChild);

    // Trim to FEED_MAX_ITEMS — remove from the end (oldest)
    const allItems = feed.querySelectorAll('li');
    for (let i = FEED_MAX_ITEMS; i < allItems.length; i++) {
      feed.removeChild(allItems[i]);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.dashboard = {
    renderTop10: renderTop10,
    renderConnectedClients: renderConnectedClients,
    renderActivityFeed: renderActivityFeed,
  };

}());

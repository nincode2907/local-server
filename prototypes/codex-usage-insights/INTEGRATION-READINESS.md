# Codex Usage Insights · integration report

**Status:** Integrated additively and deployed to the local running dashboard
on 20 October 2026 with user approval. Parser version 3 and cache coverage were
verified after restart; a consistent pre-migration SQLite backup is retained.

## Mapping

| Prototype value | Production source |
| --- | --- |
| Today / Yesterday / 7 days / 30 days | Shared native range selector and GET /api/native/insights |
| Project / model / source | Shared native selectors, passed to the endpoint as full native keys |
| Hourly and daily usage | SQL grouped by usage event timestamp in UTC+7 |
| 7×24 activity heatmap | Complete hourly aggregates, including explicit activity and completeness state |
| Tokens / cost / turns | Filtered event totals, known API-equivalent price snapshots, and usage-known turns |
| Project/model distribution | Filtered SQL aggregates reconciled to the same summary |
| Session details and original KPIs | Existing overview/detail APIs and dashboard sections, retained |

The Insights section is below the original eight native KPIs. All session,
project/model tables, period view, context spikes, and details remain in place.
The existing all-history range remains available to the native dashboard; the
Insights section requests only its four supported prototype ranges.

## Data semantics and migration

The response distinguishes turns with usage, turns without usage, sessions
without usage, known zero-token events, empty buckets, incomplete periods,
unpriced events, and cache-unknown events. Cached input remains a subset of
input; reasoning remains inside output. Costs are API-equivalent estimates.

The parser now records cache-field coverage in an additive SQLite table and
uses parser version 3. On a future start, readable rollout files are replayed.
For old events without readable rollout data, cached totals and cost are
unknown; the old estimated cost is invalidated while the saved rate snapshot
remains available for safe replay. The approved local migration has run. See
[docs/USAGE-INSIGHTS.md](../../docs/USAGE-INSIGHTS.md) for the response
contract and migration impact.

## Verification

- Initial integration: npm test, 78 passed.
- Turn bucket correction: all 9 native usage tests passed, including a
  regression that first failed when one turn spanned multiple hours/days.
  The correction preserves token/cost event timestamps and assigns each
  turn to only its first matching usage bucket.
- npm run check and npm run build: passed with Node 24.21.0.
- Browser fixture covered all four ranges, all three metric modes, cache
  visibility, project/model/source filters, incomplete and missing usage,
  light/dark theme, and 390 px mobile without page-level horizontal overflow.
- Heatmap scrolled internally at 690 px content width with 23.25 px cells.
- SQLite aggregation over 40,000 isolated events completed in about 1.4 s in
  the fixture run.
- After deploying the correction, the live browser passed all 12 range/metric
  combinations and 6 project/model/source filter changes, with consistent
  turn counts across summary, charts, heatmap and breakdowns. Desktop/light
  and 390 px mobile/dark rendered without browser errors or page overflow.
  Live-data screenshots are kept privately in `.local/verification/`.

Screenshots from the integrated dashboard fixture are in
[artifacts/usage-insights/](../../artifacts/usage-insights/): desktop views
for all four ranges, a 7-day dark desktop view, and mobile views. They use
isolated synthetic fixture rows, not live Codex account data.

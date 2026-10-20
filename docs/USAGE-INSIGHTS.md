# Native Usage Insights

GET /api/native/insights returns read-only aggregates from native_events,
native_turns, and native_sessions. Its filters are range, project, source, and
model, matching the native overview filter semantics. All calendar boundaries
and bucket labels use Asia/Ho_Chi_Minh.

## Counting semantics

- A **turn** is an attributed row in native_turns in the selected range;
  the collector's unattributed sentinel is excluded. If the turn has
  usage in the selected filters, it is placed by its earliest matching usage
  event timestamp. If it has no matching usage event, its started_at places it
  in a bucket and it is counted as missing usage.
- **usage_known_turns** counts distinct selected turn IDs with one or more
  usage events. Multiple response events for one turn count once.
  Hourly/daily chart and heatmap counts come from the same scoped turns as
  the summary: a turn belongs to its earliest matching usage event bucket.
  Later events retain their own token/cost timestamps without counting the
  turn again. Distinct turn counts per event bucket must not be summed.
- **usage_unknown_turns** counts selected turns without a matching usage event.
  It is shown separately and is never treated as zero-token usage.
- **sessions_without_usage** counts sessions updated in the selected interval
  that have no matching usage event in the filtered interval. The count is
  separate from turn counts because an unavailable rollout may contain no
  parseable turn rows at all.
- **unattributed_events** counts usage records whose turn ID is the collector's
  unattributed sentinel. They contribute to input/output totals but are not
  silently converted into native turns.
- An event with zero input and output is known zero usage. A bucket with neither
  events nor turns has no activity. complete marks whether its time interval
  has ended; the current hour/day can contain observed usage and still be
  incomplete.
- total_tokens is input plus output. Cached input is a subset of input.
  Reasoning output is already within output and is not added again.
- cost_usd sums only known price snapshots; unpriced_events gives the number
  excluded. It is an API-equivalent estimate, not a subscription charge.

## Cache coverage and migration impact

Rollout records may omit cached_input_tokens. The previous parser stored those
records as zero cache, which could make historical totals look complete. The
targeted correction adds native_event_cache(event_id, cache_known) and bumps
the parser version to 3. On the next collector sync, available rollout files
are re-read into the local native-usage SQLite tables. Transcript files are
only read; they are not modified. Existing frozen pricing is retained only
when cache usage can be recalculated safely.

If an old rollout is unavailable, or its usage record still omits the cache
field, cache remains unknown. The API returns cached_input_tokens: null and
does not estimate that event's price, because its cached rate cannot be chosen
safely. Other known token totals remain available. The old native overview
cache fields now return null when their selected aggregate contains unknown
cache records.

This change was applied to the local running server on 20 October 2026 after
user approval. A consistent SQLite backup is kept under `.local/backups/`;
backup integrity and the migrated database's quick check both passed. The
additive coverage table and parser version 3 were verified after restart.
For another installation, back up the stats database before starting the new
code, which replays metadata/usage from readable rollouts on parser-version
change. No transcript, auth, or provider data migration is required.

## Response contract

The response contains summary, complete buckets, hourly_activity for 7-day
heatmaps, and filtered projects, models, and sources breakdowns. Each aggregate
exposes known input/cache splits, unknown-cache input, output/total tokens,
known priced cost, turns/coverage, unattributed events, and cache/price
completeness counts, including sessions without usage. The frontend checks summary, bucket, and filtered
breakdown reconciliation before rendering.

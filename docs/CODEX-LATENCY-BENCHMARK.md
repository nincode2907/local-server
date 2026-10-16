# Codex Local Server latency benchmark

**Date:** 2026-10-16  
**Model:** `gpt-6-luna`, reasoning `low`  
**Route:** stateless `/v1/chat/completions`, streaming enabled  
**Data:** real Codex requests; benchmark gateway used an isolated, ephemeral server and temporary SQLite directory.

## Executive findings

- The gateway's measured pre-provider work was **68 ms** in the existing real-request baseline. It is a small part of the observed **24.137 s** client duration.
- Five direct CLI/provider runs and five gateway runs with the same prompt envelope/schema had p50 totals of **26.559 s** and **31.724 s** respectively. Their ranges overlap; five samples with uncontrolled cache/provider state do not establish that the gateway adds 5.165 s.
- The provider/CLI emits `turn.completed` about **5.4–6.1 s before stdout ends**. In a post-instrumentation minimal direct run, it emitted **zero stdout events after `turn.completed`**, then stdout closed and the process exited. The gateway's current wait spans this observed tail.
- Returning a successful HTTP completion at `turn.completed` is unsafe: a deterministic fake CLI emitted that event and then exited with code 1. The provider correctly surfaced failure. Sessions, final validation, and successful accounting still depend on later completion steps.
- Both the short prompt and the 500-word response produced **one content delta**. The long response arrived as a single 4,926-byte delta, so this CLI path does not provide incremental token streaming in these runs.
- A minimal direct CLI call used **9,222 input tokens**. Equivalent direct and gateway requests used p50 **9,462** and **9,468**. The gateway envelope/schema account for only about 240–246 additional reported tokens in these comparisons; most usage remains present in a minimal call under the same gateway system instructions and policy. The provider does not expose an internal token breakdown.

## Method

`npm run benchmark:latency -- --runs=5` made five sequential paired comparisons, alternating which path ran first. Direct and gateway requests used the same user text, `gpt-6-luna`, low reasoning, generated prompt envelope, JSON output schema, CLI executable, and read-only/no-network/no-agent-tools policy. The direct path called the same provider/CLI without HTTP, gateway admission, run recording, or SSE delivery. The gateway path used HTTP and parsed its streamed response.

The script then sent one longer request asking for an approximately 500-word Vietnamese explanation. It recorded first text, end-to-end completion, actual delta count/size, provider usage and the gateway lifecycle. Cache/load state was not controlled. Percentiles use nearest rank; with five samples p95 is the maximum and is only a rough tail indicator.

The separately measured minimal direct call used the same CLI wrapper, model, reasoning, gateway system instructions and security flags, with the same short user text but without the gateway prompt envelope or output schema. It is a **one-run diagnostic**, not a percentile sample. One post-change run confirmed the same usage and completed process-close measurement; its duration was 28.616 s.

## Results

### Five short-request pairs

Times are milliseconds. Token statistics are provider-reported; cache state varied across gateway samples.

| Path | Total p50 / p95 | TTFO p50 / p95 | Input tokens p50 / p95 | Output tokens p50 / p95 | Cached input p50 / p95 | Content deltas p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct CLI/provider | 26,559 / 34,232 | 21,032 / 28,463 | 9,462 / 9,462 | 19 / 19 | 0 / 0 | 1 / 1 |
| Gateway HTTP/SSE | 31,724 / 32,092 | 25,557 / 26,344 | 9,468 / 9,468 | 19 / 19 | 0 / 8,320 | 1 / 1 |

The gateway p50 exceeds direct p50 by 5.165 s, while direct p95 is higher than gateway p95. This inconsistent quantile pattern, the small sample, and uncontrolled cache/provider state make the difference unsuitable as an estimate of gateway overhead. The existing single-call baseline measured 68 ms from gateway receipt to provider start and 24.137 s client end-to-end.

### Provider/CLI lifecycle

The new `metrics.cli_lifecycle` records monotonic timestamps for spawn, stdin, first stdout event, `turn.completed` receive/delivery, stdout iterator completion, stdout/stderr end and close, child exit/close, response observation, temporary schema cleanup and provider return. It records event counts/types after `turn.completed` without storing event bodies.

In the post-change minimal direct diagnostic:

| Boundary | Elapsed from provider start |
| --- | ---: |
| First stdout event | 6.511 s |
| `turn.completed` received / delivered | 23.206 s / 23.206 s |
| Parsed stdout events after `turn.completed` | 0 |
| Stdout iterator completed / stdout ended | 28.613 s / 28.613 s |
| Child process exited / closed | 28.615 s / 28.615 s |
| Response observer finished | 28.616 s |
| Provider returned | 28.616 s |

That run reported 9,222 input, 5 output and 0 cached tokens. The observed delay is between the final CLI event and stdout EOF. The process exits immediately after stdout closure. The measurement does not identify any internal model phase.

The initial live request independently measured 18.361 s from provider start to first public text, 177 ms from first text to `turn.completed`, and 5.381 s from `turn.completed` to CLI completion. This aligns with the new lifecycle diagnosis.

### Longer response

| Client total | Client TTFO | Text deltas | Delta bytes | Output tokens | Cached input tokens |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 38.921 s | 33.263 s | 1 | 4,926 | 1,028 | 8,320 |

The output was streamed over HTTP, but the Codex CLI supplied one public item update. The observed stream therefore has no token-by-token cadence to optimize at the gateway. Provider capabilities already describe Codex output as item updates when available and TTFT/generation duration as unavailable.

## `turn.completed` safety check

A fake CLI emitted a valid `turn.completed` with usage and then exited non-zero 160 ms later. The lifecycle instrumentation observed the usage event, but `run()` rejected, the response observer marked the result incomplete, and the test confirmed no successful provider result was returned. Existing streaming error handling then emits an error instead of a successful finish/`[DONE]`.

The CLI response observer runs after process close and before `thread.run()` resolves. The server then performs final output/tool validation, session thread/message persistence, successful run/call status, and HTTP response capture. It records usage when the CLI reports it, even if later process completion fails. Sending success at `turn.completed` would misreport that failure; moving the remaining work to the background would require a separate API contract and still could not retract a success already sent. Cancellation continues to abort the child and must await process/stdio cleanup before releasing the run's concurrency slot.

**Conclusion:** keep the current success boundary after CLI exit/stdio close, response observation, schema cleanup, final validation and session persistence. Do not send `[DONE]` at `turn.completed`.

## Optimization assessment

| Rank | Candidate | Verified latency impact | Risk | Complexity | Recommendation |
| --- | --- | ---: | --- | --- | --- |
| 1 | Remove the pre-provider gateway work | At most 68 ms in the existing request; under 0.3% of its 24.137 s total | Low | Low | Leave as is; it is not a meaningful target. |
| 2 | Return success at `turn.completed` | Could remove the observed 5.4–6.1 s tail | High: hides a later CLI failure and skips final success/session guarantees | High | Reject based on the post-turn failure probe. |
| 3 | Reduce the 9.2k-token minimal CLI baseline or provider TTFO | The request spends 18–33 s before first text in these samples; token context appears largely outside the gateway wrapper | Medium to high: changes model behavior or provider policy | Medium | Investigate with provider-supported prompt/context controls and repeated matched tests; no safe control is evidenced yet. |
| 4 | Improve perceived streaming | Long response still had one 4.9k-byte delta | Low at gateway; provider capability is the constraint | Medium | No gateway chunk-splitting: that would fake token timing. Revisit only if CLI exposes incremental public updates. |

No latency optimization is applied. The only runtime behavior change is explicit waiting for the child `close` event before observer/schema cleanup and provider return, so the lifecycle boundary is measured and cleaned up consistently.

## Validation and limits

- `npm run check`, `npm run build` and all 74 tests passed.
- The synthetic post-`turn.completed` failure test covers the unsafe success case. Existing session, cancellation, usage, stream-error, cleanup and compatibility tests all passed.
- Real benchmark used 10 matched short requests, one longer gateway request and one minimal direct diagnostic, plus one post-change direct close validation. It did not modify `.local`, Codex Usage source data or the user's running server.
- The 5+5 paired timing sample was collected immediately before adding an explicit wait for the child `close` event. A separate post-change minimal run verified `child_process_closed_ms` is present and precedes provider return; the paired p50/p95 table is therefore the pre-hardening sample.
- p95 is unstable with five samples; provider/cache state is uncontrolled. Provider usage does not expose prompt-internal attribution or model-phase timing. The benchmark cannot support claims about reasoning duration, token decode duration, or remote service phases.

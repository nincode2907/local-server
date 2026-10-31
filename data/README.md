# Model snapshot

Copied from `MySeBrain/mySeBrain/Projects/ai-model-dashboard/data` on 2026-10-02 (all five JSON files, unchanged). `models.json` is the runtime catalog; the other files retain the source snapshot and provenance.

Prices are user-provided API estimates in USD per million tokens, not measured ChatGPT Plus charges. Availability is catalog metadata, not account entitlement. The chat picker uses Codex-compatible models and reasoning levels supported by the installed SDK (the SDK does not expose `none`).

Each priced call freezes its rates, source and snapshot date in SQLite. Existing calls with usage are backfilled from this snapshot once. Unknown price/usage remains unpriced. Cached input is subtracted from normal input; if a cached rate is absent, the regular input rate is used. Reasoning tokens are already included in output. Tool fees, cache writes and context premiums are excluded.

## GPT-6.1 Terra (2026-10-30)

Thêm `gpt-6.1-terra`: thông số và giá từ trang OpenAI (`spec-gpt-6.1-terra`), reasoning Codex từ `models_cache.json` của Codex CLI 0.166.0 trên máy này (`codex-local-models-cache`, không phải nguồn công khai). Điểm Artificial Analysis lấy từ trang public với Intelligence Index v5.0, khác index 4.3 trong API v2 của các model còn lại nên không so trực tiếp; chỉ Max có slug AA đã xác minh (`aa-mapping.json`).

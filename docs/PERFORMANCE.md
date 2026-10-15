# Local providers và Performance Lab — Phase 3

[Bản trực quan](PERFORMANCE.html) · [Run/event contract](STREAMING.md).

## Bắt đầu

Dashboard → **Performance Lab** → chọn provider/model → chọn fixture, số lượt,
warmup và concurrency → **Chạy batch**. Kết quả cập nhật bằng SSE, có nút dừng,
lịch sử batch, link Request Detail và export JSON/CSV. Các lượt benchmark dùng
chính scheduler, execution service, metric và run event stream của chat API.

Local provider mặc định tắt. Bật bằng cấu hình origin phía server rồi restart:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
LM_STUDIO_BASE_URL=http://127.0.0.1:1234
LOCAL_PROVIDER_TIMEOUT_MS=180000
LM_STUDIO_API=openai
LAB_ALLOW_CODEX=false
LAB_MAX_REQUESTS_PER_DAY=200
LAB_RETENTION_DAYS=7
LAB_MIN_INTERVAL_MS=1000
```

Origin chỉ HTTP(S), không path/query/credentials. Mặc định chỉ localhost,
127.0.0.1 và [::1]; host khác cần exact `LOCAL_PROVIDER_HOSTS` (comma-separated).
Redirect bị từ chối. URL không do caller gửi. `OLLAMA_API_KEY` và
`LM_STUDIO_API_KEY` là key riêng của backend tương ứng, không lấy gateway Bearer
hoặc ChatGPT credential. Không tự tải model, khởi động daemon hay đổi bind/CORS.
Model phải có sẵn; backend có thể JIT load model khi người dùng chủ động gọi.

## Routing API

| Endpoint/field | Hành vi |
| --- | --- |
| `GET /v1/providers` | Admin/app: enabled và capability matrix, không URL/key |
| `GET /v1/models?provider=ollama` | Discovery native; không gọi inference |
| `GET /v1/models?provider=lmstudio` | Discovery LM Studio; state/quantization/context nếu có |
| `POST /v1/chat/completions` / `POST /v1/runs` | Thêm `provider: codex/ollama/lmstudio`; bỏ field giữ Codex |
| `POST /chat` | Alias JSON nhận provider/model/max_tokens/seed tùy chọn |
| `max_tokens`, `seed` | Chỉ local, 1–8192 token và seed 0–2147483647; Codex trả400 |
| `reasoning/reasoning_effort` | Chỉ Codex; local trả400 thay vì âm thầm bỏ qua |

Local phải có model tường minh; provider tắt/không có model trả400. Không fallback
sang Codex hay provider khác. Legacy sessions vẫn chỉ Codex; stateless message
history có thể do client tự gửi. `stream:false` giữ JSON; streaming/unified runs
giữ run ID, ownership, dedup, cancellation và metric provenance của Phase1–2.

```bash
curl -N http://127.0.0.1:15600/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_APP_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"ollama","model":"your-installed-model","messages":[{"role":"user","content":"Xin chào"}],"stream":true,"max_tokens":128,"seed":42}'
```

Function calls vẫn là proposals được gateway validate bằng schema/tool_choice;
chỉ phát sau khi hoàn chỉnh, không thực thi tool. Adapter chỉ nhận content công
khai, bỏ thinking/reasoning của backend khỏi event/Inspector. Truncated stream,
malformed payload, HTTP error, redirect và timeout không trở thành success.
`finish_reason:length` là inference hoàn tất tới giới hạn, được ghi riêng trong
kết quả batch. HTTP429 của backend có code `local_provider_rate_limit`.

## Khả năng và nguồn metric

| Khả năng | Codex | Ollama | LM Studio |
| --- | --- | --- | --- |
| Transport | Isolated CLI JSONL | `/api/chat` NDJSON | `/v1/chat/completions` SSE |
| Non-stream | Envelope hiện có | Native JSON | OpenAI-compatible JSON |
| TTFO | Gateway observed | Gateway observed | Gateway observed |
| TTFT | Unknown | Unknown, không cộng load+prefill để suy ra | Chỉ khi `stats.time_to_first_token` được báo |
| Generation duration | Unknown | `eval_duration` ns → ms | `stats.generation_time` s → ms nếu có |
| Output token/s | Unknown | Actual eval_count / eval_duration | `stats.tokens_per_second` hoặc count/duration thực |
| Live token count | Unknown | Không ước lượng từ chunk | Không ước lượng từ chunk |
| Final usage | Khi CLI báo | prompt_eval_count/eval_count | usage.prompt_tokens/completion_tokens |
| Cache/reasoning tokens | Khi CLI báo | Cache chỉ khi field được báo | Chỉ khi details có field tương ứng |
| Output cap / seed | Không hỗ trợ | num_predict / seed | max_tokens / seed |
| Resource inference | Cloud unavailable | Shared backend/PID nếu cấu hình | Shared backend/PID nếu cấu hình |
| Giá local | Không áp dụng | Unknown | Unknown |

LM Studio mặc định OpenAI-compatible API, không cam kết có `stats`.
`LM_STUDIO_API=v0` opt-in dùng `/api/v0/models` và `/api/v0/chat/completions`
để nhận thông tin/stats khi backend hỗ trợ. Không tự retry/fallback API version.
Rate/timing là provider_reported hoặc derived từ count/duration provider; scope
`provider_generated_may_include_reasoning`. Không khẳng định đó là visible decode
speed hay client nhận token lúc nào. Output token/end-to-end second vẫn tách riêng.

SQLite `calls.provider` là migration additive, default codex cho lịch sử cũ.
Pricing chỉ áp dụng Codex; local trùng tên model Codex vẫn null cost/rate/snapshot.
Usage thiếu cache/reasoning giữ null; summary có unknown counts. Nhóm model theo
provider+model. Tổng chi phí vẫn là tổng phần đã biết, kèm số lượt chưa tính được;
0 tổng đã biết không có nghĩa local miễn phí. Native usage tiếp tục tách riêng.

Đối chiếu contract: [Ollama chat/timing](https://docs.ollama.com/api/chat),
[Ollama model discovery](https://docs.ollama.com/api/tags),
[LM Studio Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions),
[LM Studio v0 stats](https://lmstudio.ai/docs/developer/rest/endpoints).

## Bài đo, cohort và giới hạn

Ba fixture version theo source: `short-answer`, `structured-list`, `reasoning-math`.
Không nhận prompt tùy ý vào benchmark metadata. Target 1–3 provider/model; mỗi
fixture warmup 0–3, lượt đo1–20, concurrency1–8. Mỗi target/scenario chạy warmup
trước, sau đó pool lượt đo; các target/scenario chạy lần lượt để ghi cửa sổ rõ ràng.
Global scheduler vẫn giới hạn active/queue, nên concurrency yêu cầu có thể bị
queue hoặc reject theo cấu hình thật. Warmup không nằm trong percentile/throughput.

- Tối đa120 request/batch gồm warmup, tối đa131072 requested output-token allowance.
- Output cap local8–2048; temperature local0, seed được lưu. Provider có thể không
  tái lập bit-for-bit dù cùng seed. Nếu usage thực vượt cap local, dừng các lượt còn
  lại với `provider_output_budget_exceeded`; không thể xác minh cap giữa stream
  khi backend chưa báo usage.
- Budget thời gian1–600 giây, hết thì hủy active/queued và không chạy tiếp.
- Chỉ1 batch active, khoảng cách start mặc định1 giây, daily reservation200 request
  theo UTC; reserve cả dự kiến trong transaction, không refund khi cancel.
- `Idempotency-Key` hash theo batch/spec: retry không tạo batch trùng, khác spec409.
- Codex mặc định disabled trong Lab. Muốn dùng phải bật `LAB_ALLOW_CODEX=true` và
  gửi `allow_codex:true`; giới hạn10request/60giây. Không hỗ trợ token cap/seed,
  sampling ghi provider_default_unreported. Đây là giới hạn request/time, không
  phải cam kết chi phí tài khoản. Agent không tự bật/run Codex thật để QA.

Cache/load state luôn `uncontrolled`; không unload, ép cold hoặc xác nhận warm.
Lượt đo sau warmup ghi `after_warmup_not_verified_warm`, không giả là cold/warm
đã được kiểm chứng. Template/reasoning/runtime mỗi provider có thể khác: so sánh
cùng prompt fixture không chứng minh output quality hoặc token scope bằng nhau.

Duration, TTFO, TTFT, queue và rate p50/p95 dùng nearest-rank, kèm sample_count,
unknown_count. Cohort gồm mọi lượt đo terminal, kể cả failed/cancelled/rejected,
không cherry-pick success. Success/s = completed / measured wall interval;
terminal-runs/s = admitted terminal runs / cùng interval. Interval dùng monotonic
clock từ admission đầu tới terminal cuối, gồm queue và lỗi. Reject trước admission
được đếm riêng, không tính thành completed run. Có counts failed/rejected/cancelled/
timeout/provider-rate-limit/length-limit và unstarted. Restart không suy ra interval
còn thiếu: batch interrupted giữ throughput unknown và không tự resume.

## Resources

`GET /api/resources` admin trả snapshot, interval và scope; sampler1giây,
RAM ring300 point. Gateway CPU = delta CPU microseconds / elapsed wall monotonic,
100% tương đương1core, RSS từ Node. Codex CLI child PID được đăng ký riêng khi
spawn; launcher Node và native codex child được gắn scope riêng khi nhận diện được; không lấy gateway RSS làm inference RAM.

Trên macOS/Linux, `/bin/ps` đọc tối đa64 PID bằng command có timeout750ms; một read process-tree bổ sung
nhận diện native codex child của launcher đang được gateway theo dõi,
chỉ numeric PID, không shell. Lượt ngắn hơn interval có thể không có process sample. CPU của ps là average theo process, không cùng
cửa sổ delta CPU của Node; RSS là process resident memory. PID identity được giữ
theo lstart/command, đổi identity thì ngừng dùng sample. Không expose command line.
Optional `OLLAMA_PID`/`LM_STUDIO_PID` chỉ cho backend loopback trên chính host;
operator xác minh PID rồi cấu hình, cập nhật khi daemon restart. Process này có
thể phục vụ nhiều request/model, không gán toàn bộ CPU/RSS cho một request.

Ollama `/api/ps` báo shared model size/VRAM allocation/context khi có. Đây không
phải GPU utilization hay per-request VRAM. LM Studio API không có sampler tương
ứng thì unavailable; GPU/VRAM utilization và cloud inference luôn unknown khi
không có nguồn thực. Không cài driver hoặc giả CPU/RAM/GPU bằng dữ liệu ngẫu nhiên.
[Ollama loaded-model resource fields](https://docs.ollama.com/api/ps).

## Batch API, lưu trữ và export

| Endpoint | Quyền / kết quả |
| --- | --- |
| `GET /api/lab` | Admin; fixtures, limits, provider capabilities, active batch |
| `POST /api/lab/batches` | Admin; strict spec≤8192bytes,202; browser cùng origin + JSON + X-Codex-Lab:1 |
| `GET /api/lab/batches` | Admin; tối đa100 batch gần nhất |
| `GET /api/lab/batches/:id` | Admin; cấu hình, trial metadata, summary/resources |
| `GET /api/lab/batches/:id/events` | Admin; SSE full numeric snapshot, sequence ID, reconnect |
| `POST /api/lab/batches/:id/cancel` | Admin; hủy idempotent, cùng write guard |
| `GET /api/lab/batches/:id/export?format=json/csv` | Admin; không prompt/output/headers/secrets |

SSE ID `<batch_id>:<seq>`, Last-Event-ID/cursor. Mỗi update là full metadata
snapshot, không yêu cầu replay delta cũ. Viewer disconnect không hủy batch.
Export CSV dùng quoted cells và chặn formula prefix, chứa trial rows/metric values;
JSON có cả cấu hình, scope, summary và resources. Export batch đang chạy có status
running/cancelling và dữ liệu một phần, không giả terminal. Gateway key không ở URL.

Additive STRICT tables `lab_batches`, `lab_daily`; unique active batch và hash
idempotency, quota reservation transaction. Chỉ fixture ID, provider/model,
numeric settings, run IDs, trạng thái/error code/timing/usage/resource samples;
không lưu prompt/output/tool args/credential. Benchmark runs ephemeral, Inspector
không ghi body kể cả khi global opt-in bật. Replay body bị bỏ sau terminal.
Resource history mỗi batch≤120 point (đầu+119 mới nhất), tối đa16 process/point;
truncated/sample_count công khai. Batch metadata giữ tối đa100 batch/7ngày (config
1–30ngày); purge khi startup/list/start/read/export. Daily reservation giữ31ngày.
Gateway run/call metadata theo retention hiện có, không bị xóa cùng batch.
Shutdown hủy batch và đợi cleanup; crash/restart đánh dấu interrupted, không chạy lại.

## Kiểm chứng và giới hạn runtime

`npm run check`, `npm run build`, `npm test`. `npm run preview:lab` chạy gateway
fixture15602 + backend native fixture15604, data dir riêng, không đọc .env/native
history hoặc gọi Codex executable/account. Token demo `fixture-admin`. Cả Codex,
Ollama và LM Studio trong preview đều giả lập có nhãn. Dừng terminal để dọn fixture.

Provider tests dùng HTTP native JSON/NDJSON/SSE, auth separation, malformed/truncated/
redirect/timeout/cancel/tools/length, unknown usage/timing/cost. Lab tests bao gồm
warmup, mixed failures, quota/cancel/retry, restart/retention, privacy/export và
CPU/RSS process scope. Real Codex smoke/benchmark không chạy; không phát hiện
Ollama/LM Studio đang listen tại11434/1234 lúc kiểm tra, nên chưa smoke model thật.


### Bằng chứng bàn giao ngày 15/10/2026

- Node24.21.0/npm11.19.0; gateway check/build, React package check/build,
  syntax dashboard/live/lab JS và69/69test qua (gồm regression playground hiện có).
- Chrome desktop fixture: discovery/capability matrix, chọn model, bảng so sánh,
  SSE cập nhật, cancel batch; CSV tải từ UI có11trial/1cancelled, không output.
  Responsive CSS đã có; kiểm tra mobile Phase3 chưa hoàn tất vì browser đang được
  người dùng sử dụng. Không ghi nhận mobile runtime là đã qua.
- Security/data-model review theo changed scope: xác thực/quyền Lab, fixed-origin
  fetch/redirect, keys riêng, validated proposals, null usage/cost, bounded samples,
  quota transaction/unique active/idempotency, shutdown/restart và export privacy.
- Server thật được cập nhật foreground sau guard PID/cwd và xác nhận0active/0queued,
  không active batch. Direct15600 và codex-server.localhost: health, deep-link shell,
  provider matrix, Lab/list, resources, latency và global SSE snapshot đều200;
  assets khớp hash source. Invalid batch400 không inference, foreign Origin403,
  Inspector của call cũ200. Codex Lab thực tế vẫn disabled; .env thật giữ nguyên.
- Không gọi inference/benchmark account thật, không tải model. Không có daemon
  Ollama/LM Studio ở11434/1234 để smoke model/hardware thật. Preview/fixture được dọn.

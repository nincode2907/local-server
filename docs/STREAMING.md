# Streaming, run events và Live Requests

[Bản trực quan](STREAMING.html) · [Kế hoạch 3 phase](STREAMING-OBSERVABILITY-PLAN.md).
Phase 1–3 triển khai ngày 15/10/2026. Dashboard giữ vanilla JS, không thêm frontend bundler.
Package React là tích hợp tùy chọn, cài/build riêng trong `clients/`.

## Luồng sử dụng

Dashboard → **Request trực tiếp** xem các run mới: model, trạng thái, elapsed,
TTFO, output bytes/ký tự/update, usage cuối và nút hủy. **Xem chi tiết** mở
`/dashboard/requests/:run_id` (run_id = call_id), reload được, gồm Trực tiếp,
Timeline, Output, Số liệu và Inspector. Tab Output có step chart bytes/ký tự;
token chỉ vẽ khi provider có sample count thực. Metadata và Inspector của call
cũ tiếp tục dùng API hiện có; metric mới không có dữ liệu sẽ giữ unknown. Dashboard dùng cùng event service với API.
Global dashboard feed chỉ có metadata; xem nội dung cần subscribe từng run.
Call có sẵn trước phase 1 vẫn xem metadata trong lịch sử; không backfill TTFO.

`stream: false` hoặc bỏ `stream` giữ response JSON hiện có; `/chat` và session APIs
giữ envelope cũ. Session routes chưa nhận `stream: true` và trả 400 rõ ràng.
UI Test chat gửi `stream: true` tới Playground và ghép các `chat.completion.chunk`
để hiện nội dung ngay khi gateway phát delta. UI dùng animation frame để hiển thị
nội dung nhận về dần, kể cả khi CLI chỉ trả một đoạn sau khi item hoàn tất.
Đây là hiệu ứng trình bày; không tạo thêm delta hay giả lập tốc độ sinh token.
UI ghi rõ số đoạn content nhận thật và trường hợp chỉ nhận một đoạn; hiệu ứng
tắt với reduced motion, xả ngay khi hủy hoặc trang bị ẩn. Cuộn chỉ bám theo
khi người dùng đang ở gần cuối cuộc trò chuyện. TTFO và thời lượng hiển thị trong
trang là thời gian đo ở client, không phải tốc độ token từ Codex. Conversation
chỉ nằm trong bộ nhớ trang. Playground không giữ body sau khi run hoàn tất;
subscriber Live Requests đã mở trong lúc chạy có thể nhận output trực tiếp.

## Streaming chat completions

```bash
curl -N http://127.0.0.1:15600/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Xin chào"}],"stream":true,"stream_options":{"include_usage":true}}'
```

SSE dùng `chat.completion.chunk`, stable completion ID/model/created, content
delta, tool-call index/ID, finish reason, usage cuối nếu yêu cầu và `[DONE]` khi
thành công. Header có `X-Codex-Call-Id` và `X-Codex-Run-Id` (cùng UUID).
`stream_options` yêu cầu `stream: true`. Validation/admission lỗi trước headers
trả JSON status 4xx. Sau headers, lỗi trả SSE `{error:{code,message}}`, không gửi
success finish hoặc `[DONE]`; output trước lỗi là partial, chưa được xác nhận.
Client ngắt streaming completion sẽ hủy inference, giải phóng concurrency sau cleanup.

Tool proposals chỉ được gửi sau khi output hoàn chỉnh qua validation; gateway
không thực thi function. Nếu provider sửa lại phần content đã phát, OpenAI stream
được kết thúc bằng `non_append_output`; unified stream bên dưới hỗ trợ replacement.

## Unified run API

| Endpoint | Quyền và hành vi |
| --- | --- |
| `POST /v1/runs` | Admin/app; chat payload stateless → 202, run metadata và events URL |
| `GET /v1/runs/:id` | Owner/admin; metadata snapshot, capabilities, timeline và metrics |
| `GET /v1/runs/:id/events` | Owner/admin; SSE replay rồi follow đến terminal |
| `POST /v1/runs/:id/cancel` | Owner/admin; JSON `{}`, cancellation idempotent |
| `GET /api/runs` | Admin; tối đa 128 run metadata gần nhất |
| `GET /api/runs/events` | Admin; snapshot + live metadata feed nhiều run |
| `POST /v1/runs/:id/workflow-events` | Owner/admin; báo tiến trình workflow độc lập inference |
| `GET /api/runs/latency` | Admin; cohort duration/TTFO/queue p50/p95 |

`POST /v1/runs` nhận `Idempotency-Key` tối đa 128 ký tự. Cùng owner/key/payload
đã normalize trả cùng run, kể cả sau restart; khác payload trả 409. SQLite chỉ
lưu hash của key/payload. Key được giữ cùng lịch sử metadata, không tự hết hạn.
Một run tạo đúng một call metric/cost record, không cộng usage theo số subscriber.
Mặc định vẫn trả 429 khi hết concurrency; hàng đợi FIFO là opt-in (xem bên dưới).

```bash
curl http://127.0.0.1:15600/v1/runs \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'Idempotency-Key: example-unique-task-1' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Xin chào"}]}'

curl -N "http://127.0.0.1:15600/v1/runs/$RUN_ID/events" \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

curl "http://127.0.0.1:15600/v1/runs/$RUN_ID/cancel" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' -d '{}'
```

### Event contract và reconnect

Run SSE mở bằng `event: snapshot` không có cursor: metadata tại thời điểm kết nối,
không phải output snapshot. Sau đó `event: activity` có envelope version 1:

```json
{"version":1,"run_id":"UUID","call_id":"UUID","seq":3,"type":"output.delta","timestamp":1792030000000,"elapsed_ms":1200,"source":"gateway_observed","payload":{"delta":"Xin"}}
```

Các type: `run.accepted`, `provider.started`, `output.delta`, `output.replaced`,
`usage.updated`, `provider.finished`, `run.completed`, `run.failed`, `run.cancelled`,
`run.queued`, `run.dequeued` và các workflow/stage event dưới đây. Lifecycle event
chứa metadata snapshot; output/usage event có numeric sample tăng index. Thêm field
không đổi envelope version 1. Client phải bỏ qua field không biết.
`run.completed.payload.result` là completion đã validate, gồm tool proposals và
usage nếu có; `validated: true` khi tool arguments không bị redaction thay đổi. Stream/run API
mới từ chối proposal cần redact bằng `sensitive_tool_output`; side channel của JSON
API legacy có thể ghi `validated: false` cho bản sao đã redact, không dùng bản đó
để thực thi function. Reasoning, stderr, auth headers và private context
không được forward. Public output/event completion áp dụng redaction cho secret
đã biết và pattern, nên có thể khác nội dung JSON API cũ ở vị trí đã redact.
Prefix có thể trở thành credential đã biết được giữ lại đến update tiếp theo;
redaction không bảo đảm nhận diện mọi secret người dùng tự đưa vào văn bản.

SSE `id` của run là `<run_id>:<seq>`, hỗ trợ header `Last-Event-ID` hoặc query
`cursor` (chỉ cursor, không token). Client dedup theo run/seq và xử lý
`output.replaced` bằng thay toàn bộ text. Global feed dùng `<process_epoch>:<seq>`
riêng, type `run.updated`, payload là metadata. Heartbeat mỗi 15 giây không tính output.

Replay chỉ ở RAM: tối đa 128 run, 512 event/1 MiB mỗi run, output hiện tại tối đa
1 MiB; run terminal bị evict sau tối đa 10 phút từ lúc tạo hoặc khi cần chỗ.
Global feed giữ tối đa 512 metadata event / 1 MiB. Quá giới hạn output tạo lỗi rõ ràng.
Cursor bị evict, thuộc run/process khác hoặc sau restart trả 409 `cursor_reset`;
client tải metadata lại và hiển thị mất replay. Kết nối mới không có cursor cũng
trả reset nếu phần đầu replay đã bị evict. Không ghép phần đuôi thành output hoàn chỉnh.
Ephemeral terminal chỉ trả snapshot metadata vì body bị xóa ngay khi hoàn tất.

Ngắt stream xem run chỉ bỏ subscription; inference tiếp tục cho tới explicit
cancel, timeout hoặc shutdown. Tối đa 128 SSE connection; buffer socket tối đa
2 MiB, slow subscriber bị đóng, không chặn inference. Client phải reconnect/dedup.
Restart giữ metadata nhưng đánh dấu run đang chạy thành `interrupted`, không tự
retry tác vụ hoặc khôi phục nội dung. Graceful shutdown abort và đợi job cleanup.

## Queue FIFO (opt-in)

```dotenv
MAX_CONCURRENT=2
MAX_QUEUE=0
QUEUE_TIMEOUT_MS=30000
```

`MAX_QUEUE` 0–64, mặc định 0 giữ HTTP 429 hiện tại. Bật >0 để nhận tối đa số đó
request đang chờ, ngoài số active. `POST /v1/runs` trả 202 với status `queued`;
JSON/streaming completions đợi lượt. Queue đầy trả 429 `server_busy`.
FIFO chỉ trong một process, không bền qua restart; startup đánh dấu queued/running
thành interrupted, không tự chạy lại. `Idempotency-Key` vẫn dedup trước admission.

Queue timeout 1–600000 ms tính từ enqueue: `queue_timeout` (504 ở JSON, hoặc
stream error sau headers), không gọi provider. Request timeout bắt đầu sau dequeue.
Hủy khi chờ bỏ khỏi queue và không chiếm slot; slot active giữ đến hết cleanup.
Session bị khóa từ admission, kể cả queued; timeout/cancel trước provider không
xóa session. `/health` có `active_requests`, `queued_requests`.
`queue_wait = dequeued - enqueued`; request không vào queue hoặc chưa dequeue
(cả timeout/cancel) giữ null có reason, không giả là 0.

## Workflow do ứng dụng báo cáo

Owner/admin gọi `POST /v1/runs/:id/workflow-events` với JSON strict ≤4096 bytes:

```json
{"event_id":"67c950f8-387f-4867-9cdc-402244f58bad","type":"stage.progress","stage_id":"render","progress":{"completed":1,"total":3},"message":"Đang xuất nội dung"}
```

Trình tự: `workflow.started` → `stage.started` → `stage.progress` →
`stage.completed` → `workflow.completed`. `stage_id` chỉ có trên stage event,
khớp `[a-zA-Z][a-zA-Z0-9_.-]{0,63}`. Stage start một lần; terminal không mở lại.
Các nhánh `workflow.failed/cancelled` hoặc `stage.failed/cancelled` được hỗ trợ.
Workflow completed cần mọi stage completed; stage completed có progress thì
completed = total. Progress gồm số nguyên completed 0–1e9, total 1–1e9,
completed ≤ total; cả hai không giảm; `stage.progress` bắt buộc counters.

`event_id` là UUID, dedup durable theo run: cùng ID/payload trả `duplicate:true`,
khác payload trả 409. 60 event mới/phút, 512 event/run, tối đa 32 stage;
retry trùng không chiếm quota. Giới hạn hết trả 429. Label ≤80, message ≤240 ký tự,
không nhận control/newline. Unknown fields (usage/owner/provider metrics…) trả 400.
Cross-owner trả 404, browser write giữ same-origin + JSON + `X-Codex-Run: 1`.
Playground ephemeral không nhận workflow.

Inference và workflow có lifecycle riêng. Có thể bắt đầu/tiếp tục workflow sau
`run.completed`; không thay inference status/usage. SSE event source luôn
`client_reported`. Timestamp stage là thời điểm gateway nhận báo cáo, không xác
nhận công việc thật đã chạy. Stage ID là identifier, không đưa prompt/secret vào ID.
SQLite chỉ giữ enum/counters/ID/time và hash dedup; label/message đã redact ở RAM
(max128 workflow, TTL10 phút kể từ update), bị xóa khi run RAM bị evict/restart.
Snapshot và event stream owner có thể chứa free text trong RAM; global feed chỉ
có workflow status/version/stage_count, không body/labels.

`GET /v1/runs/:id/events?follow_workflow=1` replay rồi tiếp tục tới khi **cả inference
và workflow terminal**. Workflow idle cũng tiếp tục chờ để app có thể gửi sau inference.
Default không có query giữ semantics phase 1: đóng khi inference terminal.
Viewer follow có thể mở sau body TTL/restart: snapshot `replay.available:false`,
metadata/numeric history còn, output không được dựng lại. Cursor stale vẫn trả 409;
client reload snapshot và đánh dấu output partial. Workflow events sau restart có
ring RAM riêng 512 event/1 MiB; seq tiếp tục từ SQLite. Elapsed workflow archived
được tính theo wall timestamp từ created_at, không khẳng định monotonic qua restart.
Connection follow tối đa 10 phút/lượt, client reconnect; đóng viewer không hủy run.

## Numeric history và latency cohort

Mỗi run lưu tối đa 256 numeric sample: điểm đầu + 255 mới nhất, sample_count gốc,
index/seq, elapsed_ms, cumulative bytes/ký tự và actual provider output tokens nếu có.
Không lưu event body vào SQLite. `kind:output/usage`, duplicate usage không thêm điểm.
Chart vẽ step, đoạn index thiếu không được nối; một sample usage không mô tả decode
speed. Mốc first/last output, provider finish, HTTP content và workflow nhận báo cáo
được hiển thị; không coi network batching là token generation cadence.

Inter-chunk là gap giữa public non-empty normalized updates, trước transport;
mean/p50/p95 dùng tối đa 512 gap mới nhất, kèm retained sample count và total_observed.
Dưới 2 update giữ null. p50/p95 dùng nearest-rank, không nội suy.

`GET /api/runs/latency?range=24h&provider=codex&model=MODEL&status=completed`:
range 1h/24h/7d/30d, model exact tùy chọn, provider Codex, status all/queued/running/
completed/failed/cancelled/interrupted (default completed). Cohort theo created_at;
trả summary và group provider/model, duration/TTFO/queue p50/p95 riêng, window,
known/unknown sample counts, method. Tối đa 100.000 run mới nhất; `total_runs` và
`truncated` công khai nếu bị cắt. Không trộn native usage; call cũ chưa có gateway_run
không được backfill thành sample 0. Dashboard có cùng bộ lọc và sample counts.

Codex run snapshot còn có `metrics.cli_lifecycle`, với mốc monotonic tính từ lúc
provider bắt đầu: yêu cầu spawn, process spawn, stdin finish/close, event stdout
đầu tiên, `turn.completed` nhận và được gateway xử lý, số event stdout sau mốc đó,
iterator kết thúc, stdout/stderr end/close, process exit/close, observer response,
xóa schema tạm và provider return. Đây là mốc ở ranh giới CLI/Node quan sát được;
không suy diễn thời gian inference, reasoning hay decode nội bộ. Provider local
giữ trường này null. Field mới chỉ bổ sung metadata; usage và thống kê call hiện
có không đổi.

Benchmark thật có thể chạy tuần tự bằng `npm run benchmark:latency -- --runs=5`.
Script dùng provider/CLI thật, server HTTP trên cổng OS cấp tự động và thư mục
SQLite tạm; không ghi transcript hoặc thay đổi dữ liệu `.local`. Direct comparison
dùng cùng CLI, policy, model, reasoning, prompt envelope và output schema nhưng
bỏ HTTP gateway. Báo cáo lần đo ngày 16/10/2026: [Codex latency benchmark](CODEX-LATENCY-BENCHMARK.md).

## Client dùng chung và React/Next.js

`clients/activity-client` là ESM JS + TypeScript declarations, không phụ thuộc UI.
Dashboard import đúng source này từ `/dashboard/assets/activity-client.js`.
Reducer xử lý snapshot mới + replay body cũ, dedup, replacement, workflow version,
numeric samples; transport fetch SSE, Bearer header, cursor reset/retry và AbortSignal.
Không dùng token trong URL, không persist credential trong client library.

`clients/react-activity-panel` export `AIActivityPanel`, CSS riêng, locale vi/en,
props runId/transport/callbacks, loading/error/empty, reconnect/cancel, chart/timeline/
workflow. React effect cleanup bỏ subscription; inference không tự bị cancel khi unmount.
Package build riêng, không đổi dashboard sang React. Hướng dẫn ở
[README component](../clients/react-activity-panel/README.md),
[BFF Next.js](../examples/next-activity/README.md). Ví dụ BFF mặc định deny cho tới
khi nối session + ownership DB của ứng dụng; app key không chứng minh quyền từng user.

## Metric và giới hạn provider

Mỗi metric có `value`, `unit`, `source`, `reason` khi unavailable; timeline có
UTC timestamp gốc và elapsed monotonic theo process. Không dùng chunk count làm token.

| Metric | Nguồn / định nghĩa |
| --- | --- |
| `ttfo` | Gateway nhận request → public content đầu tiên sau parsing/redaction |
| `first_content_sent` | Gateway nhận → lần đầu ghi content ra HTTP SSE completion; không chứng minh client đã nhận |
| `output_bytes/characters/updates` | Public text đã normalize/dedup; không phải token |
| `output_tokens` | Usage provider báo; Codex thường chỉ báo khi kết thúc và có thể gồm reasoning |
| `output_tokens_per_e2e_second` | Output token thực / run duration từ nhận đến completion được validate; gồm thời gian setup/reasoning |
| `ttft`, `output_tokens_per_second` | Unavailable: Codex chưa báo first-token time hoặc generation duration cùng scope |
| `duration` | Nhận request → hoàn tất/failed/cancelled run; `response_finished` đo riêng HTTP response, không áp dụng 202 ACK của async run |

`src/activity.ts` persist metadata trong bảng additive STRICT `gateway_runs`:
owner, trạng thái, ID, numeric metric/timeline/history, capabilities và idempotency hashes.
`gateway_workflows` và `gateway_workflow_events` là migration additive cho numeric
workflow state và event/payload hash dedup; không lưu label/message.
Không lưu prompt, response, tool arguments, reasoning hoặc event body vào SQLite.
Inspector opt-in vẫn có retention/redaction riêng; native usage tiếp tục tách dataset.

SDK 0.160.0 đã được chạy spike bằng executable giả, không dùng account.
`runStreamed()` phát event nhưng đường spawn thiếu `--ignore-user-config`,
`--ignore-rules`, `--ephemeral`. Vì chưa đạt policy parity, implementation giữ
CLI JSONL đã cô lập và bổ sung public item callbacks. Capability
`item_updates_when_available` không cam kết token delta: CLI có thể chỉ phát text
khi item hoàn tất. Không cắt text cuối thành chunk để giả lập tốc độ sinh.

## App keys, browser và Docker

`LOCAL_API_KEY` hiện có là admin key. `APP_API_KEYS` là JSON array `{id,key}`;
ID và key phải unique, key ít nhất 24 ký tự, khác admin key. Config giữ hash để
xác thực app; SQLite chỉ lưu owner `app:<id>`, không lưu raw key. Rotate key với
cùng ID giữ quyền sở hữu; đổi ID tạo owner khác. Không tái sử dụng ID cho app khác
nếu không muốn chuyển quyền đọc lịch sử metadata đó.

App chỉ gọi health/models, stateless chat và run API của mình; stats/native,
inspector, video và legacy sessions yêu cầu admin. Cross-owner trả 404. Khi chưa
cấu hình admin key và chỉ dùng loopback mặc định, hành vi local admin cũ được giữ.

Ví dụ cấu hình opt-in (thay key placeholder bằng secret ngẫu nhiên):

```dotenv
HOST=127.0.0.1
LOCAL_API_KEY=replace-with-a-random-admin-key
TRUSTED_HOSTS=host.docker.internal
APP_API_KEYS='[{"id":"my-app","key":"replace-with-a-long-random-application-key"}]'
```

`HOST` chỉ nhận IP hoặc `localhost`. Non-loopback, extra trusted hosts hoặc app
keys đều bắt buộc admin key. `TRUSTED_HOSTS` là exact hostname không port/wildcard;
không tự thêm địa chỉ bind vào trusted hosts. Defaults Host/Origin vẫn giữ, CORS
không mở. Docker backend gọi server-to-server không cần CORS. Next.js nên proxy
qua route backend/BFF của chính app; không đưa admin/app key vào bundle client.
Browser SSE dùng fetch + Authorization, vì EventSource native không nhận custom
Bearer header. Same-origin run POST/cancel/workflow-events cần JSON và `X-Codex-Run: 1`.

Port API vẫn 15600 theo Dev Hub. Docker Desktop trên máy này đã kiểm chứng
container → `host.docker.internal:15602` với preview bind **127.0.0.1**: health
200, thiếu key 401 và streaming hoàn chỉnh. Không cần mở bind cho topology này.
Kết quả đó không chứng minh mọi Linux bridge truy cập được host loopback.
Nếu topology khác không tới được, kiểm tra route/interface hoặc relay giới hạn
trước; chọn port qua registry, cấu hình auth và exact hosts trước non-loopback.
Không sửa proxy/Docker dùng chung chỉ để làm smoke qua.

Có [Compose smoke example](../examples/compose.gateway-client.yml), dùng image
Node đã có trên máy; `extra_hosts` dành cho môi trường cần host-gateway mapping:

```bash
export GATEWAY_API_KEY='your-application-key'
docker compose -f examples/compose.gateway-client.yml --profile tools run --rm gateway-smoke
# Opt-in: lệnh tiếp theo gọi model thật nếu URL trỏ vào gateway thật và tiêu thụ usage.
RUN_STREAMING_SMOKE=1 docker compose -f examples/compose.gateway-client.yml --profile tools run --rm gateway-smoke
```

Không tự bật cấu hình Docker hoặc thay admin key trong `.env` thật khi triển khai;
existing clients tiếp tục hoạt động với config hiện có. Restart cần thiết sau khi
đổi config/build/assets; xác định PID và active requests trước khi restart.

## Kiểm chứng và preview

`npm run check`, `npm run build`, `npm test`; fixture tests bao gồm streaming JSON
envelope, unicode/escape, dedup/replacement, tool proposals, lỗi giữa stream,
ownership, idempotency qua restart, cursor reset, cancellation, timeout,
disconnect khác nhau, RAM bounds, ephemeral cleanup và SDK/CLI policy spike.

`npm run preview:activity` mở fixture riêng ở 15602 với key demo `fixture-admin`.
Không đọc `.env`, gọi account hoặc đọc native history. Có thể dùng Test chat để
tạo thêm run giả và xem Live Requests. Dừng terminal sẽ xóa thư mục fixture.
Sau khi cài/build package React, `npm run preview:react` mở React fixture tại 15603,
BFF chỉ nối preview 15602 có marker xác nhận; không forward sang account thật.
Nút tạo run và ẩn/hiện panel cho phép kiểm tra subscription cleanup/reconnect;
run ID đó mở được trong dashboard fixture để đối chiếu cùng event stream.

Live account/token granularity của Codex chưa được smoke trong phase này;
`npm run test:live` tiếp tục cần user cho phép riêng.

Kết quả bàn giao ngày 15/10/2026: Node 24.21.0 / npm 11.19.0; type-check, build,
JS syntax và 42 tests qua. Chrome desktop/mobile đã kiểm tra list, replay/timeline
và nút hủy (hiển thị cancelled + partial), console không có lỗi JavaScript.
Docker direct và Compose smoke đều nhận health 200, thiếu key 401 và 17 SSE
chunks + `[DONE]` trên fixture. Network Compose tạm đã được dọn.
Server thật đã restart foreground sau khi xác nhận active requests = 0;
health, run list/feed, live asset, inspector cũ và proxy dashboard/SSE trả 200.
Không tạo inference trên account thật để kiểm tra; `.env` thật giữ nguyên.


### Kiểm chứng phase 2 (15/10/2026)

Bổ sung tests cho queue FIFO/full/timeout/cancel/default429, queued idempotency,
session busy và không xóa session chưa chạy, workflow ownership/spoof/transitions/
dedup/rate/privacy/restart, SSE sau inference, history/gaps/cohort/null,
deep-link/shared asset/auth, pure client reducer/SSE/reconnect/reset/chart và shutdown.
React package check/build độc lập. Browser fixture đối chiếu React + dashboard
cùng run, workflow nhận sau inference, output chart và Inspector disabled đúng trạng thái.
Không chạy test:live hoặc gọi inference trên tài khoản thật.


Validation cuối phase 2: Node24.21.0/npm11.19.0, gateway check/build, JS syntax,
54/54 tests, React package check/build và SSR render qua. Chrome desktop +390px:
deep-link reload/auth, Inspector disabled không404, chart không tràn ngang,
workflow sau inference có cùng trạng thái trên React/dashboard. Server thật đã
restart foreground với0active; direct15600 và codex-server.localhost trả200 cho
health, deep-link shell, shared/live assets, latency và global SSE snapshot.
Không đổi .env thật; queue vẫn theo cấu hình opt-in. Fixture process đã được dọn.


## Phase 3: multi-provider và Performance Lab

Provider/model routing giữ Codex mặc định; Ollama/LM Studio bật bằng origin cấu hình
server, key riêng, không fallback. Unified event source/ownership và queue dùng chung.
Metrics có TTFT/generation duration/rate khi provider thực báo; cache/reasoning local
không được suy ra0. `calls.provider` additive, local pricing unknown. Lab admin có
fixtures, warmup, budgets, cancel, SSE metadata, JSON/CSV export và scoped resources.
[Contract/cấu hình/limits Phase3](PERFORMANCE.md) · [Bản trực quan](PERFORMANCE.html).

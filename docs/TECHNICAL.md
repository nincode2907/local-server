# Tài liệu kỹ thuật — Codex Local Server

> Mô tả kiến trúc và luồng dữ liệu theo mã nguồn hiện tại. Cập nhật tài liệu khi thay đổi API, provider hoặc cấu trúc lưu trữ.

## 1. Mục tiêu

Codex Local Server là HTTP gateway viết bằng Node.js và TypeScript. Nó nhận chat request theo kiểu OpenAI, kiểm tra đầu vào, chuyển yêu cầu sang Codex CLI đã đăng nhập bằng ChatGPT, rồi đổi kết quả thành JSON tương thích.

Mặc định server chỉ lắng nghe tại `127.0.0.1:15600`. Đây không phải OpenAI API chính thức, không cần `OPENAI_API_KEY`, và không hỗ trợ toàn bộ tính năng của OpenAI API.

```text
Client → Fastify → validation/policy → Provider → Codex CLI → ChatGPT account
                      ├─────────────→ metrics SQLite
Browser → Dashboard API ────────────→ metrics SQLite
                       └────────────→ native usage collector ← ~/.codex local
```

## 2. Công nghệ

| Thành phần | Trách nhiệm |
| --- | --- |
| Node.js 22.13+ | Runtime; dùng `node:sqlite` tích hợp |
| TypeScript, ESM, NodeNext | Kiểu dữ liệu và module server |
| Fastify 5 | HTTP routes, hooks, giới hạn body, error handler |
| Zod | Xác thực request, session và query |
| Ajv | Kiểm tra function arguments theo JSON Schema |
| `@openai/codex-sdk` / Codex CLI | Giao thức JSONL và thực thi Codex |
| SQLite | Gateway metrics và native usage đã tổng hợp |
| HTML/CSS/JavaScript thuần | Dashboard; không cần frontend bundler |

`src/index.ts` đọc cấu hình, tạo provider, dựng Fastify và listen loopback. Khi nhận `SIGINT`/`SIGTERM`, app đóng server, hủy request đang chạy và đóng tài nguyên.

```text
src/index.ts
  ├─ src/config.ts   → đọc/validate biến môi trường
  ├─ src/provider.ts → chạy Codex CLI, đọc JSONL
  └─ src/server.ts   → HTTP, session, metrics và dashboard
```

## 3. Luồng xử lý chat

1. Fastify nhận request và tạo call ID cho endpoint chat được thống kê.
2. Hook kiểm tra `Host`, origin của browser, Bearer token nếu được bật và giới hạn body 1 MiB.
3. Zod xác thực messages, model, reasoning và tool definitions. Transcript được kiểm tra để mọi function call có kết quả tool tương ứng.
4. Gateway áp dụng giới hạn concurrency, timeout, session lock và `AbortController`.
5. `promptFor()` tạo hướng dẫn cho Codex. Function call là JSON đầu ra; server không thực thi function đó.
6. Provider gọi CLI bằng `child_process.spawn()` với args riêng biệt, đọc JSONL từ stdout. CLI dùng sandbox `read-only`, approval `never`, network của sandbox tắt; shell, web, apps, plugins và multi-agent bị tắt.
7. Server kiểm tra structured output và arguments, chặn event tool execution ngoài dự kiến, ghi usage rồi trả response.
8. Client disconnect hoặc timeout sẽ hủy lượt CLI. Session lỗi bị xóa khỏi gateway để tránh resume transcript có thể đã ghi dở.

```text
HTTP request
    ↓
Host/origin/auth/body checks
    ↓
Zod + transcript + tool-schema checks
    ↓
concurrency + timeout + cancellation
    ↓
Codex CLI (`exec --experimental-json`)
    ↓
JSONL events → structured response validation
    ├─ usage/status/duration → stats.sqlite
    └─ Chat Completions JSON → client
```

### Provider

`src/provider.ts` không chạy shell wrapper: nó gọi executable cùng danh sách đối số. Mặc định executable là Node hiện tại cộng với CLI từ package `@openai/codex`; `CODEX_BIN` thay executable nếu cần. Provider chỉ chuyển một whitelist biến môi trường, gồm `CODEX_HOME` và các biến runtime cần cho Windows; API keys và phần lớn caller environment không được truyền.

Sandbox giới hạn khả năng ghi và network của agent nhưng không cô lập quyền đọc khỏi dữ liệu người dùng trên máy. Gateway nên nhận prompt từ caller tin cậy và không nên được mở trực tiếp ra Internet.

## 4. API

| Method | Route | Mục đích |
| --- | --- | --- |
| `GET` | `/health` | HTTP status và active requests; không xác nhận Codex login |
| `GET` | `/v1/models` | Model mặc định và model catalog hỗ trợ Codex |
| `POST` | `/chat` | Dạng gọn `{prompt, model?, reasoning?}` |
| `POST` | `/v1/chat/completions` | Chat stateless; mỗi request tạo thread |
| `POST` | `/v1/sessions` | Tạo gateway session, chưa gọi model |
| `POST` | `/v1/sessions/:id/messages` | Gửi lượt mới vào gateway session |
| `DELETE` | `/v1/sessions/:id` | Xóa gateway session |
| `POST` | `/api/playground/chat` | Dashboard chat cùng origin; Codex chạy ephemeral |
| `GET` | `/dashboard` | Dashboard thống kê, Codex usage, playground, model catalog |
| `GET` | `/api/stats/*` | Gateway calls, overview và costs |
| `GET` | `/api/native/overview`, `/api/native/sessions/:id` | Usage từ Codex local của máy server |
| `GET` | `/api/native/notifications/settings`, `/api/native/notifications/recent` | Settings và lịch sử thông báo terminal local |
| `PUT` | `/api/native/notifications/settings` | Lưu lựa chọn thông báo, admin + same-origin marker |
| `POST` | `/api/native/notifications/test` | Gửi notification thử qua macOS, không gọi model |

Function calling được mô phỏng bằng structured output: model đề xuất `tool_calls`, server kiểm tra JSON Schema draft-07, client tự thực thi rồi gửi lại `role=tool`. Không có lệnh/hàm do caller cung cấp được gateway thực thi.

Hỗ trợ streaming opt-in cho stateless completion/run API; không hỗ trợ ảnh/audio, `n` khác 1, `temperature` khác 0, embeddings hoặc toàn bộ tham số OpenAI API.

## 5. Session và nguồn thống kê

| Loại dữ liệu | Nguồn/lưu trữ | Công dụng |
| --- | --- | --- |
| Gateway session | `DATA_DIR/sessions.json` | Messages, model/reasoning, Codex thread ID để resume qua gateway |
| Gateway calls | `DATA_DIR/stats.sqlite` | Status, endpoint, model, token, duration, error code, price snapshot |
| Native Codex session | `NATIVE_CODEX_HOME/state_5.sqlite` và `sessions/**/rollout-*.jsonl` | Tab Codex usage; metadata và usage từ Codex CLI/App cục bộ |

Đường dẫn native mặc định lần lượt là `NATIVE_CODEX_HOME`, `CODEX_HOME`, rồi `~/.codex` của tài khoản đang chạy server. Collector mở `state_5.sqlite` chỉ đọc; rollout được quét lúc khởi động và theo chu kỳ (mặc định 30 giây). Bảng `native_sessions`, `native_turns`, `native_events`, `native_files`, `native_settings` nằm trong database metrics của gateway; parser không lưu nội dung transcript.

**Mac ↔ Windows không tự đồng bộ.** Trên Windows, `~/.codex` là thư mục Codex của Windows user, không phải session local của Mac dù cùng tài khoản. Tab native usage hiển thị metadata/token, không phải lịch sử để tiếp tục hội thoại. Playground dùng `--ephemeral`; các thread này không có rollout cho native collector.

Quyền riêng tư: `sessions.json` có chứa nội dung messages để tiếp tục chat. SQLite metrics chỉ chứa metadata/usage, không chứa prompt/response. Chat playground tồn tại trong bộ nhớ tab và được gửi lại làm context mỗi lượt.

## 6. SQLite và usage

`src/metrics.ts` dùng SQLite WAL. Bảng `calls` lưu ID, endpoint, model/reasoning, session ID, start/end/duration, status HTTP, token, số tool call, error code và snapshot giá. Không lưu nội dung chat. Call còn pending/running khi process dừng sẽ được đánh dấu `interrupted` lúc khởi động lại.

Chi phí là ước lượng dựa vào `data/models.json`, không phải hóa đơn ChatGPT Plus. Giá được đóng băng theo call; usage hoặc giá thiếu được thể hiện là chưa biết, không suy đoán từ văn bản.

Native parser ưu tiên response usage record, khử trùng theo response ID và xử lý log cũ bằng delta bộ đếm tích lũy. Context spike là chỉ báo input cùng session/model tăng hơn 2 lần và đạt ít nhất 50k; nó không tự kết luận lãng phí.

Native completion notifications dùng cùng rollout parser để nhận `task_complete`/`turn_complete`, `turn_aborted` và lỗi ảnh hưởng trạng thái turn. Bảng `native_notification_settings` giữ cấu hình local; `native_notification_events` lưu terminal event theo session/turn ID để deduplicate và ghi trạng thái delivery. Mặc định tắt, chỉ xét event kết thúc sau lúc process hiện tại khởi động, không phát lại event `pending/sending` sau crash. Project exclusion so theo basename. Privacy `private` chỉ gửi project/trạng thái và xóa title đã lưu; `preview` có thể kèm title đã lọc trong notification thành công. Sender gọi `/usr/bin/osascript` bằng đối số riêng, âm thanh theo allowlist; không bypass quyền Notifications/Focus. Nếu hệ thống không nhận được lời gọi, delivery giữ mã lỗi bounded, không làm lỗi collector.

`src/video-builds.ts` tạo additive hai bảng STRICT `video_builds` và `video_stages` trong cùng database. Lưu metadata, scores, manifest version 1 và session/turn scopes; không lưu token/cost/time hoặc transcript. Đọc một SQLite snapshot để nối `native_events` / `native_turns`; ghi manifest và các stages trong transaction, kiểm tra scope không chồng nhau toàn cục. Không đặt FK vào native sessions để experiment có thể được nhập trước collector. Approved preview có cutoff `approved_at`; số liệu thiếu giữ null. Định dạng và công thức nằm ở mục Video builds trong README.

Routes `GET /api/videos`, `GET /api/videos/:id`, `GET /api/videos/sessions`, `POST /api/videos`, `POST /api/videos/import`, `PUT /api/videos/:id` phục vụ tab cùng dashboard. Ghi cần JSON + `X-Codex-Video: 1`, kiểm tra Origin nếu có và giữ các Host/Bearer checks hiện tại. Paths là chuỗi metadata, không đọc/chạy video local. Native session detail thêm `video_tags`.

## 7. Bảo mật và giới hạn

- Bind `127.0.0.1`; nhận Host localhost/loopback và allowlist chính xác `codex-server.localhost` cho route Dev Hub. Origin phải cùng origin; không bật CORS.
- `LOCAL_API_KEY` là Bearer token riêng cho gateway, không phải OpenAI API key. Dashboard shell có thể tải để nhập token; API dữ liệu/chat vẫn yêu cầu token.
- Browser đọc dashboard cùng origin. Playground POST cần origin trùng, JSON và `X-Codex-Playground: 1`.
- Body tối đa 1 MiB, mặc định tối đa 2 lượt Codex đồng thời, timeout 180 giây.
- HTTP caller không thể chọn working directory, Codex home hoặc executable.
- `read-only` hạn chế ghi, không ngăn tiến trình đọc dữ liệu người dùng. Chỉ dùng với caller đáng tin; không expose internet.
- Gateway session lưu messages trong JSON. Bảo vệ `sessions.json` như dữ liệu chat nhạy cảm.

## 8. Cấu hình

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `15600` | Cổng HTTP |
| `DEFAULT_MODEL` | `gpt-6-luna` | Model mặc định; `.env` và body request có thể ghi đè |
| `DEFAULT_REASONING_EFFORT` | `low` | Reasoning mặc định |
| `REQUEST_TIMEOUT_MS` | `180000` | Timeout một lượt |
| `MAX_CONCURRENT` | `2` | Lượt đồng thời tối đa |
| `MAX_QUEUE` | `0` | FIFO opt-in 0–64; 0 giữ 429 ngay khi đầy active |
| `QUEUE_TIMEOUT_MS` | `30000` | Chờ queue tối đa, tách request timeout sau dequeue |
| `MAX_SESSIONS` | `100` | Gateway session tối đa trong bộ nhớ |
| `SESSION_TTL_MS` | `86400000` | Hạn session không hoạt động |
| `DATA_DIR` | `.local` | `sessions.json` và thư mục database mặc định |
| `STATS_DB_PATH` | `DATA_DIR/stats.sqlite` | SQLite metrics/native usage |
| `LOCAL_API_KEY` | không đặt | Bearer token tùy chọn |
| `NATIVE_CODEX_HOME` | `CODEX_HOME` hoặc `~/.codex` | Thư mục Codex local đọc usage |
| `NATIVE_USAGE_INTERVAL_MS` | `30000` | Chu kỳ đọc; tối thiểu 5000 ms |
| `CODEX_BIN` | CLI đi cùng package | Executable CLI thay thế |

## 9. Bản đồ mã nguồn

| File | Trách nhiệm |
| --- | --- |
| `src/index.ts` | Bootstrap, listen, shutdown |
| `src/config.ts` | Parse/validate cấu hình |
| `src/server.ts` | Routes, auth, orchestration, timeout |
| `src/provider.ts` | Spawn CLI, JSONL parser, provider policy |
| `src/schema.ts` | Zod schema và transcript validation |
| `src/protocol.ts` | Prompt, structured output, tool calls, response format |
| `src/sessions.ts` | Gateway session lifecycle, atomic JSON write |
| `src/metrics.ts` | SQLite gateway metrics và cost snapshot |
| `src/native-usage.ts` | Đọc Codex state/rollout và tổng hợp usage |
| `src/video-builds.ts` | Metadata/manifest video, nối native usage, approval cutoff và so sánh |
| `src/catalog.ts` | Catalog và ước lượng chi phí |
| `src/dashboard.ts` | Phục vụ assets, dashboard APIs |
| `public/dashboard.html` | Cấu trúc UI |
| `public/dashboard.css` | Theme, layout, responsive styles |
| `public/dashboard.js` | API, biểu đồ, bảng, playground, tab navigation |
| `data/models.json` | Catalog model, giá và nguồn |
| `test/*.test.ts` | Automated tests; `scripts/smoke.ts` gọi Codex thật |

## 10. Chạy local

### AI Request Inspector

`src/inspector.ts` lưu các snapshot opt-in trong `DATA_DIR/request-inspector/*.json` (mode 0600, thư mục 0700 trên hệ thống hỗ trợ POSIX); không thêm body vào SQLite. `INSPECTOR_ENABLED=false` mặc định, retention 24h và giới hạn snapshot 8 MiB. Ghi tuần tự, atomic rename, redaction trước ghi; failures được cảnh báo chỉ bằng code, không ảnh hưởng chat response. Cleanup ở startup/read/timer; xóa có tombstone/cutoff để capture đang chạy không tái tạo body. `.tmp` tồn tại sau crash cũng được expiry cleanup. Windows ACL phụ thuộc thư mục `DATA_DIR` và tài khoản chạy server; POSIX mode không thay thế ACL.

`execute()` capture raw client body sau Zod; snapshot thứ hai capture `promptFor()` sau session/default transformations ngay trước `thread.run()`. `CliThread.run()` có callback observation ngay trước spawn, chứa gateway instructions, stdin, schema và policy, không chứa args/env/auth/stderr. Gateway response capture tại `onSend` giữ đúng HTTP envelope của `/chat`, completions và stateful session (bao gồm lỗi). CLI response chỉ giữ `agent_message` / finalResponse / actual usage / public turn.failed; private reasoning item không được serialize. Public response đã phát trước lỗi được đánh dấu partial (`complete=false`), stderr không ghi. Playground luôn bỏ qua persistence body.

API đọc/xóa mới dùng cùng Host/Origin/Bearer và no-store/CSP hiện có. DELETE cần JSON `{}` và `X-Codex-Inspector: 1`. Existing call detail API và chat response contracts không đổi. Dashboard thêm inspector trong modal, provenance labels, tab keyboard navigation, search/copy và JSON details. Usage chưa biết vẫn null; không có accounting theo message/context.

“Full Prompt” giới hạn ở gateway/CLI boundary; không thấy provider hidden instructions, CLI resumed history/compaction hoặc private reasoning. SDK observable là public JSONL output/usage trong provider CLI hiện tại. Saved gateway messages không chứng minh lịch sử internal provider hay authorship của legacy context. Redaction theo key/pattern không bảo đảm nhận diện arbitrary free-text secrets. Chi tiết cấu hình/xóa/verification và preview fixture: [README — AI Request Inspector](../README.md#ai-request-inspector).

Yêu cầu Node.js 22.13+. Trên Windows, chọn phiên bản rõ ràng trong NVM for Windows:

```powershell
nvm use 22.23.3
npm ci
Copy-Item .env.example .env
npm run build
npm start
```

Đăng nhập CLI bằng `.\node_modules\.bin\codex.cmd login` trên Windows hoặc `./node_modules/.bin/codex login` trên macOS/Linux. Dashboard ở `http://127.0.0.1:15600/dashboard`; `npm run dev` bật TypeScript watcher. `npm run test:live` gọi Codex thật và tiêu thụ hạn mức tài khoản.

`npm start` qua `scripts/start.js` chạy foreground; `npm start --silent -- -d` chạy nền và bỏ output. `npm stop` kiểm tra PID bằng `ps` rồi gửi SIGTERM trên macOS/Linux. PID được ghi khi spawn, chưa xác nhận HTTP sẵn sàng. Chi tiết runtime, lệch Node/npm và tình trạng port/proxy ở [DEVELOPMENT.md](DEVELOPMENT.md) và [bản trực quan](DEVELOPMENT.html).

## Streaming và run lifecycle

`src/activity.ts` quản lý run ownership, terminal transitions, replay RAM giới hạn,
metadata-only `gateway_runs` và metric provenance. `src/sse.ts` giới hạn buffer
subscriber; `src/stream-content.ts` đọc public content trong envelope JSON đang đến.
`src/server.ts` dùng chung execution path cho JSON, streaming completions và async
runs; detached run không gắn lifetime với socket subscribe. Shutdown abort và đợi
job cleanup. `public/live.js` dùng unified feed metadata và stream từng run.

App keys chỉ có quyền stateless inference và run của chính app; dashboard/native,
inspector, video và legacy sessions vẫn admin-only. Docker HOST/Host allowlist
là opt-in có auth; provider CLI vẫn giữ isolation flags cũ. SDK policy spike
không đạt ignore-config/rules/ephemeral parity, nên chưa thay runtime sang SDK.
API, giới hạn lưu trữ và caveat nằm tại [STREAMING.md](STREAMING.md), bản trực quan
[STREAMING.html](STREAMING.html). Không nhập output/event body vào SQLite.


Phase 2: `src/scheduler.ts` giữ FIFO bounded, slot tới hết provider cleanup;
queued session khóa từ admission, không xóa session nếu provider chưa được gọi.
`src/workflows.ts` giữ strict independent state machine, owner/admin, hash dedup,
quota 60/min +512/run +32 stages. Workflow text chỉ RAM có redaction/TTL;
SQLite mới chỉ numeric state, identifier và hash. Numeric history 256/run và
inter-chunk gaps512; lifecycle snapshots copy history để không mutate replay cũ.
`/api/runs/latency` tổng hợp bounded cohorts theo metadata, không động vào native DB.
Deep link dashboard `/dashboard/requests/:id` giữ auth ở API; shared ESM client
trong `clients/activity-client` dùng cả vanilla và optional React package.
Next BFF example mặc định deny, yêu cầu tích hợp user/run ownership phía app.


## Local providers và Performance Lab

`provider-registry.ts` chọn Codex mặc định hoặc adapter local đã cấu hình, không
fallback. `local-endpoint.ts` giới hạn origins/hosts và `local-provider.ts` đọc
JSON/NDJSON/SSE có bounds, abort/timeout/redirect checks, dùng key riêng. Native
content được chuẩn hóa về envelope hiện tại để giữ tool/transcript validation;
reasoning không forward. `provider-types.ts` định nghĩa usage nullable/timing/capability.
`calls.provider` migration additive (schema version3), price chỉ cho Codex;
model aggregation theo provider+model, cache/reasoning unknown có counts.

`performance-lab.ts` gọi cùng execution service, không tự tạo provider path thứ hai.
Lab admin-only, browser JSON+X-Codex-Lab cùng origin, strict bounds. SQLite STRICT
lab_batches/lab_daily, unique active batch/idempotency và quota reservation atomic.
Metadata không chứa prompt/output, benchmark run ephemeral. Crash không resume;
retention100batch/7ngày mặc định, read/start/startup purge; resource numeric snapshots
bounded120point/16process. `resources.ts` lấy Node delta CPU/RSS, OS ps cho child/
configured local PID, không gán shared process/GPU cho từng request. Dashboard
lab.js dùng shared SSE transport; CLI policy và native read-only collector giữ nguyên.
API, so sánh metric, limits và verification: [PERFORMANCE.md](PERFORMANCE.md).

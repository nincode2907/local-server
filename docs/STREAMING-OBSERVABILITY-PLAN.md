# Streaming và Observability — kế hoạch 3 phase

Ngày lập: 15/10/2026. Phase 1 đã triển khai và kiểm chứng bằng fixtures, Docker
container và UI; chưa chạy tài khoản Codex thật. Phase 2–3 đã triển khai; các capability/runtime limits ghi trong tài liệu tương ứng.
API và giới hạn thực tế: [STREAMING.md](STREAMING.md).

Quyết định phase 1: SDK runStreamed policy spike dùng executable giả xác nhận
thiếu ignore-user-config/rules/ephemeral flags; giữ isolated CLI JSONL adapter.
Docker Desktop đã kết nối được listener loopback bằng host.docker.internal;
không cần đổi bind. HOST/extra Host/app keys chỉ bật qua cấu hình opt-in có auth.
Validation cuối và các giới hạn được ghi trong STREAMING.md.

## Mục tiêu và hiện trạng

Theo dõi request từ lúc nhận đến lúc hoàn tất; cung cấp streaming tương thích
OpenAI, event stream dùng chung cho dashboard và ứng dụng bên ngoài, rồi mở rộng
sang inference local và benchmark. Mỗi phase phải chạy độc lập sau khi hoàn thành
và dùng tiếp contract của phase trước.

Hiện trạng ghi nhận khi lập kế hoạch, trước khi triển khai phase 1:

- `src/provider.ts`: chạy CLI trực tiếp với ChatGPT auth, environment whitelist,
  read-only, tắt tools/network; hiện chỉ gom agent message khi `item.completed`.
- SDK đang cài có `runStreamed()`, `item.started/updated/completed`,
  `turn.completed.usage`; type event không bảo đảm mọi provider phát token delta.
- `src/schema.ts`: chỉ nhận `stream: false`; `src/server.ts` trả JSON sau khi xong.
- Server hiện trả 429 khi hết concurrency; chưa có hàng đợi.
- Dashboard dùng vanilla JS, không có frontend bundler; chỉ có p95 duration.
- SQLite lưu metadata/usage; inspector body opt-in lưu riêng; playground ephemeral.
- Bind `127.0.0.1`, exact Host allowlist và Origin/Bearer checks đang được áp dụng.
- Dev Hub đăng ký API 15600, block 15600–15699, `codex-server.localhost`.

## Quy ước metric dùng xuyên suốt

Mọi metric có tên, đơn vị, nguồn (`gateway_observed`, `provider_reported`,
`derived`, `unavailable`), điểm bắt đầu/kết thúc và lý do thiếu dữ liệu.
Nguồn dữ liệu và cách tính là hai thuộc tính riêng: giá trị derived vẫn ghi
provider/timestamp gốc. Không biến unknown thành 0, không đếm chunk thành token.

| Metric | Định nghĩa và điều kiện | Phase |
| --- | --- | --- |
| TTFO quan sát | Từ gateway nhận request đến public assistant content đầu tiên quan sát được; bỏ heartbeat, role-only, reasoning và workflow event | 1 |
| Thời gian tới output gửi client | Từ nhận request đến content đầu tiên ghi ra SSE; đo riêng TTFO provider adapter, không khẳng định client đã nhận | 1 |
| TTFT provider | Chỉ hiển thị khi provider thật sự báo thời điểm/token đầu; event SDK đầu tiên không đủ để suy ra | 1 contract; 3 mở rộng |
| Output tokens/sec | Provider báo trực tiếp hoặc output token count thực / generation duration thực cùng scope; thiếu duration thì unavailable | 1 contract; 3 mở rộng |
| Output tokens / end-to-end second | Output token thực / thời gian end-to-end, nhãn riêng; không gọi là tốc độ decode | 1 |
| Live output | Bytes/ký tự, số update và thời gian từ output cuối; token chỉ cập nhật khi nguồn thật sự báo | 1 |
| Inter-chunk latency | Khoảng cách giữa các public content update sau chuẩn hóa, đo trước transport batching; dưới 2 update thì unavailable | 2 |
| p50/p95 latency | End-to-end duration và TTFO tách riêng; hiển thị sample count, filter, window và tập trạng thái được tính | 2 |
| Queue wait | `dequeued - enqueued`; phân biệt admission/setup với chờ queue; không áp dụng cho request chưa vào queue | 2 |
| Throughput | Completed requests / thời gian cửa sổ, kèm successful requests/sec, active/rejected/error và concurrency | 3 |
| CPU/RAM/GPU | Gắn host/process/provider và khả năng đo; cloud Codex không có số liệu tài nguyên inference local | 3 |

Timestamp lưu UTC; tính elapsed bằng monotonic clock trong một process. Public
timeline có mốc nhận, enqueue/dequeue nếu có, provider start, first/last output,
provider finish và response finish. Không trộn gateway duration với native usage.
Provider output token có thể gồm reasoning: chỉ ghi visible-output tokens/sec khi
có count cùng scope; không phân bổ token suy diễn theo độ dài text.

## Phase 1 — Nền tảng streaming, Live Requests và Docker (P0)

**Kết quả:** ứng dụng gọi được streaming, dashboard nhìn thấy request đang chạy,
TTFO và output progress có nguồn rõ ràng; container có một cách kết nối đã kiểm chứng.

### 1. Provider event interface và kiểm chứng khả năng streaming

- Bổ sung capability theo provider: public content updates, cumulative/delta,
  live token usage, final usage, provider timing, tool proposals, cancellation.
- Thực hiện spike với SDK `runStreamed()` qua adapter, đối chiếu tất cả policy
  hiện tại trước khi thay đường thực thi. Chỉ chuyển SDK nếu giữ được ChatGPT auth,
  ignore user config/rules, instructions, tools/network disabled và read-only.
  Nếu chưa đạt parity, triển khai event iterator trên CLI hiện tại và ghi rõ lý do;
  không tự bỏ policy để đạt yêu cầu dùng SDK.
- Chuẩn hóa cumulative updates bằng item ID/version; deduplicate; có cách biểu diễn
  replacement khi text sửa lại, không giả định mọi update chỉ append.
- Chỉ forward public assistant content, safe lifecycle và usage; reasoning,
  stderr, credentials và internal context không đi vào event bus.
- Structured JSON hiện tại cần parser incremental có giới hạn để lấy content;
  tool arguments/proposals chỉ phát khi hoàn chỉnh và hợp lệ. Không phát raw JSON
  schema làm nội dung chat. Nếu event chỉ có output cuối, công bố capability đó;
  không chia nhỏ kết quả cuối để giả lập tốc độ sinh.
- Abort ngay khi thấy unexpected agent tool. Kết quả partial trước lỗi được đánh
  dấu partial/failed; client không coi đó là completion hợp lệ. Final schema và
  transcript validation tiếp tục là điều kiện để success và lưu session.

### 2. Run lifecycle và unified event stream

Contract version 1, finalize schema trong phase này:

| Endpoint | Hành vi |
| --- | --- |
| `POST /v1/runs` | Nhận chat request stateless, trả 202 với `run_id`, `call_id`, status và events URL; hỗ trợ idempotency key theo owner |
| `GET /v1/runs/:id` | Snapshot trạng thái, capabilities và metadata metric theo quyền sở hữu |
| `GET /v1/runs/:id/events` | SSE cho một run; hỗ trợ `Last-Event-ID` và cursor |
| `POST /v1/runs/:id/cancel` | Cancel idempotent; owner hoặc admin được phép |
| `GET /api/runs/events` | Dashboard admin: lifecycle/metric của nhiều run; không broadcast body mọi request |

Envelope: `version`, `run_id`, `call_id`, `seq`, `type`, `timestamp`,
`elapsed_ms`, `source`, `payload`; sequence tăng trong run, mỗi stream có cursor
rõ scope. Dashboard feed có cursor riêng, không giả định seq của run là toàn cục.

Events: `run.accepted`, `provider.started`, `output.delta`, `output.replaced`,
`usage.updated`, `run.completed`, `run.failed`, `run.cancelled`; heartbeat không
phải output. Chỉ có một terminal transition, cleanup concurrency/session lock đúng
một lần. Hai run entry points và completions dùng chung execution service.

Replay buffer bị chặn bởi TTL, bytes và số event; output body chỉ ở RAM theo mặc
định. Sau cursor hết hạn hoặc restart, trả trạng thái/cursor reset rõ ràng,
không giả vờ replay đầy đủ. SQLite giữ lifecycle/metric và mốc interrupted sau
restart; snapshot nội dung đầy đủ cần inspector opt-in với retention riêng.
Slow subscriber có buffer giới hạn; không làm nghẽn provider hoặc tăng RAM vô hạn.

Disconnect của stream xem `/v1/runs/:id/events` chỉ bỏ subscription, không cancel
run. Streaming completions gắn request thì disconnect hủy execution. Timeout,
explicit cancel, shutdown và provider error có terminal semantics riêng.

### 3. Streaming API tương thích

- `/v1/chat/completions`: nhận `stream: true`, trả `text/event-stream`,
  `chat.completion.chunk`, stable completion ID, role/content/tool deltas đúng
  contract, finish reason, `[DONE]`; usage cuối theo `stream_options.include_usage`.
- Giữ response của `stream: false`, `/chat` và session APIs đang có. Giai đoạn đầu
  không tự bật stream cho session routes; reject option chưa hỗ trợ rõ ràng.
- Lỗi trước headers dùng JSON status; lỗi sau headers có stream error và đánh dấu
  incomplete, không gửi success finish. Flush headers, backpressure, anti-buffering
  proxy và đóng socket đều được xử lý.
- Theo dõi `call_id`/`run_id` dùng chung, không ghi hai bản usage/cost cho một call.

### 4. Ownership, Docker và browser integration

- Bổ sung identity ứng dụng: API key theo client, lưu hash/identifier an toàn,
  owner gắn run phía server từ credential. Không tin `owner_id` client tự gửi.
  Key legacy có vai trò admin rõ ràng; app key chỉ xem/cancel run của chính mình.
- SSE client JavaScript dùng `fetch` streaming để gửi Authorization; không đặt
  token trong URL. App Next.js gọi qua backend/BFF của chính app, giữ key server-side.
- User đã yêu cầu ngoại lệ Docker: thêm `HOST`, mặc định `127.0.0.1`, và exact
  configured Host allowlist opt-in cho `host.docker.internal` khi topology cần.
  Hostname được phép không làm socket loopback tự truy cập được từ container.
- Trước tiên thử đường container → host với bind hiện tại. Nếu không tới được,
  chọn bind interface cụ thể hoặc relay/proxy giới hạn theo topology thực tế;
  cấu hình non-loopback bắt buộc Bearer auth và allowlist cụ thể. Không mặc định
  `0.0.0.0`, wildcard Host hay mở CORS toàn cục. Không đổi capabilities của Codex.
- Request server-to-server không cần CORS; giữ same-origin protection cho browser.
  Cập nhật AGENTS/docs để mô tả chính xác ngoại lệ opt-in đã được user yêu cầu.
- Kiểm tra registry trước khi chọn port relay/test; không tự đổi cấu hình Dev Hub
  hoặc Docker dùng chung. Lưu Compose/curl example cho topology đã kiểm chứng.

### 5. Dashboard tối thiểu

Live Requests dùng chính event bus/API: trạng thái, model/provider, elapsed,
TTFO, output bytes/ký tự, last-output age, token count thực nếu có, cancel và
timeline các mốc chính. Giữ vanilla JS. Nội dung live chỉ xem trong run được phép;
playground không lưu body sau refresh/restart.

**Điều kiện hoàn thành phase 1:**

- JSON cũ và streaming mới cùng chạy; fixture chứng minh first output, lỗi giữa
  stream, cancellation, cumulative updates, replay/dedup và backpressure.
- Client A không đọc/cancel run của B; credential không xuất hiện trong URL/log.
- Dashboard nhận update trực tiếp, metric unknown hiển thị đúng lý do.
- Container thực gọi health/auth và streaming qua đường được ghi nhận; verify
  negative cases của Host/Bearer/Origin, không dùng đổi bind để lách policy provider.
- `check`, `build`, relevant tests, UI inspection qua; restart build/assets có
  kiểm soát và kiểm tra route sau restart để tránh source/dist lệch như lỗi 404 trước.
- Runtime spike gọi tài khoản thật chỉ chạy khi được user cho phép; nếu chưa có
  phép, ghi rõ giới hạn kiểm chứng provider và không tuyên bố token streaming đã đạt.

## Phase 2 — Request Detail, workflow và UI tái sử dụng (P1)

**Trạng thái:** đã triển khai ngày 15/10/2026. Numeric sample 256/run, gap512;
queue opt-in, workflow strict + metadata-only SQLite, shared ESM client và React
package/BFF example. API/giới hạn/validation tại STREAMING.md. Không gọi account thật.

**Phụ thuộc:** contract run/event/owner/capability của phase 1 đã ổn định.
**Kết quả:** phân tích được request chậm và tích hợp tiến trình nhiều bước vào app.

1. Request Detail có URL sâu theo `run_id`/`call_id`, mở được khi reload;
   Live, Timeline, Output, Metrics, Inspector. Giữ liên kết call cũ, metadata và
   snapshot inspector. Không cho route mới bỏ qua ownership/auth.
2. Biểu đồ cumulative output bytes/ký tự theo thời gian; token series chỉ khi có
   sample count thật. Hiển thị first/last output, gaps, provider finish, client
   flush và phase workflow; phân biệt sparse output với network batching.
3. Tổng hợp inter-chunk latency, p50/p95 end-to-end và TTFO, phân nhóm provider/model,
   khoảng thời gian, status và sample count. Lưu time bucket/metric samples giới hạn
   dung lượng; không đưa raw content vào SQLite. Call cũ giữ null cho metric mới.
4. Thêm queue FIFO có giới hạn, queue timeout và cancellation khi đang chờ;
   opt-in, giữ chế độ 429 hiện tại mặc định. Queue wait được đo thật; đếm concurrency
   khi dequeue, chặn race session busy và không để retry/idempotency tạo run trùng.
5. `POST /v1/runs/:id/workflow-events`: owner/admin xác thực; schema stage ID,
   event ID/idempotency key, status, bounded counters/progress và message an toàn.
   Rate/size limits, dedup và validate thứ tự chuyển trạng thái; app không được
   giả mạo provider usage hoặc sửa lifecycle inference.
6. Workflow có vòng đời tách inference: inference có thể xong trước các bước app;
   workflow terminal không bị event muộn mở lại. Progress ngoài được gắn nhãn
   `client_reported`, không khẳng định đã thực thi tool. Stage/label/redaction và
   retention có giới hạn, không nhận arbitrary prompt/secret vào metadata.
7. Tạo `AIActivityPanel` trong package/example React/Next.js riêng cùng client
   TypeScript không phụ thuộc UI. Props cho run ID, transport/auth proxy, callbacks;
   hỗ trợ reconnect, cancel, loading/error/empty, keyboard, reduced motion và
   localization. Dashboard vanilla dùng cùng client/event schema, không đổi toàn
   dashboard sang React. Panel không chứa gateway admin key trong browser bundle.

**Điều kiện hoàn thành phase 2:** reload/deep link/reconnect đúng; chart không mất
hoặc đếm đôi điểm; sparse sample và null không thành 0; queue timeout/cancel/race
có test; workflow cross-owner/spoof/replay bị chặn; React example và dashboard
hiển thị cùng trạng thái cho cùng event fixtures; UI desktop/mobile được kiểm tra.

## Phase 3 — Local adapters và Performance Lab (P1 adapters, P2 capacity/resources)

**Trạng thái:** triển khai ngày15/10/2026. Provider registry, native Ollama NDJSON/
LM Studio SSE (+v0 opt-in), numeric timing/usage, bounded Lab dùng chung execution,
resource sampler Node/ps và model allocation khi có. Codex Lab default disabled;
không auto model download, không smoke account thật. Contract và bằng chứng:
[PERFORMANCE.md](PERFORMANCE.md). Không có local daemon ở11434/1234 lúc kiểm tra,
nên chưa kiểm chứng model/hardware inference thật; GPU utilization vẫn unavailable.

**Phụ thuộc:** phase 1–2; dùng lại execution service, event stream và metric schema.
**Kết quả:** so sánh Codex, Ollama và LM Studio trên metric có cùng định nghĩa.

1. Provider registry/capability matrix và adapter Ollama/LM Studio: model discovery,
   non-stream/stream, cancellation, errors, final usage và timing nếu được báo.
   Normalize NDJSON/SSE theo API thực tế; không giả định mọi OpenAI-compatible
   server có cùng usage/timing. Provider endpoints cấu hình phía server với
   allowlist, timeout và xác minh redirect; không nhận arbitrary URL từ caller.
2. Codex giữ riêng auth/policy/default; local adapter dùng cấu hình riêng.
   Routing provider/model tường minh; không fallback sang provider khác âm thầm,
   không truyền ChatGPT credential sang Ollama/LM Studio. Cost local chưa biết giữ
   unknown; không đồng nhất giá API tham khảo với chi phí local hay hóa đơn Codex.
3. Performance Lab có scenario, provider/model, prompt fixture, output limit nếu
   hỗ trợ, concurrency, số lượt, warmup và cold/warm labeling. Tài nguyên model,
   sampling/options và cache state được ghi hoặc đánh dấu unknown.
4. Báo TTFO/TTFT theo nguồn, rate theo scope, p50/p95, completion/success throughput,
   reject/error/timeout, queue wait; so sánh theo cùng dataset, cấu hình và window.
   Xử lý lượt fail và warmup rõ ràng, không chỉ chọn success để che lỗi.
5. Resource sampling theo OS/provider capability: CPU/RAM gateway và CLI riêng;
   inference process local riêng nếu nhận diện được; GPU/VRAM chỉ khi backend/OS
   cho phép. Gắn nguồn/máy/phạm vi/sample interval; shared GPU không gán toàn bộ
   usage cho một request. Codex cloud hiển thị inference resources unavailable.
6. Budget/rate/concurrency giới hạn, start/stop benchmark có quyền, cancellation
   toàn batch, retention và export JSON/CSV đã loại body/secret mặc định. Không tự
   tải model, cài driver hay chạy benchmark Codex tiêu thụ account khi chưa cho phép.

**Điều kiện hoàn thành phase 3:** fixtures cho cả ba adapter; local runtime smoke
với model có sẵn khi khả dụng; benchmark lặp lại được; metric so sánh cùng scope;
hardware thiếu hỗ trợ hiển thị unavailable; Codex smoke/benchmark thật chỉ khi
được phép, report rõ phần thực tế đã kiểm chứng.

## Cách gọi triển khai và quy tắc bàn giao

- `Implement phase 1 theo docs/STREAMING-OBSERVABILITY-PLAN.md`.
- Sau khi phase 1 hoàn thành: `Implement phase 2 theo plan`.
- Sau khi phase 2 hoàn thành: `Implement phase 3 theo plan`.

Mỗi lần triển khai đọc Git state và runtime hiện tại; không dựa vào trạng thái
đã ghi của phiên trước. Hoàn thành phase được gọi, cập nhật trạng thái/decisions
trong tài liệu này và canonical README/TECHNICAL/DEVELOPMENT cùng HTML companion
bị ảnh hưởng. Bàn giao API/examples, migrations additive, validation evidence và
capability chưa có. Không tự triển khai phase tiếp theo.

## Nguồn đối chiếu

- Source và type SDK cài tại repo là bằng chứng về implementation/version hiện tại.
- [Codex SDK](https://developers.openai.com/codex/sdk/): đối chiếu streaming API
  với phiên bản SDK đang cài khi triển khai phase 1.
- [Ollama streaming](https://docs.ollama.com/api/streaming): NDJSON streaming.
- [LM Studio chat completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions):
  OpenAI-compatible chat endpoint và streaming.
- Đọc lại tài liệu provider đúng version trong phase triển khai; tài liệu online
  không thay thế security parity checks hay runtime capability evidence.

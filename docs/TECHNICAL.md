# Tài liệu kỹ thuật — Codex Local Server

> Mô tả kiến trúc và luồng dữ liệu theo mã nguồn hiện tại. Cập nhật tài liệu khi thay đổi API, provider hoặc cấu trúc lưu trữ.

## 1. Mục tiêu

Codex Local Server là HTTP gateway viết bằng Node.js và TypeScript. Nó nhận chat request theo kiểu OpenAI, kiểm tra đầu vào, chuyển yêu cầu sang Codex CLI đã đăng nhập bằng ChatGPT, rồi đổi kết quả thành JSON tương thích.

Mặc định server chỉ lắng nghe tại `127.0.0.1:15600`. Đây không phải OpenAI API chính thức, không cần `OPENAI_API_KEY`, và không hỗ trợ toàn bộ tính năng của OpenAI API.

```text
Client → Fastify → validation/policy → Provider ──stdio JSON-RPC──→ codex app-server (0.165.0, thường trú)
                      │                  └─ warm thread pool (stateless)        │ HTTPS_PROXY
                      │                                                         ↓
                      │                             egress forwarder 127.0.0.1 (CONNECT, chatgpt.com:443, IPv4)
                      │                                                         ↓
                      │                                              chatgpt.com (ChatGPT account)
                      ├─────────────→ metrics SQLite
Browser → Dashboard API ────────────→ metrics SQLite
                       └────────────→ native usage collector ← ~/.codex local
```

## 2. Công nghệ

| Thành phần | Trách nhiệm |
| --- | --- |
| Node.js 24 (`.nvmrc`; tối thiểu 22.13) | Runtime; dùng `node:sqlite` tích hợp |
| TypeScript, ESM, NodeNext | Kiểu dữ liệu và module server |
| Fastify 5 | HTTP routes, hooks, giới hạn body, error handler |
| Zod | Xác thực request, session và query |
| Ajv | Kiểm tra function arguments theo JSON Schema |
| `@openai/codex-sdk` / Codex CLI 0.165.0 (pin chính xác) | Kiểu dữ liệu, native binary app-server JSON-RPC qua stdio; adapter exec tùy chọn |
| `node:net`, `node:dns` | Egress forwarder CONNECT loopback cho Codex (`src/egress-forwarder.ts`) |
| SQLite | Gateway metrics và native usage đã tổng hợp |
| HTML/CSS/JavaScript thuần | Dashboard; không cần frontend bundler |

`src/index.ts` đọc cấu hình, tạo provider, dựng Fastify và listen loopback. Khi nhận `SIGINT`/`SIGTERM`, app đóng server, hủy request đang chạy và đóng tài nguyên.

```text
src/index.ts
  ├─ src/config.ts   → đọc/validate biến môi trường
  ├─ src/provider.ts → chọn transport; adapter exec tương thích
  ├─ src/app-server-provider.ts → process thường trú, RPC, delta, warm thread, cắt prompt
  │    └─ src/egress-forwarder.ts → CONNECT forwarder loopback cho egress của Codex
  └─ src/server.ts   → HTTP, session, metrics và dashboard
```

## 3. Luồng xử lý chat

1. Fastify nhận request và tạo call ID cho endpoint chat được thống kê.
2. Hook kiểm tra `Host`, origin của browser, Bearer token nếu được bật và giới hạn body 1 MiB.
3. Zod xác thực messages, model, reasoning và tool definitions. Transcript được kiểm tra để mọi function call có kết quả tool tương ứng.
4. Gateway áp dụng giới hạn concurrency, timeout, session lock và `AbortController`.
5. `promptFor()` tạo hướng dẫn cho Codex. Function call là JSON đầu ra; server không thực thi function đó.
6. Provider mặc định tái sử dụng process `codex app-server --listen stdio://`. Request stateless lấy một warm thread đã revert về rỗng nếu có, nếu không thì `thread/start`; session dùng `thread/resume`; rồi `turn/start`. JSON-RPC và notifications đi qua stdin/stdout; mọi kết nối mạng của Codex đi qua egress forwarder loopback của gateway. Sandbox `read-only`, approval `never`, network của sandbox tắt; shell, web, apps, plugins và multi-agent bị tắt (web search chỉ mở cho request opt-in khi owner bật `CODEX_WEB_SEARCH`, xem mục Web search theo request); khối prompt không cấp năng lực bị cắt khi `CODEX_TRIM_PROMPT=true`. `CODEX_TRANSPORT=exec` chọn adapter spawn từng lượt.
7. Server kiểm tra structured output và arguments, chặn event tool execution ngoài dự kiến, ghi usage rồi trả response.
8. Client disconnect hoặc timeout gửi `turn/interrupt` cho đúng thread/turn và đợi terminal event. Nếu không dừng trong 5 giây, process dùng chung bị chấm dứt để tránh tiếp tục inference sau hủy; các lượt cùng process cũng lỗi. Session lỗi bị xóa khỏi gateway để tránh resume transcript có thể đã ghi dở.

```text
HTTP request
    ↓
Host/origin/auth/body checks
    ↓
Zod + transcript + tool-schema checks
    ↓
concurrency + timeout + cancellation
    ↓
Codex app-server thường trú
  (warm thread rỗng hoặc `thread/start` / `thread/resume` → `turn/start`)
    ↓  egress: Codex → 127.0.0.1 forwarder → chatgpt.com:443
agentMessage delta → public content SSE → structured response validation
    ↓  (stateless) `thread/revert` → `thread/turns/list` = 0 → trả về pool
    ├─ usage/status/duration → stats.sqlite
    └─ Chat Completions JSON → client
```

### Provider

`src/provider.ts` chọn transport; `src/app-server-provider.ts` gọi native binary từ package Codex đã pin, không qua shell/Node launcher. `CODEX_BIN` có thể thay native executable hoặc Node script (.js/.mjs/.cjs) trong chế độ app-server. Provider chỉ chuyển whitelist environment; API keys, proxy endpoints của caller/người dùng và phần lớn caller environment không được truyền. Ngoại lệ duy nhất: `HTTPS_PROXY`/`NO_PROXY` trỏ tới egress forwarder loopback do gateway sở hữu (xem dưới).

App-server 0.165.0 chưa có cờ ignore-config/rules của exec. Gateway dùng `DATA_DIR/codex-app-server` làm Codex home riêng, cwd tạm `codex-gateway-*`, không nạp config/rules/instruction của home cá nhân. Nếu có config, rules, hooks, skills tùy chỉnh, plugins hoặc environments trong home riêng, startup bị từ chối. Chỉ cho phép `skills/.system` do Codex tự tạo. 0.165.0 không có khóa tắt hẳn tính năng skills; khi `CODEX_TRIM_PROMPT=true`, `skills.include_instructions=false` giữ danh sách skill (kể cả `~/.agents/skills` cá nhân) khỏi prompt. Thread admission kiểm tra sandbox/network/approval và instructionSources trước khi gọi inference; turn ghi đè readOnly/networkAccess=false.

### Cắt prompt (`CODEX_TRIM_PROMPT`)

Gateway không thực thi tool, nên các khối prompt cấp năng lực cho agent chỉ là token đầu vào thừa. Khi `CODEX_TRIM_PROMPT=true` (mặc định), app-server được spawn với các khóa `-c` sau (lặp lại trong `config` của `thread/start`, nên thread mới và warm thread tái dùng sau `thread/revert` dùng cùng chính sách): `skills.include_instructions=false`, `include_permissions_instructions=false`, `include_apps_instructions=false`, `include_collaboration_mode_instructions=false`, `include_environment_context=false`, `features.sleep_tool/goals/image_generation=false`, `features.multi_agent_v2.{enabled=false,disable_native_tools=true}` cùng hint rỗng. Không khóa nào cấp thêm quyền; sandbox/approval/network giữ nguyên. Hai khóa cũ `features.skills` và `features.environments` bị 0.165.0 báo "unrecognized" nên đã xóa; test native kiểm tra mọi khóa không gây cảnh báo này.

Ngoài ra provider dựng `DATA_DIR/codex-app-server/gateway-model-catalog.json` từ `models_cache.json` của chính home app-server (chỉ mảng `models`; `tool_mode=direct`, bỏ `multi_agent_version`, `experimental_supported_tools=[]`, `apply_patch_tool_type=null`) và truyền `model_catalog_json`. Đây là cách duy nhất bỏ tool `exec` (~14k ký tự) của `code_mode_only`. Cache thiếu, hỏng, quá 8 MiB, cũ hơn 7 ngày, có thời điểm ở tương lai hoặc model thiếu `slug` → không dùng catalog. Hệ quả: khi có catalog, app-server không tự làm mới danh sách model đến lần spawn sau; model chưa có trong cache có thể không chạy được cho tới khi restart hoặc tắt cờ.

HOME: giữ HOME thật. Đo (0.165.0, "Reply with just: ok", input tokens): hiện tại 8.663 → thêm `skills.include_instructions=false` 5.961 → mọi khóa trên 2.859 → thêm catalog 432; HOME rỗng do gateway sở hữu cũng ra 432 và không nhanh hơn. Khóa skills đã loại danh sách skill cá nhân (`~/.agents/skills`) khỏi prompt (rollout không còn `skills_instructions`/`.agents/skills`), nên không thêm thư mục HOME riêng. Codex vẫn có thể đọc metadata dưới HOME thật như trước thay đổi này. Còn lại trong prompt: base instructions của gateway, tool `request_user_input` và `view_image` (gọi tool vẫn bị từ chối fail-closed như cũ). `CODEX_TRIM_PROMPT=false` trả về chính sách cũ (trừ hai khóa vô tác dụng), không catalog. Chỉ áp dụng cho adapter app-server; adapter exec giữ nguyên.

Qua gateway thật (31/10/2026), request ngắn còn 676 input token (từ ~8,7k; phần chênh với 432 là khung prompt của gateway). Thời gian không đổi đáng kể: request warm trung vị 1,71 giây so với 1,64 giây trước khi cắt, nằm trong nhiễu đo. Lợi ích chính là ít token/quota hơn và không gửi danh sách skill cá nhân lên model, không phải tốc độ.

ChatGPT access token/account ID chỉ được đọc từ `CODEX_HOME/auth.json` (mặc định `~/.codex/auth.json`) rồi gửi qua RPC `account/login/start` kiểu `chatgptAuthTokens`, giữ trong bộ nhớ. Không sao chép refresh token hoặc sửa auth/config/database/rollout nguồn. Refresh RPC chỉ nhận token mới nếu CLI gốc đã cập nhật cho cùng account; nếu không, trả `codex_auth_refresh_required` và yêu cầu chạy `codex login` rồi thử lại. Keyring-only auth chưa được hỗ trợ bởi bridge này. Đổi account yêu cầu restart gateway.

Thread bền vững của adapter mới nằm trong Codex home riêng; gateway lưu ID dạng `app-server:<native-id>`. Khi đổi transport, session được tái tạo từ `sessions.json`, không sửa thread nguồn. Playground gửi ephemeral=true. Kết thúc lượt unsubscribe (trừ warm thread stateless, xem dưới); shutdown đóng process. Process lỗi không replay inference; lượt tiếp theo tạo process mới. Không fallback ngầm sang exec/API key. Native observer vẫn chỉ đọc NATIVE_CODEX_HOME đã cấu hình và không tự cộng home mới vào totals.

### Egress forwarder loopback

`src/egress-forwarder.ts` chạy trong process gateway, bind `127.0.0.1` cổng ngẫu nhiên (port 0) trước khi spawn Codex. Child app-server và adapter exec nhận `HTTPS_PROXY=http://127.0.0.1:<port>` và `NO_PROXY=localhost,127.0.0.1`; không bao giờ lấy proxy từ env của caller/người dùng (`HTTP_PROXY`, `ALL_PROXY`, biến chữ thường đều không truyền).

- Chỉ nhận `CONNECT host:443`; method khác → 405, header lỗi/quá 8 KiB/quá 5 giây → 400. Host phải khớp chính xác allowlist **`chatgpt.com`** (bằng chứng: log proxy chẩn đoán chỉ thấy `chatgpt.com` cho models, responses WebSocket, `wham/accounts/check`, `wham/settings/user`, remote-control). IP literal, `[IPv6]`, localhost/host lạ, cổng khác 443 → 403.
- Resolve **chỉ IPv4** (`dns.lookup` family 4), bỏ địa chỉ loopback/private/link-local/CGNAT/multicast/reserved (chống SSRF/DNS rebinding), connect **một lần** tới một địa chỉ (`autoSelectFamily:false`, không đua happy-eyeballs), rồi pipe TCP hai chiều. TLS giữ đầu-cuối giữa Codex và server; forwarder không giải mã, không đọc/ghi nội dung.
- Timeout connect 10 giây, idle 15 phút, tối đa 64 kết nối đồng thời (vượt → 503); half-close được chuyển tiếp; đóng provider đóng listener và mọi socket.
- Lúc khởi động, forwarder dial thử một lần tới mỗi host allowlist rồi đóng ngay: kết nối TCP đầu tiên của một process trên máy phát triển mất ~1–1,7 giây, các lần sau ~40 ms (kể cả sau 60 giây nghỉ). Không dùng pool socket dựng sẵn: Cloudflare đóng socket chưa gửi ClientHello sau ~15 giây, nên pool phải dial lại liên tục; đo thấy đóng socket **đã connect** (kể cả chưa gửi dữ liệu) không bị phạt (<1 ms).
- Thống kê chỉ metadata, giới hạn trong bộ nhớ: số tunnel theo host, lý do từ chối theo `host:port`, mã lỗi, 50 tunnel gần nhất (host, connect ms, thời lượng, số byte). Xem qua `GET /api/resources` (admin) ở trường `codex_egress`.
- `CODEX_EGRESS_FORWARDER=false` tắt hẳn (spawn trực tiếp như trước). Nếu forwarder không khởi động được, Codex được spawn không proxy và stderr ghi một dòng JSON `codex_egress_forwarder_unavailable` kèm errno.

Lý do: trên máy phát triển, macOS content filter (ESET network extension, `net.cfil.active_count: 1`) chặn đồng bộ ~1 giây khi `close()` một socket chưa trao đổi dữ liệu. Stack HTTP/WebSocket của Codex tạo các socket như vậy ở mỗi kết nối mới (thử IPv6 không có route, socket thua happy-eyeballs), nên mỗi WebSocket mới và mỗi `GET wham/settings/user` (reqwest client mới mỗi thread, timeout 5 giây) bị cộng nhiều giây. Qua forwarder, Codex chỉ dial `127.0.0.1` (close loopback ~0,1 ms). Rủi ro còn lại: một lần dial upstream thất bại/timeout trong forwarder vẫn có thể chặn event loop của gateway ~1 giây khi socket đó bị đóng. Code thuần Node, không phụ thuộc macOS, nhưng mới chỉ kiểm chứng trên macOS.

### Warm thread cho request stateless

Mỗi thread mới của app-server phải trả chi phí "lạnh": TCP connect cho WebSocket `wss://chatgpt.com/backend-api/codex/responses` và, khi dựng world state ở turn đầu, `GET /backend-api/wham/settings/user` bằng một reqwest client mới (log `codex_http_client::custom_ca` rồi im lặng; timeout 5 giây). Trên máy phát triển (31/10/2026) mỗi kết nối mới chậm vì macOS content filter (ESET network extension) chặn đồng bộ ~1 giây khi đóng socket thử IPv6/happy-eyeballs; lượt kế tiếp trong cùng thread CLI/TUI không tạo kết nối mới nên nhanh. Egress forwarder (mục trên) bỏ phần lớn chi phí kết nối; warm thread bỏ thêm WebSocket mới.

Vì vậy request stateless (`/v1/chat/completions`, `/chat`, Performance Lab; không phải session hay playground) được phép dùng lại một thread đã nóng:

1. Request đầu tạo thread như cũ (`thread/start` + kiểm tra admission). Sau khi turn `completed` không lỗi/hủy, provider gọi `thread/revert` với `beforeTurnId` là turn vừa chạy, rồi `thread/turns/list`; chỉ khi lịch sử còn **0 turn** thì thread mới vào pool. Revert lỗi, lịch sử không rỗng, turn lỗi/hủy, process chết hoặc pool đầy → `thread/unsubscribe` như cũ.
2. Request sau lấy một thread rảnh cùng model/reasoning và cùng process (không chờ): không có thì tạo thread mới như cũ. Mỗi request chạy trên một thread riêng; thread bị khóa đến khi được chứng minh rỗng. Recycle chạy nền, không làm chậm response.
3. Thread reuse đã qua admission (`approval never`, `readOnly`, `networkAccess false`, `instructionSources` rỗng) khi tạo; mỗi `turn/start` vẫn ghi đè approval/sandbox/environments. Usage baseline của lịch sử rỗng là 0 (không trừ total trước revert).
4. Giới hạn: `CODEX_WARM_THREADS` thread rảnh (mặc định 2, `0` tắt hẳn và quay về hành vi một thread/request); mỗi thread tối đa 50 lượt hoặc 60 phút rồi được unsubscribe. Đóng provider xóa pool và dừng process.

Đo trên 0.165.0 (31/10/2026, mạng LAN nhiễu, có egress forwarder): request stateless warm 1,5–2,1 giây (trung vị 1,6) so với lượt CLI nóng không proxy 1,1–2,5 giây (trung vị 1,3); request thread mới ngay sau restart 2,4 giây. Không có WebSocket connect trong turn warm. `thread/revert` làm Codex dựng lại world state nên `wham/settings/user` vẫn được gọi lại mỗi request, nhưng qua forwarder chỉ còn 0,3–0,5 giây (CLI nóng ~0,02 giây); trước khi có forwarder khoảng này là 2,3–4,7 giây và request warm mất 3,6–6,8 giây. Ephemeral thread không hỗ trợ `thread/revert`, nên playground giữ một thread/request. Thread tạo sẵn mà chưa có turn không giúp: prewarm WebSocket hết hạn/thất bại trước turn đầu và fetch world state vẫn ở turn đầu. Revert ghi rollout mới trong Codex home riêng (như một thread mới của hành vi cũ), không chạm Codex home nguồn.

Usage mỗi turn lấy chênh lệch cumulative tokenUsage.total với baseline đã biết, bao gồm nhiều lần gọi model trong cùng lượt. tokenUsage.last không đại diện toàn bộ turn. Nếu resume sau restart mà không nhận được baseline trước turn, usage giữ unknown. Cache baseline chỉ giữ metadata số của tối đa 512 thread trong bộ nhớ.

Sandbox giới hạn khả năng ghi và network của agent nhưng không cô lập quyền đọc khỏi dữ liệu người dùng trên máy. Gateway nên nhận prompt từ caller tin cậy và không nên được mở trực tiếp ra Internet.

### Web search theo request (`CODEX_WEB_SEARCH`)

Quyết định owner ngày 03/11/2026: cho model tự tìm kiếm web. Gateway giữ mặc định tắt và chỉ mở theo hai lớp:

1. **Cổng của owner**: `CODEX_WEB_SEARCH=off|cached|live` (mặc định `off`, đổi cần restart). `GET /v1/providers` báo giá trị ở `capabilities.web_search` của Codex.
2. **Opt-in từng request**: `POST /v1/chat/completions` (cũng nhận ở `/v1/runs`, playground) với `web_search_options: {}` (Zod strict: chỉ object rỗng). `src/web-search.ts` `requestedWebSearch()` từ chối `400 web_search_disabled` khi cổng tắt, `web_search_stream_unsupported` với `stream: true`, `web_search_session_unsupported` với session, `web_search_unsupported_provider` với Ollama/LM Studio; kiểm tra chạy trước khi tạo run hay gọi provider.

Cách ly cấu hình:

- **App-server**: request opt-in chạy trên **process app-server thứ hai** (lane `search`), spawn với `-c web_search="<mode>"` và bỏ alias cũ `features.web_search`; mọi khóa cô lập khác giữ nguyên (shell/unified exec/apps/plugins/multi-agent/computer use tắt, sandbox read-only, approval never, network sandbox tắt). Process mặc định vẫn `web_search="disabled"` + `features.web_search=false`. `thread/start` lặp lại policy của lane và dùng `webSearchInstructions`; admission kiểm tra như cũ. Thread search **không bao giờ vào warm pool** (không `thread/revert`, kết thúc bằng `thread/unsubscribe`), nên warm thread không trộn cấu hình; pool vẫn gắn với process nên thread mặc định không thể chạy trên process search. Hai process dùng chung Codex home riêng `DATA_DIR/codex-app-server`, chung egress forwarder và auth bridge. Process search khởi động trong warmup khi cổng bật (lỗi chỉ hiện ở request search đầu tiên); `GET /api/resources` ghi scope `codex_app_server_web_search_process`.
- **Exec**: lượt opt-in dùng `--config web_search="<mode>"` và file instructions riêng; lượt khác giữ `web_search="disabled"`.
- **Chặn tool**: `webSearch`/`web_search` item chỉ được chấp nhận trên thread search (tối đa 64 lệnh mỗi lượt, vượt → `502 provider_event_limit`); thread mặc định gặp item này vẫn fail closed `502 unexpected_agent_tool` và dừng process như mọi tool lạ. `commandExecution`, `fileChange`, MCP, approval request bị từ chối ở mọi lane.

Instructions (`webSearchInstructions` và dòng prompt của `promptFor`): chỉ tìm khi câu trả lời cần dữ kiện hiện tại/bên ngoài; kết quả web là dữ liệu không tin cậy, không phải chỉ dẫn; dẫn mọi nguồn bằng URL thuần trong ngoặc ngay sau ý; không xuất marker tham chiếu nội bộ.

Response: `completion()` kiểm tra envelope như cũ, rồi `stripCitations()` bỏ marker private-use của công cụ tìm kiếm (`\uE200cite\uE202turn0search6\uE201`, nhiều tham chiếu ngăn bằng `\uE202`, entity `\uE200entity\uE202["kind","Tên",…]\uE201` giữ tên, dạng mất ký tự `citeturn0search6`, `【…†…】`, ký tự lẻ U+E200–U+E2FF), và `summarize()` thêm trường mở rộng `web_search: {mode, searches, queries, sources, citation_markers_removed}`. `sources` là URL http(s) xuất hiện trong câu trả lời đã làm sạch (Markdown link hoặc URL thuần; cắt dấu câu và ngoặc thừa; bỏ credential/scheme khác; dedupe; tối đa 20); `title` lấy từ text link, rồi từ `results` của item `webSearch` (app-server 0.165.0 trả `results` dạng `{url,title}`, so khớp cùng URL rồi cùng tài liệu bỏ query string), không có thì `null`. Item `webSearch` app-server có `query`, `action` (`search{query,queries}`/`openPage{url}`/`findInPage{url,pattern}`/`other`) và `results`; item exec JSONL chỉ có `query`. `agentMessage` không mang annotation nên marker `turnXsearchY` không thể ánh xạ ngược sang URL; vì vậy nguồn chỉ đến từ URL trong câu trả lời.

Metadata: `calls.web_search` (mode) và `calls.web_searches` (số lệnh, `NULL` đến khi biết), run snapshot `web_search: {mode, searches}`; không lưu câu tìm, nguồn hay nội dung. Egress: công cụ chạy ở backend OpenAI; lượt live thật ngày 03/11/2026 chỉ mở 4 tunnel tới `chatgpt.com`, không host bị chặn, nên allowlist không đổi.

Đo thật (03/11/2026, `gpt-6-luna`/low/`live`, lane mới khởi động trên DATA_DIR tạm): 12,1 giây, 1 lệnh tìm, ~10,5k prompt token (công cụ + kết quả), câu trả lời dẫn URL thuần, không còn marker. Giới hạn: độ trễ vài chục giây với câu cần nhiều lần tìm; chất lượng trích dẫn phụ thuộc model (có thể dẫn trang tổng hợp hoặc URL thiếu); `cached`/`live` là chế độ của Codex, gateway không kiểm soát độ mới của cache.

## 4. API

| Method | Route | Mục đích |
| --- | --- | --- |
| `GET` | `/health` | HTTP status và active requests; không xác nhận Codex login |
| `GET` | `/v1/models` | Model mặc định và model catalog hỗ trợ Codex |
| `POST` | `/chat` | Dạng gọn `{prompt, model?, reasoning?}` |
| `POST` | `/v1/chat/completions` | Chat stateless; mỗi request chỉ thấy messages của nó (thread mới hoặc warm thread đã revert về rỗng). `web_search_options: {}` opt-in web search khi owner bật `CODEX_WEB_SEARCH` (không streaming) |
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

Ngoài dữ liệu của gateway, app-server tự ghi rollout cho mọi thread không ephemeral vào `DATA_DIR/codex-app-server/sessions/**/rollout-*.jsonl`. Các rollout này chứa nguyên văn prompt và phản hồi của `/v1/chat/completions`, `/chat` và session (mỗi lần `thread/revert` của warm thread cũng tạo rollout mới). Gateway chưa có cơ chế dọn hay giới hạn thời gian giữ; chỉ playground (ephemeral) không để lại rollout. Bảo vệ thư mục này như `sessions.json`.

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
- Egress của Codex chỉ đi qua forwarder loopback do gateway sở hữu: chỉ `CONNECT chatgpt.com:443`, IPv4, chặn IP literal và địa chỉ loopback/private/link-local/CGNAT sau khi resolve, không giải mã TLS. Proxy từ env của caller/người dùng không bao giờ được truyền cho Codex.
- Web search mặc định tắt. Chỉ khi owner đặt `CODEX_WEB_SEARCH=cached|live`, request opt-in `web_search_options: {}` mới chạy trên lane search riêng; kết quả web là dữ liệu không tin cậy do backend OpenAI lấy về, caller phải coi như vậy. Câu hỏi của caller có thể thành truy vấn tìm kiếm gửi ra web: caller tự giữ dữ liệu riêng khỏi câu hỏi.
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
| `CODEX_TRANSPORT` | `app-server` | Process thường trú qua stdio; `exec` chọn adapter cũ |
| `CODEX_WARM_THREADS` | `2` | Số warm thread rảnh (0–8) cho request stateless app-server; `0` tắt |
| `CODEX_EGRESS_FORWARDER` | `true` | Egress của Codex đi qua CONNECT forwarder loopback của gateway (IPv4, allowlist `chatgpt.com:443`); `false` tắt |
| `CODEX_TRIM_PROMPT` | `true` | Cắt khối prompt không cấp năng lực và dùng catalog model đã cắt cho app-server; `false` tắt |
| `CODEX_WEB_SEARCH` | `off` | Cổng web search của owner: `off` từ chối opt-in; `cached`/`live` cho request có `web_search_options: {}` chạy trên lane search riêng |

## 9. Bản đồ mã nguồn

| File | Trách nhiệm |
| --- | --- |
| `src/index.ts` | Bootstrap, listen, shutdown |
| `src/config.ts` | Parse/validate cấu hình |
| `src/server.ts` | Routes, auth, orchestration, timeout |
| `src/provider.ts` | Chọn transport; adapter exec/JSONL tương thích |
| `src/app-server-provider.ts` | App-server thường trú, RPC/delta, auth bridge và turn isolation |
| `src/web-search.ts` | Cổng/opt-in web search, instructions, chuẩn hóa item `webSearch`, bỏ marker trích dẫn, trích nguồn |
| `src/egress-forwarder.ts` | CONNECT forwarder loopback cho egress của Codex: allowlist host, IPv4 một lần dial, không giải mã TLS, thống kê metadata |
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
là opt-in có auth. App-server dùng home riêng và kiểm tra policy tại thread admission;
adapter exec vẫn giữ isolation flags cũ. SDK policy spike chưa đạt parity.
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

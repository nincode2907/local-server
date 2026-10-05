# Tài liệu kỹ thuật — Codex Local Server

> Mô tả kiến trúc và luồng dữ liệu theo mã nguồn hiện tại. Cập nhật tài liệu khi thay đổi API, provider hoặc cấu trúc lưu trữ.

## 1. Mục tiêu

Codex Local Server là HTTP gateway viết bằng Node.js và TypeScript. Nó nhận chat request theo kiểu OpenAI, kiểm tra đầu vào, chuyển yêu cầu sang Codex CLI đã đăng nhập bằng ChatGPT, rồi đổi kết quả thành JSON tương thích.

Mặc định server chỉ lắng nghe tại `127.0.0.1:4000`. Đây không phải OpenAI API chính thức, không cần `OPENAI_API_KEY`, và không hỗ trợ toàn bộ tính năng của OpenAI API.

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

Function calling được mô phỏng bằng structured output: model đề xuất `tool_calls`, server kiểm tra JSON Schema draft-07, client tự thực thi rồi gửi lại `role=tool`. Không có lệnh/hàm do caller cung cấp được gateway thực thi.

Không hỗ trợ streaming, ảnh/audio, `n` khác 1, `temperature` khác 0, embeddings hoặc toàn bộ tham số OpenAI API.

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

## 7. Bảo mật và giới hạn

- Bind `127.0.0.1`; chỉ nhận Host localhost/loopback, không bật CORS.
- `LOCAL_API_KEY` là Bearer token riêng cho gateway, không phải OpenAI API key. Dashboard shell có thể tải để nhập token; API dữ liệu/chat vẫn yêu cầu token.
- Browser đọc dashboard cùng origin. Playground POST cần origin trùng, JSON và `X-Codex-Playground: 1`.
- Body tối đa 1 MiB, mặc định tối đa 2 lượt Codex đồng thời, timeout 180 giây.
- HTTP caller không thể chọn working directory, Codex home hoặc executable.
- `read-only` hạn chế ghi, không ngăn tiến trình đọc dữ liệu người dùng. Chỉ dùng với caller đáng tin; không expose internet.
- Gateway session lưu messages trong JSON. Bảo vệ `sessions.json` như dữ liệu chat nhạy cảm.

## 8. Cấu hình

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `4000` | Cổng HTTP |
| `DEFAULT_MODEL` | `gpt-6-luna` trong schema runtime | Model mặc định; README có thể nêu giá trị gợi ý khác |
| `DEFAULT_REASONING_EFFORT` | `low` | Reasoning mặc định |
| `REQUEST_TIMEOUT_MS` | `180000` | Timeout một lượt |
| `MAX_CONCURRENT` | `2` | Lượt đồng thời tối đa |
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
| `src/catalog.ts` | Catalog và ước lượng chi phí |
| `src/dashboard.ts` | Phục vụ assets, dashboard APIs |
| `public/dashboard.html` | Cấu trúc UI |
| `public/dashboard.css` | Theme, layout, responsive styles |
| `public/dashboard.js` | API, biểu đồ, bảng, playground, tab navigation |
| `data/models.json` | Catalog model, giá và nguồn |
| `test/*.test.ts` | Automated tests; `scripts/smoke.ts` gọi Codex thật |

## 10. Chạy local

Yêu cầu Node.js 22.13+. Trên Windows, chọn phiên bản rõ ràng trong NVM for Windows:

```powershell
nvm use 22.23.3
npm ci
Copy-Item .env.example .env
npm run build
npm start
```

Đăng nhập CLI bằng `\.\node_modules\.bin\codex.cmd login` trên Windows hoặc `./node_modules/.bin/codex login` trên macOS/Linux. Dashboard ở `http://127.0.0.1:4000/dashboard`; `npm run dev` bật TypeScript watcher. `npm run test:live` gọi Codex thật và tiêu thụ hạn mức tài khoản.

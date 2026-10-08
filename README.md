# Codex Local Server — V1

Local HTTP gateway bằng Node.js + TypeScript + `@openai/codex-sdk`, dùng Codex đã đăng nhập bằng ChatGPT. Mặc định lắng nghe tại `http://127.0.0.1:15600`.

```text
Python / app / agent → HTTP → Fastify → Codex SDK → Codex CLI → ChatGPT account
```

Tài liệu kiến trúc: [TECHNICAL.md](docs/TECHNICAL.md) · [Sơ đồ trực quan HTML](docs/architecture.html).

Lệnh chạy, process management và tình trạng Dev Hub: [DEVELOPMENT.md](docs/DEVELOPMENT.md) · [Bản trực quan](docs/DEVELOPMENT.html). Hướng dẫn cho agent: [AGENTS.md](AGENTS.md).

## Chạy

Node **22.13+** (khuyên dùng Node 24). Máy hiện tại có Node 24 qua nvm; chạy `nvm use` trước vì shell có thể đang dùng Node 16.

```bash
nvm use
npm ci
./node_modules/.bin/codex login       # đăng nhập bằng ChatGPT nếu chưa đăng nhập
./node_modules/.bin/codex login status
cp .env.example .env                 # tùy chọn
npm run build
npm start
```

Chạy nền không in log ra terminal (npm dùng `-d` làm cờ riêng, nên truyền cờ cho script sau `--`):

```bash
npm start --silent -- -d
npm stop
```

`npm start -- -d` cũng chạy nền; `--silent` ẩn banner của npm. Output của server được bỏ qua. PID được ghi trong `.local/server.pid`.

Windows PowerShell (NVM for Windows requires an explicit version; use any installed Node 22.13+):

```powershell
nvm use 22.23.3
npm ci
.\node_modules\.bin\codex.cmd login
.\node_modules\.bin\codex.cmd login status
Copy-Item .env.example .env
npm run build
npm start
```

Development: `npm run dev`. `Ctrl+C` dừng server và hủy các lượt đang chạy. Không cần `OPENAI_API_KEY`; gateway buộc auth bằng ChatGPT, không kế thừa API key từ môi trường.

Đặt `DEFAULT_MODEL` và `DEFAULT_REASONING_EFFORT` trong `.env` để chọn mặc định cho chat và session. Defaults trong `src/config.ts` và `.env.example` là `gpt-6-luna` và `low`; cấu hình `.env` của máy có thể ghi đè. Body từng request vẫn nhận `model` và `reasoning_effort` (hoặc alias `reasoning`) để override. Model phải được tài khoản Codex của bạn cấp quyền; nếu không hãy chọn model khả dụng. Gateway vẫn dùng hạn mức của tài khoản ChatGPT. Health chỉ cho biết HTTP server hoạt động, không kiểm tra đăng nhập/hạn mức.

## API

| Endpoint | Công dụng |
| --- | --- |
| `GET /health` | Trạng thái server và số request đang chạy |
| `GET /v1/models` | Model mặc định đã cấu hình; không phải danh sách quyền model của tài khoản |
| `POST /chat` | Alias gọn: `{prompt, model?, reasoning?}` → `{ok:true, output}` |
| `POST /v1/chat/completions` | Chat stateless, mỗi request tạo thread mới |
| `POST /v1/sessions` | Tạo session, chưa gọi model |
| `POST /v1/sessions/:id/messages` | Tiếp tục cùng Codex thread |
| `DELETE /v1/sessions/:id` | Xóa session khỏi gateway, trả `204` |
| `GET /dashboard` | Trang thống kê server |
| `GET /api/stats/overview` | Tổng quan, timeline và thống kê theo model |
| `GET /api/stats/calls` | Lịch sử call, lọc và phân trang |

Ví dụ `.env`:

```dotenv
DEFAULT_MODEL=gpt-6.1-sol
DEFAULT_REASONING_EFFORT=high
```

Khởi động lại server sau khi đổi `.env`. Giá trị request-level `model`/`reasoning_effort` ghi đè mặc định; session khóa các giá trị đã chọn khi tạo.

### Chat kiểu OpenAI

```bash
curl http://localhost:15600/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-6.1-sol",
    "reasoning_effort": "high",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello"}
    ]
  }'
```

```json
{
  "id": "chatcmpl-local-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-6.1-sol",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello!"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 123, "completion_tokens": 12, "total_tokens": 135}
}
```

`usage` ánh xạ token của toàn bộ Codex turn, gồm prompt wrapper/structured output; không chỉ đo text bạn gửi. Chỉ có khi SDK cung cấp usage.

```bash
curl http://localhost:15600/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Giải thích closure trong JavaScript", "reasoning":"high"}'
```

### Python: đổi provider bằng base_url

```bash
pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:15600/v1",
    api_key="local",  # hoặc LOCAL_API_KEY nếu bạn cấu hình token gateway
    timeout=200,
    max_retries=0,
)
response = client.chat.completions.create(
    model="gpt-6.1-sol",
    messages=[{"role": "user", "content": "Hello"}],
    reasoning_effort="high",
    temperature=0,
)
print(response.choices[0].message.content)
```

`temperature=0` được chấp nhận để tương thích lời gọi hiện có nhưng **không áp dụng**: Codex SDK không có temperature. Giá trị khác bị từ chối `400`. `reasoning` là alias của `reasoning_effort`; khi gửi cả hai chúng phải giống nhau. Effort có được hỗ trợ hay không còn tùy model.

### Function calling

Gateway dùng structured output của Codex để mô phỏng giao thức function calling, không đăng ký `tools` thành tool native của Codex. Server trả `tool_calls`; **app của bạn thực thi hàm** và gửi lại các message `role=tool`. Server kiểm tra tên hàm, JSON arguments và JSON Schema trước khi trả call.

```python
import json
from openai import OpenAI

client = OpenAI(base_url="http://localhost:15600/v1", api_key="local", timeout=200, max_retries=0)
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
            "additionalProperties": False,
        },
    },
}]
messages = [{"role": "user", "content": "Thời tiết Hà Nội thế nào?"}]

# Đây là tool demo. Thay bằng HTTP request/service thực tế của app.
def get_weather(city):
    return {"city": city, "temperature_c": 29, "condition": "sunny", "demo": True}

functions = {"get_weather": get_weather}
for _ in range(5):
    result = client.chat.completions.create(
        model="gpt-6.1-sol", messages=messages, tools=tools,
        tool_choice="auto", temperature=0,
    )
    msg = result.choices[0].message
    if not msg.tool_calls:
        print(msg.content)
        break
    messages.append({
        "role": "assistant", "content": msg.content,
        "tool_calls": [call.model_dump() for call in msg.tool_calls],
    })
    for call in msg.tool_calls:
        value = functions[call.function.name](**json.loads(call.function.arguments))
        messages.append({
            "role": "tool", "tool_call_id": call.id,
            "content": json.dumps(value, ensure_ascii=False),
        })
else:
    raise RuntimeError("Tool loop limit reached")
```

Hỗ trợ `tool_choice`: `auto`, `none`, `required`, hoặc `{"type":"function","function":{"name":"get_weather"}}`. `parallel_tool_calls=false` giới hạn một call mỗi phản hồi. Phải gửi đủ kết quả cho tất cả call trước lượt chat tiếp theo. Schemas dùng draft-07; hỗ trợ kiểu dữ liệu, required, enum, additionalProperties…; `format` không được kiểm tra. `strict` trong tool được chấp nhận; gateway luôn kiểm tra arguments theo schema.

### Session nhiều lượt

```python
import requests

base = "http://localhost:15600"
session = requests.post(base + "/v1/sessions", json={
    "model": "gpt-6.1-sol", "reasoning_effort": "high",
    "messages": [{"role": "system", "content": "Trả lời bằng tiếng Việt."}],
}, timeout=10)
session.raise_for_status()
sid = session.json()["session_id"]

for text in ["Tôi tên Nin", "Tên tôi là gì?"]:
    response = requests.post(f"{base}/v1/sessions/{sid}/messages",
                             json={"message": text}, timeout=200)
    response.raise_for_status()
    print(response.json()["choices"][0]["message"]["content"])

requests.delete(f"{base}/v1/sessions/{sid}", timeout=10).raise_for_status()
```

Với session, gửi **message mới** thay vì toàn bộ history. Body nhận `message` hoặc `messages` (chỉ một trong hai). `messages` dùng khi trả kết quả tool:

```json
{
  "messages": [{"role":"tool", "tool_call_id":"call_...", "content":"{\"temperature_c\":29}"}],
  "tools": [{"type":"function", "function":{"name":"get_weather", "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
  "tool_choice": "none"
}
```

Khi cần tools, gửi definitions và `tool_choice` trong **mỗi request**. Session cố định model và reasoning lúc tạo. Gateway lưu session metadata/history trong `.local/sessions.json` và resume Codex thread sau restart. Session hết hạn sau 24 giờ không hoạt động. Giới hạn context 512 messages / 1 MiB. Chạy một server process cho mỗi `DATA_DIR`; V1 chưa có khóa giữa các process.

Xóa session không xóa lịch sử thread do Codex CLI lưu trong `CODEX_HOME`. Nếu lượt session lỗi/timeout, session bị vô hiệu hóa để tránh tiếp tục một history đã ghi dở; cần tạo session mới.

## Video builds

Tab **Video builds** nằm trong dashboard hiện có. Tạo/sửa metadata, chấm điểm tùy chọn 0–10, nối session với PLAN / BUILD / REVISE / FINISH, xem timeline và so sánh theo model, engine hoặc pipeline. Session detail có tag `Video: … · Stage: …` và form gắn vào build đã tạo.

SQLite hiện tại giữ thêm `video_builds` và `video_stages`. Token, cost và thời gian được nối từ `native_events` / `native_turns` qua session ID, không lưu bản sao. Không nhập prompt/response vào notes. Preview/final path chỉ là metadata, không phục vụ hay chạy file. Các số liệu thiếu hiển thị `—`, không coi là miễn phí.

- First-pass rate: số preview duyệt ở BUILD đầu tiên, chưa qua BUILD khác hoặc REVISE / tổng preview đã duyệt.
- Cost/time đến approved preview: tổng stage trước và gồm BUILD/REVISE đầu tiên được duyệt, cắt usage tại `approved_at`; không cộng FINISH sau đó. Time là tổng thời gian turn, không phải thời gian chờ review.
- Quality/USD và quality/phút: tổng overall / tổng cost hoặc phút của các mẫu có cả score và số liệu đầy đủ, mẫu số >0. Theo model dùng phần usage của model đó; score vẫn là score của build.
- Một session chỉ được dùng toàn bộ ở một stage. Nếu tái dùng session, chọn các `turn_ids` không chồng nhau để tránh cộng trùng. Không cần session đã import sẵn: collector đồng bộ sau sẽ bổ sung số liệu.

Manifest compact **version 1** được lưu với từng experiment và có nút Import/Export. Ví dụ file `video-build.json` cho các lần chạy video-builder sau:

```json
{
  "version": 1,
  "build": {
    "id": "queue-protects-server",
    "title": "Queue protects server",
    "type": "explainer",
    "engine": "remotion",
    "duration": 30,
    "aspect_ratio": "16:9",
    "status": "preview",
    "revisions": 0,
    "preview_path": "out/preview.mp4",
    "final_path": null,
    "quality": { "overall": 8, "wow": 7 }
  },
  "stages": [
    { "id": "plan", "stage": "PLAN", "session_id": "codex-session-id-plan", "model": "gpt-6.1-sol", "notes": "Storyboard", "approved": false },
    { "id": "build", "stage": "BUILD", "session_id": "codex-session-id-build", "model": "gpt-6-luna", "notes": "Preview ready", "approved": false }
  ]
}
```

`duration` là giây; `created_at` và `approved_at` là Unix milliseconds tùy chọn. Duyệt stage không truyền `approved_at` sẽ lấy thời điểm hiện tại. Khi nhập experiment cũ, truyền thời điểm duyệt thật. `approved`/`final` cần một BUILD/REVISE đã duyệt; `final` cần `final_path`. Quality tùy chọn gồm clarity, visual, motion, originality, wow, technical, overall. Import ID trùng báo 409; chỉnh sửa thay thế manifest theo ID, giữ ngày tạo.

### Tương thích với global video-builder

Schema import thực tế là `videoManifest` trong `src/video-builds.ts`, không phải template của skill. Manifest nguồn `video-build.json` dùng `schema_version: 1` của global video-builder hiện **không import trực tiếp** được. Giữ nguyên file nguồn và xuất riêng `video-build.dashboard.json` theo schema `version: 1` ở trên:

| Manifest nguồn | Payload dashboard |
| --- | --- |
| `schema_version` | `version` |
| `build.duration_seconds` | `build.duration` |
| `build.engine`, ví dụ `Remotion` | Enum chữ thường: `remotion`, `manim`, `ffmpeg`, `hybrid` |
| `revisions` ở root | `build.revisions` |
| `quality_scores` | `build.quality` |
| `artifacts.preview` / `artifacts.final` | `build.preview_path` / `build.final_path` |
| `build.created_at` ISO 8601 | Unix milliseconds |
| Stage `model: null` | Stage `model: ""` (chưa biết) |

Importer strict: không gửi root `approval`, `artifacts`, stage `created_at` hoặc field ngoài schema. Giữ brief path, timestamp ISO, unknown fields và lịch sử trong manifest nguồn. Dashboard cần metadata bắt buộc đã biết; không điền engine suy đoán hoặc duration bằng 0 khi chưa biết. Status dashboard chỉ gồm `planned`, `preview`, `approved`, `final`; khi nguồn đang `building`/`revising`, bản export dùng `preview` nếu đã có preview thật, nếu chưa thì `planned`.

Approval dashboard thuộc từng stage: duyệt brief PLAN không có nghĩa duyệt preview BUILD. Chỉ đánh dấu stage được duyệt khi biết rõ đối tượng và thời điểm duyệt; `approved`/`final` cần BUILD/REVISE đã duyệt. DIRECT dùng chung session phải có `turn_ids` thật, không chồng nhau giữa stages. Không tạo session/model/turn giả để vượt validation. Dashboard yêu cầu thứ tự PLAN → BUILD → REVISE → FINISH; lịch sử không phù hợp cần báo giới hạn, không tự sắp xếp lại.

Kiểm tra payload bằng parser và API với database fixture riêng trước khi báo import thành công. Validator của skill chỉ kiểm tra cấu trúc skill. Hướng dẫn export nằm trong global `video-builder/references/build-manifest.md`; contract của repo tại đây là nguồn chuẩn cho dashboard.

API local: `GET /api/videos`, `GET /api/videos/:id` (build + manifest), `GET /api/videos/sessions?search=...`, `POST /api/videos`, `POST /api/videos/import`, `PUT /api/videos/:id`. Ghi dùng JSON và header `X-Codex-Video: 1`; browser cần cùng origin. Cấu hình Bearer hiện có vẫn áp dụng nếu đã bật.

```bash
curl http://localhost:15600/api/videos/import \
  -H 'Content-Type: application/json' -H 'X-Codex-Video: 1' \
  --data-binary @video-build.json
```

## Dashboard và SQLite

Mở **http://localhost:15600/dashboard** (hoặc `/` để tự chuyển hướng). Trang cập nhật mỗi 5 giây; có thể tắt tự cập nhật. Bộ lọc gồm 1 giờ / 24 giờ / 7 ngày / 30 ngày, model và trạng thái. Bảng lịch sử phân trang 20 call, mở chi tiết để xem reasoning, session ID, token và mã lỗi. Thời gian hiển thị theo Việt Nam, UTC+7.

Thống kê chỉ tính các POST chat: `/chat`, `/v1/chat/completions`, `/v1/sessions/:id/messages`. Các request đọc dashboard, health và quản lý session không tăng số call. Call được lưu ngay khi server nhận, có trạng thái đang xử lý, thành công, lỗi, từ chối, hủy hoặc gián đoạn. Request bị từ chối trước khi gọi Codex vẫn được ghi riêng.

SQLite lưu tại **`DATA_DIR/stats.sqlite`** (mặc định `.local/stats.sqlite`); có thể đổi bằng `STATS_DB_PATH` trong `.env`. Lịch sử giữ sau restart và không tự xóa. Server bị crash để lại lượt đang chạy thì lần mở sau đánh dấu `interrupted`; không tự suy đoán duration. Chạy một server process cho mỗi file dữ liệu. Dùng [SQLite tích hợp của Node.js](https://nodejs.org/api/sqlite.html), không cần cài database server.

Input/output/cache/reasoning lấy từ usage của Codex. Tổng token = input + output; cache là phần nằm trong input, reasoning nằm trong output. Call không có usage hiển thị `—`, dashboard báo số lượt thiếu usage và không ước lượng token. Thời gian trung bình/p95 chỉ tính các lượt đã gọi Codex và có duration; tỷ lệ thành công tính trên toàn bộ call đã hoàn tất, gồm cả lượt từ chối. Function calls là số hàm được đề xuất, không phải số lần app đã thực thi thành công.

Lịch sử bắt đầu từ khi thêm thống kê; không truy hồi các call cũ. SQLite chỉ lưu metadata, token và timing, không lưu nội dung prompt/câu trả lời. Nếu bật `LOCAL_API_KEY`, trang sẽ yêu cầu nhập token để lấy số liệu; token chỉ giữ trong bộ nhớ trang. Dashboard shell được tải không cần key, API thống kê vẫn yêu cầu Bearer token.

```bash
curl 'http://localhost:15600/api/stats/overview?range=24h'
curl 'http://localhost:15600/api/stats/calls?range=7d&status=error&page=1'
```

Query `model` là tùy chọn; thêm header `Authorization: Bearer ...` nếu bật token gateway.

## Quyền và phạm vi V1

- Bind cứng `127.0.0.1`; từ chối Host không phải localhost; browser chỉ được đọc dashboard và thống kê từ cùng origin, không bật CORS.
- Tùy chọn `LOCAL_API_KEY`: API chat, session, health, models và thống kê yêu cầu `Authorization: Bearer <token>`. Dashboard shell có thể tải để nhập token. Token này bảo vệ gateway local, không phải API key OpenAI.
- SDK chạy trong thư mục tạm riêng, bỏ user config và exec rules, thay agent instructions, không nạp AGENTS.md, tắt shell/unified exec, apps/plugins, multi-agent, computer use và web search.
- Sandbox `read-only`, approvals `never`, command networking tắt. HTTP request không được chọn working directory, Codex home, executable hoặc nâng quyền.
- Gateway không thực thi tool do caller cung cấp. Không kế thừa biến môi trường bí mật của app; dùng auth store Codex hiện có để tiếp tục refresh login như CLI.
- Read-only bảo vệ việc ghi file; **không phải sandbox bảo mật đầy đủ để cô lập quyền đọc dữ liệu**. Chỉ dùng cho app local tin cậy. Không expose ra internet; nếu cần chạy prompt không tin cậy, dùng user/container riêng với dữ liệu và auth tách biệt.
- Giới hạn body 1 MiB, mặc định 2 lượt đồng thời, timeout 180 giây. Request vượt concurrency trả `429`, không xếp hàng; session đang chạy trả `409`.
- V1 nhận text messages, tools kiểu function, `n=1`, `stream=false`. Chưa có streaming, ảnh/audio, `response_format`, `max_tokens`, embeddings hoặc full OpenAI API. Tham số ngoài phạm vi trả `400`.

Lỗi theo dạng `{"error":{"message":"...","type":"...","code":"..."}}`. Codex lỗi trả `502`, timeout `504`. Response không chứa raw CLI stderr hay credential. Kiểm tra `codex login status`, model và phiên bản CLI khi gặp `codex_error`. `CODEX_BIN` chỉ dùng khi bạn chủ động muốn thay CLI bundle tương thích.

## Kiểm tra

```bash
npm run check
npm test
npm run build
npm run test:live   # gọi Codex thật; tiêu thụ hạn mức tài khoản đang đăng nhập
```

Test tự động kiểm tra API, schema tool, history/tool IDs, resume sau restart, xóa session, Host/Origin/auth, concurrency và cancellation. Live smoke kiểm tra chat thật, function-call round trip và memory/resume sau restart bằng Codex đang đăng nhập.

Tài liệu chính thức: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Authentication](https://learn.chatgpt.com/docs/auth), [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Chi phí và test chat

Mở `http://localhost:15600/dashboard`: tab **Thống kê** có tổng chi phí ước tính và bảng theo ngày/tuần/tháng (UTC+7, tuần bắt đầu thứ Hai). Bảng chi phí dùng toàn bộ lịch sử và bộ lọc model; khoảng thời gian chỉ áp dụng thống kê call/token. Giá snapshot clone trong `data/`, được đóng băng theo từng call trong SQLite. Cache được tách khỏi input để tránh tính hai lần. Chi phí theo giá API tham khảo, không phải hóa đơn Plus; lượt thiếu giá/usage được đánh dấu chưa tính được.

Tab **Test chat** có nhiều tab tạm, chọn model/reasoning, system context, copy model, dừng request, trạng thái đang suy nghĩ và chi tiết request/response/usage/chi phí. Context chỉ ở bộ nhớ trang và gửi lại mỗi lượt, không dùng session; Codex chạy `--ephemeral`. Reload xóa chat. SQLite chỉ lưu metadata, không lưu prompt/response. Tab **Model & giá** cho tìm kiếm/copy tất cả model trong snapshot; chỉ model tương thích Codex có nút test. Quyền thực tế còn tùy tài khoản.

Endpoint dashboard: `GET /api/models`, `GET /api/stats/costs?group=day|week|month&model=...`, `GET /api/stats/calls/:id`. Mỗi chat response có header `X-Codex-Call-Id`. Playground dùng `POST /api/playground/chat` cùng origin, JSON và header `X-Codex-Playground: 1`; vẫn yêu cầu Bearer khi bật `LOCAL_API_KEY`.

## Codex usage trên laptop

Tab **Codex usage** đọc `state_5.sqlite` (chỉ đọc), `sessions/**/rollout-*.jsonl` và `archived_sessions/**/rollout-*.jsonl` trong `NATIVE_CODEX_HOME` (mặc định `CODEX_HOME` hoặc `~/.codex`). Collector chạy lúc khởi động và mỗi `NATIVE_USAGE_INTERVAL_MS` (mặc định 30000, tối thiểu 5000). Nó stream các file mới/đã thay đổi, replay vào bảng SQLite riêng theo ID để tránh đếm trùng, và giữ thống kê khi file gốc không còn. Nút Làm mới đọc số liệu đã đồng bộ; không quét bằng agent hay proxy network.

Database gateway giữ thêm `native_sessions`, `native_turns`, `native_events`, `native_files`. Chỉ lưu session ID, project/cwd, nguồn, model/reasoning, timestamps, trạng thái, usage và snapshot giá; không lưu title, prompt, response hay nội dung tool. Native events được giữ riêng với call gateway, không cộng hai datasource với nhau. Gateway trong rollout được nhận diện bằng tên thư mục runtime `codex-gateway-*`; đây là phân loại theo cwd. `vscode` có thể là VS Code hoặc App, không tự khẳng định phân biệt khi metadata không đủ. Các thread ephemeral không có rollout nên không thể lấy usage bằng observer này.

Parser ưu tiên `token_usage_record.usage`, deduplicate response ID và bỏ `token_count` của cùng turn để tránh cộng hai lần. Với log cũ, dùng chênh lệch `total_token_usage`; record đầu/reset dùng `last_token_usage`, không gán usage kế thừa cho child/fork. Bản fork bỏ record trước thời điểm tạo và record có thread ID của parent. Usage chưa expose sẽ hiển thị **—**; không dùng `threads.tokens_used` hay suy token từ text. Bộ đếm reset và dòng malformed được ghi chú; dòng JSONL chưa hoàn chỉnh được đọc lại ở lần sync sau. Session không có rollout vẫn được nhập metadata từ state DB.

Bộ lọc thời gian áp dụng theo **timestamp usage event** và mốc ngày UTC+7. Hôm nay tính từ 0h đến hiện tại và so sánh từng card với trọn ngày hôm qua; hôm qua tính từ 0h đến 24h. 7 ngày gồm hôm nay và 6 ngày trước, 30 ngày gồm hôm nay và 29 ngày trước; hai kỳ này hiển thị trung bình mỗi ngày. Toàn bộ lịch sử giữ nguyên dữ liệu và hiển thị trung bình theo số tháng lịch từ event đầu tiên đến hiện tại, kể cả tháng không phát sinh usage. Session/turn được chọn nếu có event trong kỳ hoặc metadata/start trong kỳ; duration là tổng turn có start/end được ghi nhận (không tính thời gian chờ). Usage records là số generation record quan sát được, không phải số HTTP request hoặc retry thực tế. Giá API-equivalent chỉ ước tính theo catalog clone, cache đã nằm trong input, reasoning đã nằm trong output; giá được giữ theo event, thiếu giá không coi là miễn phí. Chi tiết session dùng toàn bộ lịch sử turn và 200 usage event mới nhất. Context spike so input từng usage record trong cùng session/model: ≥50k và >2 lần record trước. Dashboard hiển thị tối đa 20 cảnh báo gần nhất cùng chuỗi input và link session; chi tiết session cũng dùng cùng detector. Record trước có thể nằm ngoài khoảng thời gian đã lọc. Đây là chỉ báo để kiểm tra, không kết luận lãng phí hay nguyên nhân.

API đọc (cùng chính sách Host/Origin/Bearer):

- `GET /api/native/overview?range=today|yesterday|7d|30d|all&group=day|week|month&page=1&source=...&project=...&model=...`
- `GET /api/native/sessions/:id`

Log/schema Codex là dữ liệu nội bộ có thể thay đổi theo version. Collector báo lỗi riêng và giữ dữ liệu cũ; state DB thiếu/khác schema vẫn thử đọc JSONL. Không chỉnh sửa database hoặc transcript gốc của Codex.

### Chỉ số hiệu quả context

- **Cache hit rate** = tổng cached input / tổng input trong bộ lọc; input bằng 0 hiển thị `—`. Có trên card token native và phần phân bổ token gateway.
- **Tokens / turn** = tổng input + output của các record gắn turn / số turn khác nhau có usage. Turn thiếu usage và record chưa gắn turn không tham gia bình quân; tổng token vẫn giữ mọi usage đã ghi nhận.
- **Theo project** thêm tokens/turn và USD/session. Cost/session chỉ tính các session có đủ giá cho mọi record trong bộ lọc; hiển thị số session đủ giá / tổng session có usage, tránh xem dữ liệu thiếu là miễn phí.
- **Theo model** thêm số session có usage và average tokens/turn. Session/turn dùng nhiều model có thể thuộc nhiều hàng; không cộng số session giữa các model để lấy tổng.

Các số bình quân phản ánh usage trong bộ lọc thời gian/model/nguồn/project, không phải toàn bộ lifetime của session nếu đã chọn một khoảng thời gian ngắn.

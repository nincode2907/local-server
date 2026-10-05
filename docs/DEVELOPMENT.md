# Phát triển và vận hành local

Nguồn chuẩn cho lệnh chạy và các giới hạn vận hành. Bản trực quan:
[DEVELOPMENT.html](DEVELOPMENT.html). Kiến trúc và ranh giới dữ liệu:
[TECHNICAL.md](TECHNICAL.md). API và công thức thống kê: [README](../README.md).

## Runtime và lệnh

Chạy từ thư mục repo. `.nvmrc` chọn Node 24; `package.json` yêu cầu Node
22.13+. SQLite dùng `node:sqlite` tích hợp, không cần database server riêng.

```bash
nvm use
node -v
npm -v
which node
which npm
npm ci
npm run build
npm start
```

Nếu npm báo `current.node` là 16 dù nvm đã chọn 24, kiểm tra PATH, alias và
executable thực tế; với zsh chạy `rehash` rồi kiểm tra lại. Không sửa TypeScript
hay bỏ kiểm tra engines để né runtime sai.

| Mục đích | Lệnh | Ghi chú |
| --- | --- | --- |
| Phát triển | `npm run dev` | Watch TypeScript; giữ terminal và log |
| Kiểm tra kiểu | `npm run check` | Không xuất file |
| Build | `npm run build` | Xuất vào `dist/` |
| Chạy foreground | `npm start` | Ctrl+C dừng server |
| Chạy nền theo yêu cầu | `npm start --silent -- -d` | Trả prompt; bỏ output server |
| Dừng tiến trình nền | `npm stop` | Đọc `.local/server.pid`; xác minh process bằng `ps` |
| Test tự động | `npm test` | Fixtures/mocks; chọn phạm vi theo thay đổi |
| Smoke thật | `npm run test:live` | Gọi Codex thật, tiêu thụ hạn mức |

`-d` phải nằm sau `--`, vì `npm start -d` bật loglevel của npm. `--silent`
ẩn banner npm. `scripts/start.js` dùng cùng Node executable với wrapper;
PID được ghi lúc spawn, chưa phải xác nhận HTTP sẵn sàng. Kiểm tra `/health`
sau khi chạy nền; lỗi khởi động không hiện khi output bị bỏ qua. Chế độ
foreground phù hợp để chẩn đoán. `npm stop` dùng `ps`, là cơ chế hiện tại
cho macOS/Linux; không coi lệnh dừng nền này là đã hỗ trợ Windows.

Agent giữ development server trong terminal có thể quan sát. Chế độ chạy nền
là tùy chọn người dùng đã yêu cầu. Khi agent khởi động server, chỉ công bố URL
sau khi listen thành công; chỉ công bố proxy URL nếu route đã được xác minh.

## Cấu hình và dữ liệu

`src/config.ts` là nguồn chuẩn của defaults; `.env.example` là ví dụ cấu hình.
Runtime mặc định dùng `gpt-6-luna` và `low`; `.env` hoặc body request có thể
ghi đè. `.env` trên máy này đã cấu hình `gpt-6.1-sol` / `medium` tại thời điểm
bootstrap, vì vậy dashboard đang chạy có thể khác defaults trong source.

Không in toàn bộ `.env` hay file auth khi kiểm tra. Đăng nhập tương tác bằng
`./node_modules/.bin/codex login`; `login status` dùng để kiểm tra auth.

| Dữ liệu | Vị trí | Quy tắc |
| --- | --- | --- |
| Gateway messages | `DATA_DIR/sessions.json` | Có nội dung chat; một process mỗi DATA_DIR |
| Metrics/native usage | `STATS_DB_PATH` hoặc `DATA_DIR/stats.sqlite` | Metadata/usage và snapshot giá; không lưu transcript |
| Nguồn Codex | `NATIVE_CODEX_HOME`, `CODEX_HOME`, rồi `~/.codex` | Chỉ đọc state/rollout; không tự sync Mac ↔ Windows |
| Playground | Bộ nhớ tab | Reload xóa context; CLI chạy ephemeral |

Đổi assets `public/dashboard.*` cần restart vì server đọc chúng khi đăng ký
routes. Không tự dừng listener đang chạy; xác định PID, command và request
đang hoạt động trước khi restart. `/health` chỉ xác nhận HTTP, không xác nhận
hạn mức hoặc quyền model của tài khoản. Nếu bật `LOCAL_API_KEY`, health cũng
cần Bearer token; không đưa token vào tài liệu hay URL.

## Port và Dev Hub

| Nguồn | Trạng thái kiểm tra ngày 05/10/2026 |
| --- | --- |
| Repo | `src/config.ts` / `.env.example`: port 4000; `src/index.ts`: bind 127.0.0.1 |
| Listener | Node của repo nghe `127.0.0.1:4000`; command dùng Node 24.21.0 |
| URL hiện tại | `http://127.0.0.1:4000/dashboard` hoặc `http://localhost:4000/dashboard` |
| Registry | `/Users/buivannin/Desktop/workspace/personal/dev-hub/projects.yml` tồn tại; chưa có entry khớp đường dẫn repo |
| Block | Chưa được cấp block trung tâm; không xem 4000 là port đã reserve |
| Proxy | Dev Hub Caddy đang chạy, có route dev/intelligence; chưa có route cho codex-server |
| Bind proxy | Docker publish `0.0.0.0:80→80`; không phải chỉ loopback. `lsof` không root thấy listener wildcard IPv6 |
| Host policy | `src/server.ts` chỉ nhận localhost/loopback; chưa nhận hostname `.localhost` của project |

Port 4000 là endpoint người dùng đã yêu cầu và đang dùng. Bootstrap giữ endpoint
này; chưa chọn block mới hoặc cấu hình một hostname giả định. Khi thực hiện
migration Dev Hub, đọc registry và conventions trước, kiểm tra toàn bộ block
cùng listener, đề xuất mapping/hostname và cách giữ tương thích cho HTTP clients.
Rà Host/Origin/Bearer và bind của proxy trước khi bật route; không mở wildcard
Host hoặc CORS để đi tắt. Xác minh HTTP IPv4/IPv6 và browser trước khi công bố
hostname hoạt động. Không thay proxy/system service ngoài phạm vi được giao.

## Kết quả bootstrap

| Phát hiện | Căn cứ | Xử lý |
| --- | --- | --- |
| Thiếu hướng dẫn agent trong repo | Không có AGENTS.md root/nested hoặc project skills | Tạo AGENTS.md; giữ tham chiếu RTK do người dùng cung cấp |
| README ghi defaults cũ | README ghi sol/medium; config và env example dùng luna/low | Sửa defaults trong README/TECHNICAL; giữ ví dụ override |
| Knowledge đã có home | README cho API/usage; TECHNICAL cho kiến trúc; data/README cho giá | Dùng routing; không sao chép thành project skill mới |
| Thiếu hướng dẫn runtime tập trung | Commands nằm ở manifest/README; đã gặp lệch Node/npm | Tạo DEVELOPMENT.md/HTML, gồm process management và chẩn đoán |
| HTML kiến trúc thiếu favicon | docs/architecture.html chưa có rel=icon | Tái dùng public/favicon.svg |
| Dev Hub chưa quản lý repo | Registry và Caddyfile không có entry/route | Ghi trạng thái; migration block/hostname còn chờ |

Không có AGENTS.md lớn để chia hoặc xóa nội dung. Giữ toàn bộ README,
TECHNICAL và sơ đồ hiện có; không tạo bản sao quy trình global. Global skills
có thể tái dùng: `feature-builder` khi thêm feature, `task-qa-review` khi review
task, `security-review` khi audit bảo mật. Không tạo project skill mới nên không
có skill mới cần validator.

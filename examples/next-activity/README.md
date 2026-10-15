# Next.js BFF integration

1. Build/install hai package trong `clients/` theo README của `react-activity-panel`.
2. Copy `route.ts` vào `app/api/ai/runs/[id]/[[...action]]/route.ts` và copy/điều chỉnh
   import `authorization.ts`. Kết nối `canAccessRun` với session và DB của ứng dụng;
   ví dụ mặc định từ chối mọi request cho đến khi tích hợp ownership.
3. Backend ứng dụng tạo run bằng `POST /v1/runs`, lưu run_id cùng user đang đăng nhập
   rồi trả run_id cho UI. Chỉ server giữ `CODEX_APP_API_KEY` (key app, không phải admin).
4. Cấu hình server-only `CODEX_GATEWAY_URL=http://127.0.0.1:15600` hoặc
   `http://host.docker.internal:15600` từ container. Không dùng tiền tố `NEXT_PUBLIC_`.
5. Render `AIActivityPanel` với transport `{baseUrl:'/api/ai',runPath:'/runs'}`.

Gateway key chỉ định danh cả ứng dụng. BFF phải kiểm tra quyền từng user trên mỗi
snapshot, SSE, reconnect và cancel. Không tin run ID bí mật là đủ bảo vệ dữ liệu.
Route ví dụ chỉ forward snapshot/events/cancel, body cancel cố định, không nhận URL
upstream từ client; giữ response SSE streaming và AbortSignal. Hạ tầng BFF/proxy cần
tắt buffering, cho phép kết nối dài và có giới hạn subscriber riêng của ứng dụng.

Workflow updates do backend ứng dụng gửi trực tiếp bằng app key; không mở proxy
workflow arbitrary cho browser. Xem [contract workflow](../../docs/STREAMING.md).

Đây là file tích hợp cho Next.js đang có, không tạo thêm một Next server/dependency
trong gateway. API route đối chiếu [Next.js Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route).

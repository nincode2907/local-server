# @codex-local/activity-client

Client ESM thuần JavaScript, kèm TypeScript declarations, không phụ thuộc DOM hay React.
Dashboard vanilla và `AIActivityPanel` dùng chung transport, reducer và chart samples.

```ts
import {createActivityClient} from '@codex-local/activity-client';
const transport = createActivityClient({baseUrl:'/api/ai',runPath:'/runs'});
const controller = new AbortController();
await transport.watchRun(runId, {
  signal:controller.signal,
  followWorkflow:true,
  onState:state => console.log(state.run?.status),
  onConnection:status => console.log(status),
});
// Khi rời trang: controller.abort(). Việc này chỉ dừng viewer.
```

- `getRun`, `cancel`, `watchRun`, `watchFeed`, `readEvents`; injectable `fetch` và async `headers`.
- Fetch SSE gửi `Last-Event-ID`, retry khi đứt kết nối, tải lại metadata khi cursor reset.
- Output replay được dedup riêng với snapshot sequence. Replay hết hạn hiển thị partial;
  không dựng lại body từ numeric samples.
- `followWorkflow` mặc định true: tiếp tục theo dõi workflow sau inference, kể cả workflow
  chưa bắt đầu. Dừng viewer bằng AbortSignal; không gọi cancel chỉ vì component unmount.
- `outputChart` vẽ step series, không nối đoạn sample bị bỏ. Token chỉ từ sample usage.
- Không lưu credential, không đặt token trong URL. Trong browser dùng BFF của ứng dụng;
  chỉ truyền headers Bearer trong môi trường server hoặc dashboard admin hiện có.

Contract/limits: [STREAMING.md](../../docs/STREAMING.md).

# AIActivityPanel

Component React 18/19 dùng chung event client với dashboard; không thêm bundler vào gateway.
Có TypeScript props, tiếng Việt/Anh, cancel, reconnect, numeric chart, timeline và workflow.

## Cài trong monorepo

```sh
npm install --prefix clients/react-activity-panel
npm run check --prefix clients/react-activity-panel
npm run build --prefix clients/react-activity-panel
# Trong ứng dụng đích: cài cả hai package từ đường dẫn local tương ứng.
npm install /path/to/codex-server/clients/activity-client /path/to/codex-server/clients/react-activity-panel
```

Dependency local `file:../activity-client` dành cho checkout này. Khi publish, đổi dependency
thành version registry tương ứng và publish client trước. Không commit node_modules/dist.

```tsx
'use client';
import {useMemo} from 'react';
import {AIActivityPanel} from '@codex-local/react-activity-panel';
import {createActivityClient} from '@codex-local/activity-client';
import '@codex-local/react-activity-panel/styles.css';

export default function Activity({runId}:{runId:string}) {
  const transport = useMemo(() => createActivityClient({baseUrl:'/api/ai',runPath:'/runs'}), []);
  return <AIActivityPanel runId={runId} transport={transport} locale="vi"
    onCancel={() => console.log('Đã gửi hủy inference')}/>;
}
```

`runId`, `transport` bắt buộc. Tùy chọn: `locale`, `className`, `followWorkflow` (true),
`onState`, `onConnection`, `onCancel`. Giữ transport ổn định qua useMemo/module scope.
Đổi runId hoặc unmount sẽ abort subscription cũ. Inference và workflow có lifecycle riêng;
nút cancel chỉ hủy inference. Không nhúng gateway key trong browser bundle.

Ví dụ BFF Next.js: [examples/next-activity](../../examples/next-activity/README.md).
Fixture React chạy thật trên browser: `npm run preview:activity`, rồi
`npm run preview:react` trong terminal khác (sau build package). Không gọi Codex thật.

React effect lifecycle: [React useEffect](https://react.dev/reference/react/useEffect).

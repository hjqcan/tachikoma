# @tachikoma/gateway

Tachikoma API 网关 - 提供 HTTP 服务、安全中间件、身份认证。

## 安装

```bash
bun add @tachikoma/gateway
```

## 功能

- 🌐 基于 Hono 的高性能 HTTP 服务
- 🔐 身份认证（JWT/OAuth2）
- 🛡️ 安全中间件（输入/输出过滤）
- 📊 分布式追踪（OpenTelemetry）

## 使用

```typescript
import { createServer } from '@tachikoma/gateway';

const app = createServer();

Bun.serve({
  fetch: app.fetch,
  port: 3000,
});
```

## 开发

```bash
# 开发模式
bun run dev

# 启动服务
bun run start

# 运行测试
bun test
```

## API 端点

| 端点           | 方法 | 描述       |
| -------------- | ---- | ---------- |
| `/health`      | GET  | 健康检查   |
| `/api/tasks`   | GET  | 任务列表   |
| `/api/agents`  | GET  | 智能体列表 |
| `/api/execute` | POST | 执行任务   |

## 许可证

MIT

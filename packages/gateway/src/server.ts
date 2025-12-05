/**
 * Tachikoma Gateway Server
 *
 * 基于 Hono 的 HTTP 服务实现
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

/**
 * 创建 Hono 应用实例
 */
export function createServer() {
  const app = new Hono();

  // 基础中间件
  app.use('*', logger());
  app.use('*', cors());

  // 健康检查
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    });
  });

  // API 路由占位
  app.get('/api/tasks', (c) => {
    return c.json({ message: 'Tasks API - TODO' });
  });

  app.get('/api/agents', (c) => {
    return c.json({ message: 'Agents API - TODO' });
  });

  app.post('/api/execute', (c) => {
    return c.json({ message: 'Execute API - TODO' });
  });

  // 404 处理
  app.notFound((c) => {
    return c.json({ error: 'Not Found' }, 404);
  });

  // 错误处理
  app.onError((err, c) => {
    console.error('Server error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}

// 如果直接运行此文件，启动服务器
if (import.meta.main) {
  const app = createServer();
  const port = parseInt(process.env.PORT || '3000', 10);

  console.log(`🚀 Tachikoma Gateway starting on port ${port}...`);

  Bun.serve({
    fetch: app.fetch,
    port,
  });

  console.log(`✅ Server running at http://localhost:${port}`);
}

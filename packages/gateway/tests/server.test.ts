/**
 * @tachikoma/gateway 服务器测试
 */

import { describe, expect, it } from 'bun:test';
import { createServer } from '../src/server';

// 健康检查响应类型
interface HealthResponse {
  status: string;
  version: string;
  timestamp: string;
}

// 错误响应类型
interface ErrorResponse {
  error: string;
}

describe('@tachikoma/gateway', () => {
  const app = createServer();

  describe('健康检查', () => {
    it('GET /health 应返回 200 和状态信息', async () => {
      const res = await app.request('/health');

      expect(res.status).toBe(200);

      const body = (await res.json()) as HealthResponse;
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.1.0');
      expect(body).toHaveProperty('timestamp');
    });
  });

  describe('API 路由', () => {
    it('GET /api/tasks 应返回 200', async () => {
      const res = await app.request('/api/tasks');
      expect(res.status).toBe(200);
    });

    it('GET /api/agents 应返回 200', async () => {
      const res = await app.request('/api/agents');
      expect(res.status).toBe(200);
    });

    it('POST /api/execute 应返回 200', async () => {
      const res = await app.request('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'test' }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('404 处理', () => {
    it('未知路由应返回 404', async () => {
      const res = await app.request('/unknown/route');
      expect(res.status).toBe(404);

      const body = (await res.json()) as ErrorResponse;
      expect(body.error).toBe('Not Found');
    });
  });
});

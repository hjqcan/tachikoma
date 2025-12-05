/**
 * Execute API 路由
 *
 * 代码执行相关接口
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { success, badRequest, forbidden } from '../utils/response';
import { proxyService } from '../middleware/proxy';

/**
 * 创建 Execute 路由
 */
export function createExecuteRouter() {
  const router = new Hono<AppEnv>();

  /**
   * 执行代码
   * POST /api/execute
   */
  router.post('/', async (c) => {
    const body = await c.req.json();

    // 验证必填字段
    if (!body.code && !body.command) {
      return badRequest(c, 'Either code or command is required', {
        fields: ['code', 'command'],
      });
    }

    // TODO: 实际执行实现（通过沙盒）
    const result = {
      id: crypto.randomUUID(),
      type: body.code ? 'code' : 'command',
      input: body.code || body.command,
      output: {
        stdout: 'Execution output would appear here',
        stderr: '',
        exitCode: 0,
      },
      duration: 150,
      executedAt: new Date().toISOString(),
    };

    return success(c, { result });
  });

  /**
   * 执行工具调用
   * POST /api/execute/tool
   */
  router.post('/tool', async (c) => {
    const body = await c.req.json();

    // 验证必填字段
    if (!body.tool) {
      return badRequest(c, 'Missing required field: tool', {
        field: 'tool',
      });
    }

    // TODO: 实际工具执行实现
    const result = {
      id: crypto.randomUUID(),
      tool: body.tool,
      input: body.input || {},
      output: {
        success: true,
        data: {},
      },
      duration: 100,
      executedAt: new Date().toISOString(),
    };

    return success(c, { result });
  });

  /**
   * 代理外部 API 调用
   * POST /api/execute/proxy
   */
  router.post('/proxy', async (c) => {
    const body = await c.req.json();

    // 验证必填字段
    if (!body.url) {
      return badRequest(c, 'Missing required field: url', {
        field: 'url',
      });
    }

    if (!body.method) {
      return badRequest(c, 'Missing required field: method', {
        field: 'method',
      });
    }

    // 验证 URL 是否在允许列表中
    const validation = proxyService.validate(body.url, body.method);
    if (!validation.allowed) {
      return forbidden(c, validation.reason);
    }

    // 执行代理请求
    const result = await proxyService.request(
      {
        targetUrl: body.url,
        method: body.method,
        headers: body.headers,
        body: body.body,
        timeout: body.timeout,
      },
      {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
      }
    );

    if (!result.success) {
      return c.json(
        {
          success: false,
          error: {
            code: 'PROXY_001',
            message: result.error || 'Proxy request failed',
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        502
      );
    }

    return success(c, {
      status: result.status,
      headers: result.headers,
      body: result.body,
      duration: result.duration,
    });
  });

  /**
   * 执行 MCP 请求
   * POST /api/execute/mcp
   */
  router.post('/mcp', async (c) => {
    const body = await c.req.json();

    // 验证 MCP 请求格式
    if (!body.serverUrl) {
      return badRequest(c, 'Missing required field: serverUrl', {
        field: 'serverUrl',
      });
    }

    if (!body.method) {
      return badRequest(c, 'Missing required field: method (MCP method)', {
        field: 'method',
      });
    }

    // 验证服务器 URL 是否在允许列表中
    const validation = proxyService.validate(body.serverUrl, 'POST');
    if (!validation.allowed) {
      return forbidden(c, validation.reason);
    }

    // 构造 MCP 请求
    const mcpRequest = {
      jsonrpc: '2.0' as const,
      id: body.id || crypto.randomUUID(),
      method: body.method,
      params: body.params,
    };

    // 执行 MCP 请求
    const result = await proxyService.request(
      {
        targetUrl: body.serverUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: mcpRequest,
      },
      {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
      }
    );

    if (!result.success) {
      return c.json(
        {
          jsonrpc: '2.0',
          id: mcpRequest.id,
          error: {
            code: -32603,
            message: result.error || 'MCP request failed',
          },
        },
        502
      );
    }

    return c.json(result.body);
  });

  /**
   * 获取执行历史
   * GET /api/execute/history
   */
  router.get('/history', async (c) => {
    // TODO: 实际实现
    const history = [
      {
        id: '1',
        type: 'code',
        input: 'console.log("hello")',
        status: 'success',
        executedAt: new Date().toISOString(),
      },
    ];

    return success(c, { history }, {
      pagination: { page: 1, pageSize: 10, total: 1 },
    });
  });

  /**
   * 获取执行结果
   * GET /api/execute/:id
   */
  router.get('/:id', async (c) => {
    const id = c.req.param('id');

    // TODO: 实际实现
    const execution = {
      id,
      type: 'code',
      input: 'console.log("hello")',
      output: {
        stdout: 'hello',
        stderr: '',
        exitCode: 0,
      },
      status: 'success',
      duration: 50,
      executedAt: new Date().toISOString(),
    };

    return success(c, { execution });
  });

  return router;
}

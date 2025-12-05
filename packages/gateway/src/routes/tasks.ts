/**
 * Tasks API 路由
 *
 * 任务管理相关接口
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { success, notFound, badRequest } from '../utils/response';

/**
 * 创建 Tasks 路由
 */
export function createTasksRouter() {
  const router = new Hono<AppEnv>();

  /**
   * 获取任务列表
   * GET /api/tasks
   */
  router.get('/', async (c) => {
    // TODO: 实际实现
    const tasks = [
      { id: '1', title: 'Task 1', status: 'pending' },
      { id: '2', title: 'Task 2', status: 'running' },
    ];

    return success(c, { tasks }, {
      pagination: { page: 1, pageSize: 10, total: 2 },
    });
  });

  /**
   * 获取单个任务
   * GET /api/tasks/:id
   */
  router.get('/:id', async (c) => {
    const id = c.req.param('id');

    // TODO: 实际实现
    if (id === 'not-found') {
      return notFound(c, 'Task');
    }

    const task = {
      id,
      title: `Task ${id}`,
      status: 'pending',
      description: 'Task description',
      createdAt: new Date().toISOString(),
    };

    return success(c, { task });
  });

  /**
   * 创建任务
   * POST /api/tasks
   */
  router.post('/', async (c) => {
    const body = await c.req.json();

    // TODO: 验证和实际实现
    if (!body.title) {
      return badRequest(c, 'Missing required field: title', {
        field: 'title',
      });
    }

    const task = {
      id: crypto.randomUUID(),
      title: body.title,
      description: body.description || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    return success(c, { task }, { status: 201 });
  });

  /**
   * 更新任务
   * PATCH /api/tasks/:id
   */
  router.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();

    // TODO: 实际实现
    const task = {
      id,
      ...body,
      updatedAt: new Date().toISOString(),
    };

    return success(c, { task });
  });

  /**
   * 删除任务
   * DELETE /api/tasks/:id
   */
  router.delete('/:id', async (c) => {
    const id = c.req.param('id');

    // TODO: 实际实现
    return success(c, { deleted: true, id });
  });

  return router;
}

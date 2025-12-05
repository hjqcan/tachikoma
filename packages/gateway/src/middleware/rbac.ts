/**
 * RBAC 权限控制中间件
 *
 * 实现基于角色的访问控制
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv, UserRole, ResourceType, Operation } from '../types';
import { ROLE_PERMISSIONS, ERROR_CODES } from '../config';
import { logger } from './logger';

// ============================================================================
// 权限检查函数
// ============================================================================

/**
 * 检查用户是否有权限执行操作
 */
export function hasPermission(
  roles: UserRole[],
  resource: ResourceType,
  operation: Operation
): boolean {
  for (const role of roles) {
    const permissions = ROLE_PERMISSIONS[role];
    if (!permissions) continue;

    for (const permission of permissions) {
      if (permission.resource === resource && permission.operations.includes(operation)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 获取用户对资源的所有权限
 */
export function getPermissions(roles: UserRole[], resource: ResourceType): Operation[] {
  const operations = new Set<Operation>();

  for (const role of roles) {
    const permissions = ROLE_PERMISSIONS[role];
    if (!permissions) continue;

    for (const permission of permissions) {
      if (permission.resource === resource) {
        permission.operations.forEach((op) => operations.add(op));
      }
    }
  }

  return Array.from(operations);
}

/**
 * 检查用户是否拥有任意指定角色
 */
export function hasAnyRole(userRoles: UserRole[], requiredRoles: UserRole[]): boolean {
  return requiredRoles.some((role) => userRoles.includes(role));
}

/**
 * 检查用户是否拥有所有指定角色
 */
export function hasAllRoles(userRoles: UserRole[], requiredRoles: UserRole[]): boolean {
  return requiredRoles.every((role) => userRoles.includes(role));
}

// ============================================================================
// HTTP 方法到操作的映射
// ============================================================================

/**
 * 从 HTTP 方法推断操作类型
 */
export function methodToOperation(method: string): Operation {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return 'read';
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'read';
  }
}

/**
 * 从路径推断资源类型
 */
export function pathToResource(path: string): ResourceType | null {
  const segments = path.split('/').filter(Boolean);

  // 查找 api 后面的资源名称
  const apiIndex = segments.indexOf('api');
  if (apiIndex >= 0 && segments.length > apiIndex + 1) {
    const resource = segments[apiIndex + 1];

    switch (resource) {
      case 'tasks':
        return 'tasks';
      case 'agents':
        return 'agents';
      case 'execute':
        return 'execute';
      case 'admin':
        return 'admin';
      default:
        return null;
    }
  }

  // 健康检查
  if (path === '/health' || path === '/') {
    return 'health';
  }

  return null;
}

// ============================================================================
// RBAC 中间件
// ============================================================================

/**
 * RBAC 中间件配置
 */
export interface RBACMiddlewareOptions {
  /** 默认资源（如果无法从路径推断） */
  defaultResource?: ResourceType;
  /** 默认操作（如果无法从方法推断） */
  defaultOperation?: Operation;
  /** 跳过检查的路径 */
  skipPaths?: RegExp[];
  /** 自定义权限检查函数 */
  customCheck?: (
    roles: UserRole[],
    resource: ResourceType,
    operation: Operation
  ) => boolean;
}

/**
 * 创建 RBAC 中间件
 *
 * 功能:
 * - 从路径和方法推断所需权限
 * - 检查用户角色是否有权限
 * - 返回 403 如果权限不足
 */
export function rbacMiddleware(options: RBACMiddlewareOptions = {}) {
  const {
    skipPaths = [/^\/health$/, /^\/$/],
    customCheck,
  } = options;

  return createMiddleware<AppEnv>(async (c, next) => {
    const path = c.req.path;

    // 检查是否跳过该路径
    if (skipPaths.some((pattern) => pattern.test(path))) {
      await next();
      return;
    }

    // 获取用户信息
    const user = c.get('user');

    if (!user) {
      // 如果没有用户信息，说明认证中间件没有正确执行
      // 这里应该已经被认证中间件拒绝了
      await next();
      return;
    }

    // 推断资源和操作
    const resource = pathToResource(path);
    const operation = methodToOperation(c.req.method);

    if (!resource) {
      // 无法推断资源，放行
      await next();
      return;
    }

    // 检查权限
    const checkFn = customCheck || hasPermission;
    const permitted = checkFn(user.roles, resource, operation);

    if (!permitted) {
      logger.warn('Permission denied', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
        userId: user.id,
        roles: user.roles,
        resource,
        operation,
        path,
      });

      return c.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INSUFFICIENT_PERMISSIONS,
            message: `Insufficient permissions to ${operation} ${resource}`,
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        403 as const
      );
    }

    logger.debug('Permission granted', {
      traceId: c.get('traceId'),
      requestId: c.get('requestId'),
      userId: user.id,
      resource,
      operation,
    });

    await next();
    return;
  });
}

// ============================================================================
// 路由级别权限装饰器
// ============================================================================

/**
 * 创建路由级别权限检查中间件
 *
 * 用于在特定路由上强制要求特定权限
 */
export function requirePermission(resource: ResourceType, operation: Operation) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');

    if (!user) {
      return c.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: 'Authentication required',
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        401 as const
      );
    }

    if (!hasPermission(user.roles, resource, operation)) {
      return c.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INSUFFICIENT_PERMISSIONS,
            message: `Insufficient permissions to ${operation} ${resource}`,
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        403 as const
      );
    }

    await next();
    return;
  });
}

/**
 * 创建角色检查中间件
 *
 * 用于在特定路由上要求特定角色
 */
export function requireRole(...roles: UserRole[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');

    if (!user) {
      return c.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: 'Authentication required',
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        401 as const
      );
    }

    if (!hasAnyRole(user.roles, roles)) {
      return c.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INSUFFICIENT_PERMISSIONS,
            message: `Required role: ${roles.join(' or ')}`,
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        403 as const
      );
    }

    await next();
    return;
  });
}

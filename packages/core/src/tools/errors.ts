/**
 * Tool errors shared across registry/executor.
 */

/**
 * 权限拒绝错误
 */
export class PermissionDeniedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reason: string
  ) {
    super(`工具 "${toolName}" 权限被拒绝: ${reason}`);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * 工具未找到错误
 */
export class ToolNotFoundError extends Error {
  constructor(public readonly toolName: string) {
    super(`工具未找到: ${toolName}`);
    this.name = 'ToolNotFoundError';
  }
}

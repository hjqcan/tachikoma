/**
 * 权限校验器
 * 
 * 负责验证工具权限是否符合执行上下文要求
 */

import type { Tool } from '../types';
import type { ExecutionContext } from '../types';
import { ToolPermission } from './types';

/**
 * 权限校验结果
 */
export interface PermissionValidationResult {
  /** 是否允许执行 */
  allowed: boolean;
  /** 拒绝原因（如果不允许） */
  reason?: string;
  /** 是否需要强制沙盒执行 */
  requiresSandbox: boolean;
}

/**
 * 权限校验器类
 * 
 * 提供细粒度的权限验证逻辑
 */
export class PermissionValidator {
  /**
   * 高风险权限列表
   * 
   * 这些权限的工具必须在沙盒中执行
   */
  private static readonly DANGEROUS_PERMISSIONS = [
    ToolPermission.FileSystemDelete,
    ToolPermission.ShellExec,
    ToolPermission.ProcessSpawn,
  ];

  /**
   * 验证工具权限
   * 
   * @param tool - 要验证的工具
   * @param context - 执行上下文
   * @returns 验证结果
   * 
   * **默认策略**:
   * - 工具未声明权限 → 视为"无特殊权限要求"，允许执行
   * - 上下文未提供权限配置 → 使用宽松策略，允许执行（生产环境应提供）
   * - 明确拒绝优先于允许
   */
  validate(tool: Tool, context: ExecutionContext): PermissionValidationResult {
    // 1. 检查工具权限是否在拒绝列表中
    const deniedPermissions = this.findDeniedPermissions(tool, context);
    if (deniedPermissions.length > 0) {
      return {
        allowed: false,
        reason: `工具需要被拒绝的权限: ${deniedPermissions.join(', ')}`,
        requiresSandbox: false,
      };
    }

    // 2. 检查工具权限是否在允许列表中
    const missingPermissions = this.findMissingPermissions(tool, context);
    if (missingPermissions.length > 0) {
      return {
        allowed: false,
        reason: `工具缺少必需权限: ${missingPermissions.join(', ')}`,
        requiresSandbox: false,
      };
    }

    // 3. 检查是否需要沙盒执行
    const requiresSandbox = this.requiresSandbox(tool, context);

    // 4. 如果需要沙盒但上下文不提供，拒绝执行
    if (requiresSandbox && !context.sandboxId) {
      return {
        allowed: false,
        reason: '工具需要沙盒执行，但当前上下文未提供沙盒',
        requiresSandbox: true,
      };
    }

    // 5. 验证通过
    return {
      allowed: true,
      requiresSandbox,
    };
  }

  /**
   * 查找被拒绝的权限
   * 
   * @param tool - 工具
   * @param context - 执行上下文
   * @returns 被拒绝的权限列表
   */
  private findDeniedPermissions(tool: Tool, context: ExecutionContext): string[] {
    const toolPermissions = tool.permissions || [];
    const deniedList = context.permissions?.denied || [];
    return toolPermissions.filter((permission) => deniedList.includes(permission));
  }

  /**
   * 查找缺失的权限
   * 
   * @param tool - 工具
   * @param context - 执行上下文
   * @returns 缺失的权限列表
   */
  private findMissingPermissions(tool: Tool, context: ExecutionContext): string[] {
    const toolPermissions = tool.permissions || [];
    const allowedList = context.permissions?.allowed || [];
    
    // 如果上下文未配置允许列表（空数组），采用宽松策略：不检查缺失
    if (allowedList.length === 0) {
      return [];
    }
    
    return toolPermissions.filter((permission) => !allowedList.includes(permission));
  }

  /**
   * 判断工具是否需要沙盒执行
   * 
   * @param tool - 工具
   * @param context - 执行上下文
   * @returns 是否需要沙盒
   */
  requiresSandbox(tool: Tool, context: ExecutionContext): boolean {
    // 1. 上下文强制要求沙盒
    if (context.permissions?.requireSandbox) {
      return true;
    }

    // 2. 工具声明了高风险权限
    const toolPermissions = tool.permissions || [];
    const hasDangerousPermission = toolPermissions.some((permission) =>
      PermissionValidator.DANGEROUS_PERMISSIONS.includes(permission as ToolPermission)
    );

    if (hasDangerousPermission) {
      return true;
    }

    // 3. 工具明确标记为命令型（向后兼容）
    if (tool.isCommandBased) {
      return true;
    }

    return false;
  }

  /**
   * 验证资源限制
   * 
   * @param requestedSize - 请求的资源大小
   * @param limit - 资源限制
   * @param resourceName - 资源名称（用于错误消息）
   * @returns 验证结果
   */
  validateResourceLimit(
    requestedSize: number,
    limit: number,
    resourceName: string
  ): PermissionValidationResult {
    if (requestedSize > limit) {
      return {
        allowed: false,
        reason: `${resourceName}超过限制: 请求${requestedSize}字节，限制${limit}字节`,
        requiresSandbox: false,
      };
    }

    return {
      allowed: true,
      requiresSandbox: false,
    };
  }
}

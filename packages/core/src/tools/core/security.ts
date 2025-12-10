/**
 * 安全工具函数
 *
 * 提供白名单检查、危险脚本检测等共享安全逻辑
 */

// ============================================================================
// 环境变量白名单
// ============================================================================

/**
 * 默认允许读取的环境变量白名单
 *
 * 设计原则：
 * - 只包含非敏感的系统/运行时变量
 * - 不包含 API Key、凭证等敏感信息
 * - 可通过配置扩展
 */
export const DEFAULT_ENV_WHITELIST = new Set([
  // 运行时环境
  'NODE_ENV',
  'BUN_ENV',

  // 路径相关
  'PATH',
  'HOME',
  'PWD',
  'TMPDIR',

  // 语言/区域
  'LANG',
  'LC_ALL',
  'LC_CTYPE',

  // Shell/终端
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',

  // Node.js 相关
  'NODE_OPTIONS',
  'NODE_PATH',

  // 编辑器
  'EDITOR',
  'VISUAL',
]);

/**
 * 检查环境变量是否在白名单中
 *
 * @param name - 环境变量名称
 * @param whitelist - 自定义白名单（可选）
 * @returns 是否允许读取
 */
export function isEnvAllowed(
  name: string,
  whitelist: Set<string> = DEFAULT_ENV_WHITELIST
): boolean {
  return whitelist.has(name);
}

/**
 * 批量过滤环境变量请求
 *
 * @param names - 请求的环境变量名称列表
 * @param whitelist - 自定义白名单（可选）
 * @returns 分类结果：allowed（允许的）、denied（被拒绝的）
 */
export function filterEnvRequests(
  names: string[],
  whitelist: Set<string> = DEFAULT_ENV_WHITELIST
): { allowed: string[]; denied: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];

  for (const name of names) {
    if (isEnvAllowed(name, whitelist)) {
      allowed.push(name);
    } else {
      denied.push(name);
    }
  }

  return { allowed, denied };
}

// ============================================================================
// 危险脚本检测
// ============================================================================

/**
 * 危险脚本名称模式
 *
 * 这些脚本通常用于安装时执行，可能存在安全风险
 */
export const DANGEROUS_SCRIPT_PATTERNS = [
  /^(pre|post)?install$/i,
  /^(pre|post)?uninstall$/i,
  /^prepare$/i,
  /^prepublish$/i,
  /^postpublish$/i,
];

/**
 * 检查脚本名称是否危险
 *
 * @param scriptName - 脚本名称
 * @returns 是否为危险脚本
 */
export function isDangerousScript(scriptName: string): boolean {
  return DANGEROUS_SCRIPT_PATTERNS.some((pattern) => pattern.test(scriptName));
}

// ============================================================================
// 输出截断工具
// ============================================================================

import { DEFAULT_MAX_OUTPUT } from './utils';

// 重新导出常量（从 utils.ts 统一来源）
export { DEFAULT_MAX_OUTPUT };

/**
 * 截断输出并添加提示
 *
 * @param output - 原始输出
 * @param maxLength - 最大长度
 * @returns 截断后的输出（包含截断提示）
 */
export function truncateWithNotice(
  output: string,
  maxLength: number = DEFAULT_MAX_OUTPUT
): { content: string; truncated: boolean } {
  if (output.length <= maxLength) {
    return { content: output, truncated: false };
  }

  const truncated = output.slice(0, maxLength);
  const notice = `\n\n... [Output truncated. Total length: ${output.length} chars, showing first ${maxLength}]`;

  return {
    content: truncated + notice,
    truncated: true,
  };
}

// ============================================================================
// 包管理器检测
// ============================================================================

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageManager } from '../types';

/**
 * 检测项目使用的包管理器
 *
 * 通过锁文件存在性判断
 *
 * @param projectPath - 项目路径
 * @returns 检测到的包管理器
 */
export function detectPackageManager(projectPath: string): PackageManager {
  // 按优先级检测
  if (existsSync(join(projectPath, 'bun.lock')) || existsSync(join(projectPath, 'bun.lockb'))) {
    return 'bun';
  }
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(projectPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(projectPath, 'package-lock.json'))) {
    return 'npm';
  }

  return 'unknown';
}

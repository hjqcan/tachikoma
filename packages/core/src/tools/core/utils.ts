/**
 * 工具共享工具函数
 *
 * 提供路径验证、输出截断等通用功能
 */

import { stat, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute, relative } from 'node:path';

// =============================================================================
// 常量配置
// =============================================================================

/** 默认最大输出长度（字符） */
export const DEFAULT_MAX_OUTPUT = 50000;

/** 二进制文件扩展名 */
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.woff', '.woff2', '.ttf', '.eot',
  '.bin', '.dat',
]);

// =============================================================================
// 路径工具
// =============================================================================

/**
 * 确保工作目录存在
 */
export async function ensureWorkDir(workDir: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const absolutePath = resolve(workDir);

    // 检查是否存在
    try {
      const workDirStat = await stat(absolutePath);
      if (!workDirStat.isDirectory()) {
        return {
          valid: false,
          error: `workDir is not a directory: ${workDir}`,
        };
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // 工作目录不存在，尝试创建
        await mkdir(absolutePath, { recursive: true });
      } else {
        return {
          valid: false,
          error: `Cannot access workDir: ${err.message}`,
        };
      }
    }

    return { valid: true };
  } catch (error) {
    const err = error as Error;
    return {
      valid: false,
      error: `workDir validation failed: ${err.message}`,
    };
  }
}

/**
 * 验证路径安全性（必须在工作目录内）
 */
export function validatePath(filePath: string, workDir: string): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(workDir, filePath);
  const normalizedWorkDir = resolve(workDir);
  const rel = relative(normalizedWorkDir, absolutePath);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escape attempt: ${filePath} is outside workdir`);
  }

  return absolutePath;
}

// =============================================================================
// 输出工具
// =============================================================================

/**
 * 截断输出内容
 *
 * @param content - 原始内容
 * @param maxLength - 最大长度
 * @returns 截断后的内容（如果截断，会附加提示）
 */
export function truncateOutput(content: string, maxLength = DEFAULT_MAX_OUTPUT): string {
  if (content.length <= maxLength) {
    return content;
  }

  const truncated = content.substring(0, maxLength);
  const remaining = content.length - maxLength;
  return `${truncated}\n\n... [截断: ${remaining} 字符未显示，原始长度 ${content.length} 字符]`;
}

// =============================================================================
// 文件工具
// =============================================================================

/**
 * 判断文件是否为二进制
 */
export function isBinaryFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * 判断内容是否可能是二进制
 *
 * 检查前 8KB 中是否包含空字节
 */
export function isBinaryContent(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

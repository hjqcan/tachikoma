/**
 * 工作区路径守卫（螺旋第二圈：工具的产品策略层）
 *
 * pi 拥有唯一的模型-工具循环；Tachikoma 不重造执行器，只在 pi 的 `tool_call`
 * 扩展钩子上强制路径边界：工具参数里的路径必须落在 canonical 工作区根之内，
 * 已存在路径还要求 realpath 后仍在根内（封 symlink 逃逸）。越界即
 * `{block, reason}`，模型收到错误 tool_result 自行调整。
 */

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** 第二圈 v1 启用的只读工具集（pi createReadOnlyTools 同集） */
export const WORKSPACE_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];

/** 工具入参中按路径语义解释的字段名（pattern 等匹配串不在其列） */
const PATH_INPUT_FIELDS = [
  'path',
  'file',
  'filePath',
  'dir',
  'directory',
  'filename',
  'target',
] as const;

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * 返回第一个越界的入参值；无越界返回 null。
 * root 必须已是 canonical（realpath 过的）绝对路径。
 */
export function findWorkspaceViolation(input: unknown, root: string): string | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  for (const field of PATH_INPUT_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    const resolved = resolve(root, value);
    if (!isInside(resolved, root)) {
      return value;
    }
    try {
      if (!isInside(realpathSync(resolved), root)) {
        return value;
      }
    } catch {
      // 路径不存在：字面前缀检查已通过，交给工具自身报"不存在"。
    }
  }
  return null;
}

export function createWorkspaceGuardExtension(root: string): InlineExtension {
  return {
    name: 'tachikoma-workspace-guard',
    hidden: true,
    factory(pi) {
      pi.on('tool_call', (event) => {
        const violation = findWorkspaceViolation(event.input, root);
        if (violation) {
          return {
            block: true,
            reason: `Path is outside the workspace: ${violation} (workspace root: ${root})`,
          };
        }
        return undefined;
      });
    },
  };
}

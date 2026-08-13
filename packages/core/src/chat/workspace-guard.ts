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

/** 只读工具集（pi createReadOnlyTools 同集），免审批 */
export const WORKSPACE_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];

/** 逐调用审批的工具；bash 无法做路径分析，审批本身就是它的控制面 */
export const APPROVAL_REQUIRED_TOOLS: readonly string[] = ['write', 'edit', 'bash'];

/** toolset: 'coding' 的完整允许集 */
export const CODING_TOOLS: readonly string[] = [...WORKSPACE_TOOLS, ...APPROVAL_REQUIRED_TOOLS];

/**
 * bash 超时策略（秒）：模型未传 timeout 时兜底 120s；显式传值钳到 600s 上限。
 * 在 tool_call 钩子里原位改参（pi 官方语义），先于审批——审批卡展示的即实际执行值。
 */
export const BASH_DEFAULT_TIMEOUT_SECS = 120;
export const BASH_MAX_TIMEOUT_SECS = 600;

/**
 * ChatSession 与策略扩展之间的审批桥。
 * 每回合由 ChatSession 挂上 request；缺席（无在途回合等异常态）一律拒绝。
 */
export interface ToolApprovalBridge {
  request?: (input: { callId: string; tool: string; input: unknown }) => Promise<boolean>;
}

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

function isInsideAny(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(candidate, root));
}

/**
 * 返回第一个越界的入参值；无越界返回 null。
 * roots 必须已是 canonical（realpath 过的）绝对路径；相对路径对第一个根
 * （工作区根 = 会话 cwd）解析，落在任一根内即通过。
 */
export function findWorkspaceViolation(
  input: unknown,
  roots: string | readonly string[]
): string | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const rootList = typeof roots === 'string' ? [roots] : roots;
  const primaryRoot = rootList[0];
  if (primaryRoot === undefined) {
    throw new Error('findWorkspaceViolation requires at least one root.');
  }
  for (const field of PATH_INPUT_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    const resolved = resolve(primaryRoot, value);
    if (!isInsideAny(resolved, rootList)) {
      return value;
    }
    try {
      if (!isInsideAny(realpathSync(resolved), rootList)) {
        return value;
      }
    } catch {
      // 路径不存在：字面前缀检查已通过，交给工具自身报"不存在"。
    }
  }
  return null;
}

/** 路径必须落在工作区根内才可写的工具；只读根对它们不生效 */
const WRITE_PATH_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

export function createWorkspaceGuardExtension(
  root: string,
  options: {
    approvalRequired?: ReadonlySet<string>;
    approvalBridge?: ToolApprovalBridge;
    /** 额外只读根（如 skill 授予目录）：read/grep/find/ls 可读，write/edit 仍拒 */
    readOnlyRoots?: readonly string[];
  } = {}
): InlineExtension {
  const approvalRequired = options.approvalRequired ?? new Set<string>();
  const readRoots: readonly string[] = [root, ...(options.readOnlyRoots ?? [])];
  return {
    name: 'tachikoma-workspace-guard',
    hidden: true,
    factory(pi) {
      pi.on('tool_call', async (event) => {
        // bash 超时钳制先于一切：审批者看到的就是将要执行的值。
        if (event.toolName === 'bash') {
          const input = event.input as { timeout?: number };
          input.timeout =
            typeof input.timeout === 'number' && Number.isFinite(input.timeout)
              ? Math.min(Math.max(input.timeout, 1), BASH_MAX_TIMEOUT_SECS)
              : BASH_DEFAULT_TIMEOUT_SECS;
        }
        // 路径边界先于审批：越界调用即使被批准也不执行。
        const roots = WRITE_PATH_TOOLS.has(event.toolName) ? root : readRoots;
        const violation = findWorkspaceViolation(event.input, roots);
        if (violation) {
          return {
            block: true,
            reason: `Path is outside the workspace: ${violation} (workspace root: ${root})`,
          };
        }
        if (approvalRequired.has(event.toolName)) {
          const approved =
            (await options.approvalBridge?.request?.({
              callId: event.toolCallId,
              tool: event.toolName,
              input: event.input,
            })) ?? false;
          if (!approved) {
            return {
              block: true,
              reason: `Tool call was not approved: ${event.toolName}`,
            };
          }
        }
        return undefined;
      });
    },
  };
}

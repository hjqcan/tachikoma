/**
 * Skill 执行器
 *
 * 通过 Sandbox 执行 Skill 脚本
 *
 * @module skills/executor
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SkillContent, SkillExecutionOptions, SkillExecutionResult } from './types';
import type { Sandbox, CommandResult } from '../types';

// ============================================================================
// 执行器
// ============================================================================

/**
 * 执行 Skill 脚本
 *
 * 在 Sandbox 中执行 Skill 附带的脚本
 *
 * @param options - 执行选项
 * @param sandbox - Sandbox 实例
 * @returns 执行结果
 *
 * @example
 * ```typescript
 * const result = await executeSkillScript({
 *   skill: skillContent,
 *   script: 'scripts/document.py',
 *   args: ['--input', 'file.docx'],
 * }, sandbox);
 * ```
 */
export async function executeSkillScript(
  options: SkillExecutionOptions,
  sandbox: Sandbox
): Promise<SkillExecutionResult> {
  const { skill, script, args = [], env = {} } = options;

  // 验证 skill 有 scripts 目录
  if (!skill.scriptsDir) {
    return {
      success: false,
      stdout: '',
      stderr: `Skill '${skill.name}' does not have a scripts directory`,
      exitCode: 1,
      duration: 0,
    };
  }

  // 构建脚本路径
  const skillDir = path.dirname(skill.path);
  const scriptPath = path.resolve(skillDir, script);

  // 安全检查：防止目录穿越攻击
  const realSkillDir = fs.realpathSync(skillDir);
  let realScriptPath: string;
  try {
    realScriptPath = fs.realpathSync(scriptPath);
  } catch {
    return {
      success: false,
      stdout: '',
      stderr: `Script not found: ${script}`,
      exitCode: 1,
      duration: 0,
    };
  }

  if (!realScriptPath.startsWith(realSkillDir)) {
    return {
      success: false,
      stdout: '',
      stderr: `Security error: script path '${script}' escapes skill directory`,
      exitCode: 1,
      duration: 0,
    };
  }

  // 根据脚本扩展名选择执行方式
  const ext = path.extname(script).toLowerCase();
  const command = buildCommand(realScriptPath, ext, args, realSkillDir, env);

  const startTime = Date.now();

  try {
    const result: CommandResult = await sandbox.runCommand(command);

    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * 构建执行命令
 *
 * 根据脚本类型构建合适的命令
 */
function buildCommand(
  scriptPath: string,
  ext: string,
  args: string[],
  skillDir: string,
  env: Record<string, string>
): string {
  const escapedArgs = args.map(escapeShellArg).join(' ');
  const escapedScriptPath = escapeShellArg(scriptPath);
  const escapedSkillDir = escapeShellArg(skillDir);

  // 环境变量前缀（使用单引号防止展开）
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${escapeShellArg(v)}`)
    .join(' ');

  switch (ext) {
    case '.py':
      // Python 脚本：使用 python3，设置 PYTHONPATH 到 skill 目录
      if (envPrefix) {
        return `PYTHONPATH=${escapedSkillDir} ${envPrefix} python3 ${escapedScriptPath} ${escapedArgs}`.trim();
      }
      return `PYTHONPATH=${escapedSkillDir} python3 ${escapedScriptPath} ${escapedArgs}`.trim();

    case '.ts':
      // TypeScript 脚本：使用 bun（不需要 run）
      if (envPrefix) {
        return `${envPrefix} bun ${escapedScriptPath} ${escapedArgs}`.trim();
      }
      return `bun ${escapedScriptPath} ${escapedArgs}`.trim();

    case '.js':
      // JavaScript 脚本：使用 node
      if (envPrefix) {
        return `${envPrefix} node ${escapedScriptPath} ${escapedArgs}`.trim();
      }
      return `node ${escapedScriptPath} ${escapedArgs}`.trim();

    case '.sh':
    case '.bash':
      // Shell 脚本
      if (envPrefix) {
        return `${envPrefix} bash ${escapedScriptPath} ${escapedArgs}`.trim();
      }
      return `bash ${escapedScriptPath} ${escapedArgs}`.trim();

    default:
      // 默认尝试直接执行
      if (envPrefix) {
        return `${envPrefix} ${escapedScriptPath} ${escapedArgs}`.trim();
      }
      return `${escapedScriptPath} ${escapedArgs}`.trim();
  }
}

/**
 * 使用单引号转义 shell 参数
 *
 * 单引号内的内容不会被 shell 展开（除了单引号本身）
 * 这比双引号更安全，避免 $、`、\ 的意外展开
 */
function escapeShellArg(arg: string): string {
  // 如果只包含安全字符，不需要引号
  if (/^[a-zA-Z0-9_./-]+$/.test(arg)) {
    return arg;
  }
  // 使用单引号包裹，内部的单引号转义为 '\''
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 检查 Skill 是否有可执行脚本
 *
 * @param skill - Skill 内容
 * @returns 是否有脚本目录
 */
export function hasExecutableScripts(skill: SkillContent): boolean {
  return !!skill.scriptsDir;
}

/**
 * 列出 Skill 的可用脚本
 *
 * @param skill - Skill 内容
 * @returns 脚本路径列表（相对于 skill 目录）
 */
export function listSkillScripts(skill: SkillContent): string[] {
  if (!skill.scriptsDir) {
    return [];
  }

  const scripts: string[] = [];

  try {
    const entries = fs.readdirSync(skill.scriptsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.py', '.ts', '.js', '.sh', '.bash'].includes(ext)) {
          scripts.push(path.join('scripts', entry.name));
        }
      }
    }
  } catch {
    // 忽略错误
  }

  return scripts;
}

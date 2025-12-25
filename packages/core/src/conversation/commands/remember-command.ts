/**
 * Remember Command Module
 *
 * /remember CLI 命令实现
 * - /remember：显示帮助（MVP 行为）
 * - /remember <content>：自动检测类型并记住指定内容
 * - /remember preference <content>：记住用户偏好
 * - /remember pattern <content>：记住工作模式
 * - /remember rule <content>：记住指导原则（写入 CoreMemory.systemPrompt）
 *
 * 存储位置：
 * - 偏好 → CoreMemory.preferences
 * - 工作模式 → CoreMemory.workPatterns
 * - 规则 → CoreMemory.systemPrompt (原则类)
 *
 * 安全：
 * - 所有内容经过 CoreMemoryEvolver 的敏感信息脱敏
 *
 * @module conversation/commands/remember-command
 */

import type { StreamEvent, SessionState } from '../types';

import {
  CoreMemoryEvolver,
  type EvolutionResult,
  type EvolutionConfig,
} from '../../agent-identity';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Remember 命令上下文
 */
export interface RememberCommandContext {
  /** 会话状态 */
  session: SessionState;
  /** 工作目录 */
  workDir: string;
  /** Agent ID（默认 'default'） */
  agentId?: string;
  /** LLM 调用函数（用于内容分析） */
  llmCall?: (prompt: string) => Promise<string>;
  /**
   * CoreMemoryEvolver 配置（用于测试或高级自定义）
   *
   * - 典型用法：在单测中把 `agentsDir` 指向临时目录，避免污染 `~/.tachikoma/agents`
   */
  evolverConfig?: EvolutionConfig;
  /** 国际化函数 */
  t: (strings: { en: string; zh: string }) => string;
}

/**
 * Remember 命令结果
 */
export interface RememberCommandResult {
  /** 是否处理了命令 */
  handled: boolean;
  /** 是否成功 */
  success?: boolean;
  /** 存储的内容 */
  content?: string | undefined;
  /** 存储类型 */
  type?: 'preference' | 'pattern' | 'principle';
}

/**
 * 内存类型
 */
export type MemoryType = 'preference' | 'pattern' | 'principle' | 'auto';

// ============================================================================
// 命令处理器
// ============================================================================

/**
 * 处理 /remember 命令
 */
export async function* executeRememberCommand(
  args: string[],
  ctx: RememberCommandContext
): AsyncGenerator<StreamEvent, RememberCommandResult> {
  const agentId = ctx.agentId ?? 'default';
  const evolver = new CoreMemoryEvolver(ctx.evolverConfig ?? {});

  // 解析子命令
  if (args.length === 0) {
    // /remember - 显示帮助
    yield* executeRememberHelp(ctx);
    return { handled: true };
  }

  const subcommand = args[0]?.toLowerCase() ?? '';

  switch (subcommand) {
    case 'preference':
    case 'pref':
      // /remember preference <content>
      return yield* executeRememberPreference(args.slice(1), ctx, evolver, agentId);

    case 'pattern':
    case 'work':
      // /remember pattern <content>
      return yield* executeRememberPattern(args.slice(1), ctx, evolver, agentId);

    case 'principle':
    case 'rule':  // alias for principle
      // /remember principle <content> - 跨项目通用原则
      return yield* executeRememberPrinciple(args.slice(1), ctx, evolver, agentId);

    case 'help':
    case '-h':
    case '--help':
      yield* executeRememberHelp(ctx);
      return { handled: true };

    default:
      // /remember <content> - 自动检测类型并存储
      return yield* executeRememberAuto(args, ctx, evolver, agentId);
  }
}

// ============================================================================
// 子命令实现
// ============================================================================

/**
 * /remember preference <content> - 记住用户偏好
 */
async function* executeRememberPreference(
  args: string[],
  ctx: RememberCommandContext,
  evolver: CoreMemoryEvolver,
  agentId: string
): AsyncGenerator<StreamEvent, RememberCommandResult> {
  if (args.length === 0) {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: '❌ Usage: /remember preference <content>\n\nExample: /remember preference Use dark mode for all UIs',
        zh: '❌ 用法：/remember preference <内容>\n\n示例：/remember preference 所有 UI 使用深色模式',
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: false };
  }

  const content = args.join(' ');
  const result = await evolver.learnPreference(content, 'remember_command', agentId);

  if (result.success) {
    yield {
      type: 'complete',
      success: true,
      summary: ctx.t({
        en: `✅ **Preference remembered:**\n\n> ${result.addedContent ?? content}\n\nThis will be applied in future conversations.`,
        zh: `✅ **已记住偏好：**\n\n> ${result.addedContent ?? content}\n\n这将在未来的对话中生效。`,
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: true, content: result.addedContent, type: 'preference' };
  } else {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: `❌ Failed to remember preference: ${result.error}`,
        zh: `❌ 记住偏好失败：${result.error}`,
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: false };
  }
}

/**
 * /remember pattern <content> - 记住工作模式
 */
async function* executeRememberPattern(
  args: string[],
  ctx: RememberCommandContext,
  evolver: CoreMemoryEvolver,
  agentId: string
): AsyncGenerator<StreamEvent, RememberCommandResult> {
  if (args.length === 0) {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: '❌ Usage: /remember pattern <content>\n\nExample: /remember pattern Always run tests before committing',
        zh: '❌ 用法：/remember pattern <内容>\n\n示例：/remember pattern 提交前始终运行测试',
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: false };
  }

  const content = args.join(' ');
  const result = await evolver.learnWorkPattern(content, 'remember_command', agentId);

  if (result.success) {
    yield {
      type: 'complete',
      success: true,
      summary: ctx.t({
        en: `✅ **Work pattern remembered:**\n\n> ${result.addedContent ?? content}\n\nI will follow this pattern in future tasks.`,
        zh: `✅ **已记住工作模式：**\n\n> ${result.addedContent ?? content}\n\n我将在未来的任务中遵循此模式。`,
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: true, content: result.addedContent, type: 'pattern' };
  } else {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: `❌ Failed to remember work pattern: ${result.error}`,
        zh: `❌ 记住工作模式失败：${result.error}`,
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: false };
  }
}

/**
 * /remember rule <content> - 记住通用原则/规则
 */
async function* executeRememberPrinciple(
  args: string[],
  ctx: RememberCommandContext,
  evolver: CoreMemoryEvolver,
  agentId: string
): AsyncGenerator<StreamEvent, RememberCommandResult> {
  if (args.length === 0) {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: '❌ Usage: /remember rule <content>\n\nExample: /remember rule Always use TypeScript for new projects',
        zh: '❌ 用法：/remember rule <内容>\n\n示例：/remember rule 新项目始终使用 TypeScript',
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: false };
  }

  const content = args.join(' ');
  const result = await evolver.evolveSystemPrompt([content], 'remember_command', agentId);

  if (result.success) {
    yield {
      type: 'complete',
      success: true,
      summary: ctx.t({
        en: `✅ **Principle remembered:**\n\n> ${result.addedContent ?? content}\n\nThis will guide my behavior in all future interactions.`,
        zh: `✅ **已记住原则：**\n\n> ${result.addedContent ?? content}\n\n这将指导我在所有未来交互中的行为。`,
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: true, content: result.addedContent, type: 'principle' };
  } else {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: `❌ Failed to remember principle: ${result.error}`,
        zh: `❌ 记住原则失败：${result.error}`,
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: false };
  }
}

/**
 * /remember <content> - 自动检测类型并存储
 */
async function* executeRememberAuto(
  args: string[],
  ctx: RememberCommandContext,
  evolver: CoreMemoryEvolver,
  agentId: string
): AsyncGenerator<StreamEvent, RememberCommandResult> {
  const content = args.join(' ');

  // 简单的类型检测规则
  const type = detectMemoryType(content);

  let result: EvolutionResult;
  let typeLabel: string;

  switch (type) {
    case 'preference':
      result = await evolver.learnPreference(content, 'remember_command', agentId);
      typeLabel = ctx.t({ en: 'Preference', zh: '偏好' });
      break;
    case 'pattern':
      result = await evolver.learnWorkPattern(content, 'remember_command', agentId);
      typeLabel = ctx.t({ en: 'Work Pattern', zh: '工作模式' });
      break;
    case 'principle':
    default:
      result = await evolver.evolveSystemPrompt([content], 'remember_command', agentId);
      typeLabel = ctx.t({ en: 'Principle', zh: '原则' });
      break;
  }

  if (result.success) {
    yield {
      type: 'complete',
      success: true,
      summary: ctx.t({
        en: `✅ **${typeLabel} remembered:**\n\n> ${result.addedContent ?? content}\n\n*Tip: Use \`/remember preference|pattern|rule <content>\` to specify the type explicitly.*`,
        zh: `✅ **已记住${typeLabel}：**\n\n> ${result.addedContent ?? content}\n\n*提示：使用 \`/remember preference|pattern|rule <内容>\` 可以明确指定类型。*`,
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: true, content: result.addedContent, type };
  } else {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: `❌ Failed to remember: ${result.error}`,
        zh: `❌ 记住失败：${result.error}`,
      }),
      timestamp: Date.now(),
    };
    return { handled: true, success: false };
  }
}

/**
 * /remember help - 显示帮助
 */
async function* executeRememberHelp(
  ctx: RememberCommandContext
): AsyncGenerator<StreamEvent> {
  yield {
    type: 'complete',
    success: true,
    summary: ctx.t({
      en: `# /remember Command

Teach me to remember something for future conversations.

## Usage

\`\`\`
/remember <content>            # Auto-detect type and remember
/remember preference <text>    # Remember a user preference
/remember pattern <text>       # Remember a work pattern
/remember principle <text>     # Remember a cross-project guiding rule
/remember help                 # Show this help
\`\`\`

**Aliases**: \`pref\` → preference, \`work\` → pattern, \`rule\` → principle

## Examples

\`\`\`
/remember Use TypeScript for all new code
/remember preference Dark mode for all UIs
/remember pattern Always run tests before committing
/remember principle Be concise in explanations
\`\`\`

## Storage

- **Preferences**: Personal settings (UI, language, style)
- **Patterns**: Workflow habits (testing, committing, reviewing)
- **Principles**: Cross-project universal rules (coding standards, best practices)

> 💡 For **project-specific rules**, use \`/remember project <text>\` (coming soon).

All remembered content is persisted and will be applied in future conversations.

> ⚠️ **Security**: Sensitive data (API keys, tokens, passwords) will be automatically redacted.`,

      zh: `# /remember 命令

让我记住一些内容，以便在未来的对话中使用。

## 用法

\`\`\`
/remember <内容>               # 自动检测类型并记住
/remember preference <内容>    # 记住用户偏好
/remember pattern <内容>       # 记住工作模式
/remember principle <内容>     # 记住跨项目通用原则
/remember help                 # 显示帮助
\`\`\`

**别名**: \`pref\` → preference, \`work\` → pattern, \`rule\` → principle

## 示例

\`\`\`
/remember 所有新代码使用 TypeScript
/remember preference 所有 UI 使用深色模式
/remember pattern 提交前始终运行测试
/remember principle 解释要简洁
\`\`\`

## 存储

- **偏好**：个人设置（UI、语言、风格）
- **模式**：工作流习惯（测试、提交、审查）
- **原则**：跨项目通用规则（编码标准、最佳实践）

> 💡 **项目特定规则**请使用 \`/remember project <内容>\`（即将推出）。

所有记住的内容都会持久化，并在未来的对话中生效。

> ⚠️ **安全**：敏感数据（API 密钥、令牌、密码）会被自动脱敏。`,
    }),
    timestamp: Date.now(),
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 检测内容类型
 *
 * 基于关键词启发式检测
 */
function detectMemoryType(content: string): 'preference' | 'pattern' | 'principle' {
  const lowerContent = content.toLowerCase();

  // 偏好指示词
  const preferenceKeywords = [
    'prefer', 'like', 'want', 'use', 'style', 'color', 'theme', 'mode',
    'font', 'language', 'format', 'display', 'show', 'hide',
    '喜欢', '偏好', '使用', '风格', '颜色', '主题', '模式', '字体', '语言', '格式',
  ];

  // 模式指示词
  const patternKeywords = [
    'always', 'before', 'after', 'first', 'then', 'when', 'workflow',
    'commit', 'test', 'review', 'deploy', 'process', 'step',
    '始终', '之前', '之后', '首先', '然后', '当', '工作流',
    '提交', '测试', '审查', '部署', '流程', '步骤',
  ];

  // 检查偏好关键词
  for (const keyword of preferenceKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'preference';
    }
  }

  // 检查模式关键词
  for (const keyword of patternKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'pattern';
    }
  }

  // 默认为原则
  return 'principle';
}

/**
 * 检查命令是否是 /remember
 */
export function isRememberCommand(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  return trimmed.startsWith('/remember') || trimmed.startsWith('/记住');
}

/**
 * 解析 /remember 命令参数
 */
export function parseRememberArgs(input: string): string[] {
  const trimmed = input.trim();
  
  // 移除命令前缀
  let rest = trimmed;
  if (rest.toLowerCase().startsWith('/remember')) {
    rest = rest.slice('/remember'.length).trim();
  } else if (rest.startsWith('/记住')) {
    rest = rest.slice('/记住'.length).trim();
  }

  if (!rest) {
    return [];
  }

  // 简单的参数分割（按空白切分；不支持引号语义）
  return rest.split(/\s+/).filter(Boolean);
}

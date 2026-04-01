# Tachikoma 提示词系统 + 工具层升级计划

> **原则**: 1:1 对齐 Claude Code，保持现有架构可运行。改造仅涉及 `packages/core/src/` 下的 prompt 和 tool 模块，不触碰 Orchestrator/Worker/ConversationalRunner 的执行逻辑。

---

## 一、提示词系统改造

### 1.1 当前状态 vs Claude Code

| 维度 | Claude Code | Tachikoma 现状 | 差距 |
|------|-----------|-------------|------|
| **组装方式** | `getSystemPrompt()` → 返回 `string[]`，7个静态段 + 缓存边界 + N个动态段 | `buildWorkerSystemPrompt()` → 返回单个 `string`，简单拼接 | 无分段缓存 |
| **缓存边界** | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 分隔静态/动态 | 无 | 无法利用 API prompt cache |
| **段落管理** | `systemPromptSection()` + `DANGEROUS_uncachedSystemPromptSection()` | 无 | 每次调用重新计算所有段落 |
| **环境信息** | 自动注入 cwd、git、platform、shell、model | 手动拼接 identity context | 缺少运行时上下文 |
| **工具引导** | `getUsingYourToolsSection()` - 根据已启用工具动态生成 | `TOOL_SELECTION_GUIDE` 硬编码工具名 | 脆弱，工具增删需手改 |
| **每工具手册** | 每个工具有 `prompt()` 方法返回独立手册 | 只有 `description` 字段（一句话） | 模型缺少工具使用指导 |

### 1.2 改造方案

#### [NEW] `packages/core/src/prompt/system-prompt/sections.ts`

从 Claude Code 的 `constants/systemPromptSections.ts` 1:1 复制段落管理系统：

```typescript
// 缓存型段落：计算一次，clear/compact 时重置
export function systemPromptSection(
  name: string,
  compute: () => string | null | Promise<string | null>,
): SystemPromptSection;

// 易变型段落：每轮重新计算（会破坏 prompt cache）
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: () => string | null | Promise<string | null>,
  reason: string,
): SystemPromptSection;

// 批量解析所有段落
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]>;

// 清除缓存（/clear 或 compact 时调用）
export function clearSystemPromptSections(): void;
```

#### [NEW] `packages/core/src/prompt/system-prompt/builder.ts`

从 Claude Code 的 `constants/prompts.ts` 1:1 复制系统提示词组装逻辑，适配 Tachikoma 工具名：

```typescript
/**
 * 缓存边界标记
 * 所有在此标记之前的内容可用 scope: 'global' 缓存
 * 所有在此标记之后的内容包含用户/会话特定数据
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

export async function getSystemPrompt(config: SystemPromptConfig): Promise<string[]> {
  return [
    // --- 静态内容（可跨会话缓存）---
    getIntroSection(),           // 身份定义 + 安全指令
    getSystemSection(),          // 系统行为规则
    getDoingTasksSection(),      // 任务执行原则（从 Claude Code 直接翻译）
    getActionsSection(),         // 执行动作注意事项（可逆性/影响范围）
    getUsingToolsSection(config.enabledTools),  // 工具使用指引（动态）
    getToneAndStyleSection(),    // 语气风格
    getOutputEfficiencySection(), // 输出效率

    // === 缓存边界 ===
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,

    // --- 动态内容（每会话/每轮变化）---
    ...resolvedDynamicSections,  // 环境、记忆、MCP、语言等
  ].filter(Boolean);
}
```

**7 个静态段落**（从 Claude Code 直接翻译，保留所有关键指令）：

| # | 段落 | Claude Code 来源 | 关键内容 |
|---|------|-----------------|---------|
| 1 | Intro | `getSimpleIntroSection()` | 身份 + 安全底线 + URL 限制 |
| 2 | System | `getSimpleSystemSection()` | 工具权限模式 + hooks + 压缩说明 |
| 3 | Doing Tasks | `getSimpleDoingTasksSection()` | **12 条核心开发原则**（先读后改、不过度工程、不虚报结果等）|
| 4 | Actions | `getActionsSection()` | **可逆性评估** - 破坏性操作列表 + 确认规则 |
| 5 | Using Tools | `getUsingYourToolsSection()` | 工具优先级（专用工具 > shell）+ 并行调用规则 |
| 6 | Tone | `getSimpleToneAndStyleSection()` | 无 emoji + 引用代码格式 |
| 7 | Output | `getOutputEfficiencySection()` | 简洁输出原则 |

**N 个动态段落**：

| 段落 | 类型 | 内容 |
|------|------|------|
| Environment | cached | cwd + git + platform + shell + model |
| Memory | cached | TACHIKOMA.md 内容 |
| Identity | cached | Agent coreMemory |
| Language | cached | 用户语言偏好 |
| MCP | uncached | MCP server instructions |
| Skills | cached | 技能推荐 |

#### [MODIFY] `packages/core/src/worker/prompts/system-prompt.ts`

保留 `buildWorkerSystemPrompt()` 作为**兼容层**，内部委托给新的 `getSystemPrompt()`：

```typescript
// 向后兼容：原有调用者不需要修改
export function buildWorkerSystemPrompt(options?: BuildWorkerOptions): string {
  // 直接调用新的 builder, 将 string[] 合并为 string
  // GenericAgentBackend 的调用链不需要改动
  const sections = await getSystemPrompt(mapToConfig(options));
  return sections.filter(Boolean).join('\n\n');
}
```

#### [DELETE] `packages/core/src/worker/prompts/behavior-guidelines.ts`

`WORKER_BEHAVIOR_GUIDELINES_EN` 会被拆解到各段落中，原文件不再需要。

---

### 1.3 文件清单

| 操作 | 文件路径 | 说明 |
|------|---------|------|
| **NEW** | `packages/core/src/prompt/system-prompt/sections.ts` | 段落管理器（缓存/易变） |
| **NEW** | `packages/core/src/prompt/system-prompt/builder.ts` | 系统提示词组装引擎 |
| **NEW** | `packages/core/src/prompt/system-prompt/static-sections.ts` | 7 个静态段落定义 |
| **NEW** | `packages/core/src/prompt/system-prompt/dynamic-sections.ts` | 动态段落定义 |
| **NEW** | `packages/core/src/prompt/system-prompt/env-info.ts` | 环境信息收集 |
| **NEW** | `packages/core/src/prompt/system-prompt/index.ts` | 模块入口 |
| **MODIFY** | `packages/core/src/worker/prompts/system-prompt.ts` | 改为兼容层 |
| **DELETE** | `packages/core/src/worker/prompts/behavior-guidelines.ts` | 内容拆解到新段落 |

---

## 二、工具层改造

### 2.1 当前状态 vs Claude Code

| 维度 | Claude Code | Tachikoma 现状 | 差距 |
|------|-----------|-------------|------|
| **工具定义** | `buildTool(def)` 工厂 + `ToolDef` 类型 | 直接对象字面量 `const tool: Tool = {...}` | 无默认值填充 |
| **安全默认** | fail-closed：`isReadOnly: false`, `isConcurrencySafe: false` | 无这些属性 | **缺少安全元数据** |
| **先读后改** | `validateInput()` 检查 `readFileState` | 无 | 模型可以直接改未读文件 |
| **工具手册** | 每个工具有 `prompt()` 方法（100-400 行独立手册） | 只有 `description`（1-5 行） | **模型缺乏工具使用指导** |
| **权限检查** | `checkPermissions()` 返回 allow/deny/ask | `permissions` 只是字符串数组声明 | 无运行时权限拦截 |
| **工具搜索** | `ToolSearchTool` + `shouldDefer` / `searchHint` | 无 | 所有工具 schema 始终暴露 |
| **maxResultSize** | 每工具声明 `maxResultSizeChars`，超限写磁盘 | `truncateOutput()` 全局截断 | 无差异化截断策略 |
| **工具别名** | `aliases: ['old_name']` | 无 | 重命名工具会 break |

### 2.2 改造方案

#### [NEW] `packages/core/src/tools/build-tool.ts`

从 Claude Code 的 `Tool.ts::buildTool()` 1:1 复制：

```typescript
/**
 * 工具安全默认值（fail-closed 设计）
 * 
 * 如果工具作者忘了声明属性，系统假设它是"不安全的、会写入的"
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,  // 默认：不可并行
  isReadOnly: (_input?: unknown) => false,          // 默认：有写入
  isDestructive: (_input?: unknown) => false,       // 默认：非破坏性
  maxResultSizeChars: 50_000,                       // 默认：50K 字符
};

export function buildTool<D extends ToolDef>(def: D): BuiltTool<D> {
  return { ...TOOL_DEFAULTS, ...def } as BuiltTool<D>;
}
```

#### [MODIFY] `packages/core/src/types.ts` — 扩展 Tool 接口

在现有 `Tool` 接口上**新增可选字段**（不破坏现有工具）：

```typescript
export interface Tool {
  // === 现有字段（保持不变） ===
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(input: unknown, context: ExecutionContext): Promise<unknown>;
  
  // === 新增：Claude Code 安全元数据（可选，有默认值） ===
  
  /** 工具别名（重命名向后兼容） */
  aliases?: string[];

  /** 是否启用 */
  isEnabled?: () => boolean;
  
  /** 是否可并行调用（default: false = 不安全） */
  isConcurrencySafe?: (input?: unknown) => boolean;
  
  /** 是否只读（default: false = 有写入） */
  isReadOnly?: (input?: unknown) => boolean;
  
  /** 是否破坏性操作（default: false） */
  isDestructive?: (input?: unknown) => boolean;
  
  /** 工具结果最大字符数（超出写磁盘） */
  maxResultSizeChars?: number;
  
  /** 搜索提示词（用于 ToolSearch 按需加载） */
  searchHint?: string;
  
  /**
   * 输入校验（在执行前调用）
   * 用于实现"先读后改"等规则
   */
  validateInput?: (
    input: unknown,
    context: ExecutionContext & { readFileState?: Set<string> },
  ) => Promise<{ result: true } | { result: false; message: string }>;
  
  /**
   * 工具使用手册（给 LLM 看的详细说明）
   * 
   * 这是 Claude Code 的核心设计：每个工具都有独立的、写给 AI 的使用手册，
   * 替代简单的 description 字段。包含使用规则、注意事项、示例等。
   */
  prompt?: () => string | Promise<string>;
}
```

> [!IMPORTANT]
> 所有新增字段都是**可选的**，现有 38 个工具不需要同时改。可以渐进式迁移。

#### [MODIFY] 每个核心工具文件 — 添加 `prompt()` 和安全元数据

以最关键的 4 个工具为优先：

##### 1. `packages/core/src/tools/core/shell-run.ts`

从 Claude Code `BashTool/prompt.ts` 的 ~370 行手册中提取核心内容：

```typescript
export const shellRunTool = buildTool({
  name: 'shell_run',
  isReadOnly: (input) => !isMutatingCommand((input as any)?.command),
  isConcurrencySafe: (input) => !isMutatingCommand((input as any)?.command),
  isDestructive: (input) => isDangerousCommand((input as any)?.command),
  maxResultSizeChars: 50_000,
  
  prompt: () => `Executes a given bash command and returns its output.

IMPORTANT: Avoid using shell_run to run cat, head, tail, sed, awk commands.
Instead use the dedicated tools:
 - Read files: Use file_read (NOT cat/head/tail)
 - Edit files: Use apply_patch (NOT sed/awk)
 - Write files: Use file_write (NOT echo >/cat <<EOF)
 - Search files: Use code_search (NOT grep/rg)

# Instructions
 - Quote file paths with spaces: cd "path with spaces/file.txt"
 - Use absolute paths when possible; avoid cd
 - For multiple independent commands, make parallel shell_run calls
 - For dependent commands, chain with '&&'
 - DO NOT use newlines to separate commands

# Git Safety
 - NEVER update git config
 - NEVER run destructive git commands unless explicitly requested
 - ALWAYS create NEW commits rather than amending
 - NEVER skip hooks (--no-verify)

# Background Mode
 - Set background=true for long-running processes (dev servers, watchers)
 - Returns PID immediately without waiting
 - Processes are auto-terminated on task completion`,
  
  // ... existing execute, inputSchema etc
});
```

##### 2. `packages/core/src/tools/core/file-read.ts`

从 Claude Code `FileReadTool/prompt.ts`：

```typescript
prompt: () => `Reads a file from the local filesystem.
Assume this tool can read all files on the machine.

Usage:
- file_path must be an absolute path, not relative
- By default reads up to 2000 lines from the beginning
- You can specify offset and limit for large files
- Results include line numbers for reference
- Can read images (PNG, JPG) as multimodal content
- Can only read files, not directories (use shell_run + ls for directories)
- If you read a file with empty contents, you'll receive a warning`,
```

##### 3. `packages/core/src/tools/core/file-patch.ts` (apply_patch)

从 Claude Code `FileEditTool/prompt.ts`，**关键：先读后改**：

```typescript
validateInput: async (input, context) => {
  const path = (input as any)?.path;
  if (!path) return { result: true };
  
  // 检查是否已读过该文件
  if (context.readFileState && !context.readFileState.has(path)) {
    return {
      result: false,
      message: `You must use file_read to read "${path}" before editing it. This ensures you have the latest file content.`,
    };
  }
  return { result: true };
},

prompt: () => `Performs exact string replacements in files.

Usage:
- You MUST use file_read at least once before editing a file. This tool will error if you attempt an edit without reading.
- Preserve exact indentation from the file_read output
- ALWAYS prefer editing existing files. NEVER write new files unless required.
- The edit will FAIL if the search string is not unique. Provide more context to make it unique.`,
```

##### 4. `packages/core/src/tools/core/file-write.ts`

从 Claude Code `FileWriteTool/prompt.ts`：

```typescript
validateInput: async (input, context) => {
  const path = (input as any)?.path;
  if (!path) return { result: true };
  
  // 新文件不需要先读
  const fs = await import('node:fs/promises');
  try {
    await fs.access(path);
    // 文件存在 -> 必须先读
    if (context.readFileState && !context.readFileState.has(path)) {
      return {
        result: false,
        message: `"${path}" already exists. You MUST use file_read first. Use apply_patch for modifying existing files.`,
      };
    }
  } catch {
    // 文件不存在 -> 新文件，允许直接写
  }
  return { result: true };
},

prompt: () => `Writes a file to the local filesystem.

Usage:
- This tool will overwrite existing files at the provided path.
- If this is an existing file, you MUST use file_read first.
- Prefer apply_patch for modifying existing files — it only sends the diff.
- Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README unless explicitly requested.`,
```

#### [NEW] `packages/core/src/tools/read-file-state.ts`

**readFileState** 是"先读后改"规则的核心状态：

```typescript
/**
 * 文件读取状态缓存
 * 
 * 追踪当前会话中哪些文件已被读取过。
 * validateInput() 使用此状态来强制"先读后改"规则。
 */
export class ReadFileStateCache {
  private readFiles = new Map<string, { timestamp: number; size: number }>();
  
  markRead(filePath: string, size: number): void;
  has(filePath: string): boolean;
  clear(): void;
}
```

#### [MODIFY] `packages/core/src/worker/backends/generic-agent-backend.ts`

在工具执行前集成 `validateInput()` 和 `readFileState`：

```typescript
// 在 execute() 方法中，工具执行前添加：

// 1. 创建 readFileState（每次任务重置）
const readFileState = new ReadFileStateCache();

// 2. 在工具执行回调中集成
const executeToolWithValidation = async (tool: Tool, input: unknown, context: ExecutionContext) => {
  // 2a. validateInput 校验（先读后改等）
  if (tool.validateInput) {
    const validation = await tool.validateInput(input, { ...context, readFileState });
    if (!validation.result) {
      return { success: false, error: validation.message };
    }
  }
  
  // 2b. 执行工具
  const result = await tool.execute(input, context);
  
  // 2c. 如果是 file_read，记录已读
  if (tool.name === 'file_read') {
    readFileState.markRead((input as any).path, ...);
  }
  
  return result;
};
```

#### [MODIFY] 系统提示词中集成工具 prompt

在 `getUsingToolsSection()` 中，每个工具的手册会自动注入到工具 schema 的 description 中。但更重要的是 **工具 prompt 作为工具 description 传给 API**：

```typescript
// 在 convertToolsToAITools() 之前，增强工具描述
function enhanceToolDescriptions(tools: Tool[]): Tool[] {
  return tools.map(tool => {
    if (!tool.prompt) return tool;
    const detailedPrompt = typeof tool.prompt === 'function' ? tool.prompt() : tool.prompt;
    return {
      ...tool,
      description: detailedPrompt, // 用 prompt() 替换简短 description
    };
  });
}
```

### 2.3 文件清单

| 操作 | 文件路径 | 说明 |
|------|---------|------|
| **NEW** | `packages/core/src/tools/build-tool.ts` | buildTool 工厂 + TOOL_DEFAULTS |
| **NEW** | `packages/core/src/tools/read-file-state.ts` | 先读后改状态缓存 |
| **MODIFY** | `packages/core/src/types.ts` | Tool 接口新增可选字段 |
| **MODIFY** | `packages/core/src/tools/core/shell-run.ts` | 添加 prompt + 安全元数据 |
| **MODIFY** | `packages/core/src/tools/core/file-read.ts` | 添加 prompt |
| **MODIFY** | `packages/core/src/tools/core/file-patch.ts` | 添加 prompt + validateInput |
| **MODIFY** | `packages/core/src/tools/core/file-write.ts` | 添加 prompt + validateInput |
| **MODIFY** | `packages/core/src/tools/core/code-search.ts` | 添加 prompt |
| **MODIFY** | `packages/core/src/tools/core/file-list.ts` | 添加 prompt |
| **MODIFY** | `packages/core/src/tools/core/todo.ts` | 添加 prompt |
| **MODIFY** | `packages/core/src/tools/core/spawn-subagent.ts` | 添加 prompt |
| **MODIFY** | `packages/core/src/worker/backends/generic-agent-backend.ts` | 集成 validateInput + readFileState |
| **MODIFY** | `packages/core/src/worker/engines/tool-schema.ts` | 工具描述增强 (prompt → description) |

---

## 三、集成点

改造后的数据流：

```
GenericAgentBackend.execute()
  │
  ├── 1. getSystemPrompt(config)          ← 新提示词系统
  │     ├── 静态段落（缓存）
  │     ├── DYNAMIC_BOUNDARY
  │     └── 动态段落（环境/记忆/技能）
  │
  ├── 2. enhanceToolDescriptions(tools)    ← 工具 prompt 注入
  │     └── tool.prompt() → tool.description
  │
  ├── 3. convertToolsToAITools(tools)      ← 现有逻辑不变
  │
  └── 4. 工具执行循环
        ├── validateInput(input, ctx)       ← 先读后改
        ├── readFileState.markRead()        ← 追踪已读文件
        └── tool.execute(input, ctx)        ← 现有执行逻辑
```

---

## Open Questions

> [!IMPORTANT]
> 1. **提示词语言**: Claude Code 的提示词全是英文。Tachikoma 现有提示词有中英混合（`WORKER_BEHAVIOR_GUIDELINES_EN` 但代码注释是中文）。新的 `getSystemPrompt()` 是否统一用英文？还是保留双语支持？
>
> 2. **工具 prompt 长度**: Claude Code 的 BashTool prompt 有 ~370 行。如果所有 38 个工具都有这么长的 prompt，会显著增加 token 消耗。是否第一批只给最关键的 6-8 个工具写详细 prompt（shell_run, file_read, file_patch, file_write, code_search, spawn_subagent），其余保持简短？
>
> 3. **buildTool 渐进迁移**: 是否立即将所有 38 个工具改为 `buildTool()` 形式？还是先改关键工具，其余在后续迭代中迁移？（推荐后者，因为 `buildTool` 的新字段都是可选的）

## Verification Plan

### Automated Tests

1. **提示词组装测试**: `getSystemPrompt()` 返回的段落数量、缓存边界位置、段落缓存行为
2. **buildTool 默认值测试**: `buildTool({name: 'x', ...})` 的所有默认值正确性
3. **validateInput 测试**: file_read 后才能 file_patch/file_write；新文件可直接 file_write
4. **readFileState 测试**: markRead/has/clear 行为
5. **兼容性测试**: `buildWorkerSystemPrompt()` 旧 API 仍然可用且输出合理
6. **工具描述增强测试**: `enhanceToolDescriptions()` 正确替换 description

### Manual Verification

1. **端到端测试**: 用新提示词运行一个完整的编程任务，观察 LLM 的行为变化
2. **Token 消耗对比**: 测量新旧提示词的 token 数差异
3. **先读后改验证**: 故意跳过 file_read 直接 file_patch，确认被拦截

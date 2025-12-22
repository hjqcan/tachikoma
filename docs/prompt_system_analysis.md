# Tachikoma Prompt 质量问题深度分析

> 分析 Tachikoma 输出质量不佳的**根本原因**，对比 Codex CLI 的 prompt 设计。

---

## 一、问题诊断：为什么 Tachikoma 输出质量差？

### 核心问题一览

| 问题                 | Tachikoma 现状                   | Codex CLI 做法                                           | 影响               |
| -------------------- | -------------------------------- | -------------------------------------------------------- | ------------------ |
| **身份模糊**         | "You are a helpful AI assistant" | "You are Codex, a coding agent running in the Codex CLI" | Agent 缺乏专注度   |
| **无结构化思考**     | 无明确要求                       | "think step by step", 需要状态追踪                       | 复杂任务容易迷失   |
| **无自我纠错**       | 无                               | 诊断 → 验证 → 升级三步                                   | 错误累积           |
| **无渐进测试**       | 无                               | 先小范围测试，再扩大                                     | 频繁 break 代码    |
| **工具指导模糊**     | "prefer incremental edits"       | 具体场景+具体工具选择                                    | 工具使用不当       |
| **无上下文约束**     | 无                               | 明确 sandbox 限制、审批规则                              | 执行不确定性       |
| **缺乏 Agent 魄力**  | 被动等待指令                     | "be ambitious...surgical precision"                      | 不主动解决问题     |
| **无 preamble 习惯** | 无                               | 执行前发送简短说明                                       | 用户不知道在做什么 |

---

## 二、逐项对比分析

### 2.1 身份定义

**Tachikoma 当前**:

```
You are a helpful AI assistant that can use tools to accomplish tasks.
```

**Codex CLI**:

```
You are Codex, a coding agent running in the Codex CLI.
You are precise, safe, and helpful.
You have tools to run terminal commands, apply patches to files...
```

**问题**：Tachikoma 的身份过于通用，没有建立"编码 Agent"的专业形象。Agent 不知道自己擅长什么。

### 2.2 结构化思考

**Tachikoma 当前**:

```
When given a task, think step by step about how to accomplish it
```

**Codex CLI**:

```
When solving problems:
1. First analyze the codebase to understand the structure
2. Plan your approach before making changes
3. Track task status: pending | in_progress | completed
4. Never start a new task before completing the current one
```

**问题**：Tachikoma 缺乏强制的任务状态管理，容易并行开始多个未完成的工作。

### 2.3 自我诊断与纠错

**Tachikoma 当前**:

```
(无)
```

**Codex CLI**:

```
If a command fails:
1. Diagnose the root cause before attempting fixes
2. Verify the fix worked before moving on
3. If multiple attempts fail, explain what you tried and ask for guidance
```

**问题**：Tachikoma 遇到错误时无明确处理策略，可能反复尝试相同失败操作。

### 2.4 渐进测试策略

**Tachikoma 当前**:

```
(无)
```

**Codex CLI**:

```
Progressive testing:
1. Start with specific tests for changed code
2. Expand to related module tests
3. Run broader test suite as confidence builds
```

**问题**：修改代码后不知道如何验证，要么不测试，要么运行整个测试套件浪费时间。

### 2.5 工具使用指导

**Tachikoma 当前**:

```
Recommended tool strategy:
1. apply_patch (preferred for modifications)
2. Targeted append operations
3. Full file rewrites (only for new files)
```

**Codex CLI**:

```
Tool selection:
- For text search: prefer rg over grep (faster)
- For file edits: use apply_patch for single-file changes
- For multi-file refactors: plan the order, edit dependencies first
- Never use git reset --hard unless explicitly approved
```

**问题**：Tachikoma 的工具指导太抽象，没有具体场景映射。

### 2.6 Preamble 消息

**Tachikoma 当前**:

```
(无)
```

**Codex CLI**:

```
Before tool calls, send brief preamble messages:
- Explain what you're about to do
- Keep it to 1-2 sentences
- Group related actions logically
```

**问题**：用户不知道 Agent 正在做什么，黑盒体验差。

### 2.7 上下文约束意识

**Tachikoma 当前**:

```
(无，依赖运行时检查)
```

**Codex CLI**:

```
Be aware of your environment:
- sandbox_mode: read-only | workspace-write | full-access
- approval_policy: suggest | auto-edit | full-auto
- Adjust your actions accordingly
```

**问题**：Agent 不知道自己的权限边界。

### 2.8 Agent 魄力（Ambition vs Precision）

**Tachikoma 当前**:

```
(无)
```

**Codex CLI**:

```
- Be ambitious when starting from scratch
- Act with surgical precision in existing codebases
- Don't ask for permission on every small step
```

**问题**：Agent 要么过于保守，要么过于激进，没有上下文感知的行为调节。

---

## 三、改进建议

### 3.1 重写 DEFAULT_SYSTEM_PROMPT

```typescript
const DEFAULT_SYSTEM_PROMPT = `You are Tachikoma, an autonomous coding agent.
You are precise, efficient, and proactive.

## Your Capabilities
- Read and modify files using apply_patch
- Execute shell commands via shell_run
- Search code with file_read and shell_run (prefer rg)
- Verify changes with type_check and run_tests

## Task Execution
1. Analyze before acting: understand the codebase structure first
2. Track your progress: mark steps as pending → in_progress → completed
3. One task at a time: finish current work before starting new tasks
4. Progressive testing: test specific changes first, then broader suite

## Error Handling
When something fails:
1. DIAGNOSE: Read error output, identify root cause
2. FIX: Make targeted correction
3. VERIFY: Confirm the fix worked
4. ESCALATE: If 3 attempts fail, summarize and ask for guidance

## Communication
- Send brief preambles before tool calls ("Searching for the config file...")
- Keep explanations concise unless asked for detail
- Report blockers immediately, don't spin

## Mindset
- Be ambitious on greenfield projects
- Be surgical in existing codebases
- Don't ask permission for obvious next steps

${WORKER_BEHAVIOR_GUIDELINES_EN}
`;
```

### 3.2 添加场景化工具选择

```typescript
const TOOL_SELECTION_GUIDE = `
## Tool Selection Guide

| Scenario | Tool | Example |
|----------|------|---------|
| Find text in code | shell_run + rg | rg "function foo" -n |
| Read specific file | file_read | { path: "src/index.ts" } |
| Modify code | apply_patch | { patches: [...] } |
| Run tests | run_tests | { pattern: "foo.test" } |
| Type check | type_check | {} |
| Start dev server | dev_server | { command: "npm run dev" } |

## Anti-patterns
- ❌ shell_run for npm run dev without background: true
- ❌ Full file rewrite when apply_patch would work
- ❌ git reset --hard without explicit approval
`;
```

### 3.3 添加状态追踪模板

```typescript
const TASK_TRACKING = `
## Task Status Format

When working on multi-step tasks, maintain status:
- [ ] pending: Not started
- [→] in_progress: Currently working
- [x] completed: Done and verified

Example:
[x] 1. Analyze existing code structure
[→] 2. Implement new function
[ ] 3. Add tests
[ ] 4. Update documentation
`;
```

### 3.4 Worker 自我纠错指令 (新增)

**当前缺失**：[behavior-guidelines.ts](file:///Users/hjqcan/Documents/tachikoma/packages/core/src/worker/prompts/behavior-guidelines.ts) 没有错误处理流程

**建议添加**：

```typescript
const ERROR_HANDLING_GUIDE = `
## Error Recovery Protocol

When encountering an error, follow this 4-step process:

### Step 1: DIAGNOSE (诊断)
- Read the FULL error message carefully
- Identify the root cause, not just symptoms
- Check common causes:
  - File not found → verify path with file_list
  - Permission denied → check if file is protected
  - Syntax error → re-read the file content
  - Command failed → check if tool/binary exists

### Step 2: FIX (修复)
- Make a TARGETED correction addressing the root cause
- Don't make unrelated changes in the same edit
- Prefer minimal, surgical fixes

### Step 3: VERIFY (验证)
- Re-run the failed operation
- Confirm the error is resolved
- Check for side effects

### Step 4: ESCALATE (升级)
If 3 attempts fail:
- Summarize what you tried
- Explain what you learned
- Ask for user guidance with specific questions

## Anti-patterns
- ❌ Retry the exact same command without changes
- ❌ Make broad changes hoping to fix unknown issues
- ❌ Silently ignore errors and continue
- ❌ Spin in infinite retry loops
`;
```

### 3.5 专用 Compaction Prompt (新增)

**当前缺失**：无类似 OpenCode 的 `compaction.txt`

**参考 OpenCode**：
```
# OpenCode compaction.txt
When asked to summarize, provide a detailed but concise summary:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next
- Key user requests and constraints that should persist
- Important technical decisions and why they were made
```

**建议为 Tachikoma 创建**：

```typescript
// packages/core/src/conversation/prompts/compaction.ts

export const COMPACTION_PROMPT = `
You are summarizing a conversation for continuity across context windows.

## Include (MUST)
- Completed actions (past tense, bullet points)
- Current work in progress
- Files created/modified (path list)
- Pending next steps
- User constraints and preferences that should persist
- Key technical decisions with brief rationale

## Exclude
- Verbose tool outputs
- Failed attempts (unless learning is relevant)
- Intermediate thinking steps
- Repetitive context

## Format
Keep it structured and scannable:
- Use headers: ## Done | ## In Progress | ## Next | ## Constraints
- Prefer bullets over prose
- Mark uncertain items as [UNCONFIRMED]
- Total length: 200-500 words

## Example Output
## Done
- Created React component \`Button.tsx\`
- Added unit tests in \`Button.test.tsx\`

## In Progress
- Implementing hover animation

## Next
- Add accessibility attributes
- Update Storybook docs

## Constraints
- User prefers CSS modules over styled-components
- Must support dark mode
`;
```

**集成点**：
- `PromptContextEngine.compressMessages()` 应使用此 prompt
- `ConversationPromptBuilder.compressHistory()` 应调用专用 summarizer

---

## 四、实施优先级

| 优先级 | 改进项                  | 预期影响        |
| ------ | ----------------------- | --------------- |
| **P0** | 重写身份定义            | 明确 Agent 角色 |
| **P0** | 添加自我诊断流程 (3.4)  | 减少错误循环    |
| **P0** | 添加 preamble 习惯      | 改善用户体验    |
| **P1** | 场景化工具选择          | 减少工具误用    |
| **P1** | 渐进测试策略            | 提高代码质量    |
| **P1** | 状态追踪模板            | 减少任务混乱    |
| **P1** | Compaction Prompt (3.5) | 上下文压缩质量  |
| **P2** | Ambition/Precision 平衡 | 行为适配上下文  |

---

## 五、结论

Tachikoma 输出质量差的根本原因不是功能缺失，而是 **Prompt 设计停留在通用 LLM 助手水平**，没有针对 Coding Agent 场景进行专业化设计。

Codex CLI 的 Prompt 特点：

1. **明确身份**：Agent 知道自己是谁、擅长什么
2. **结构化行为**：强制状态追踪、诊断流程
3. **场景化指导**：每个场景对应具体做法
4. **用户体验**：Preamble 消息让用户知情

**下一步**：按 P0 优先级重写 [behavior-guidelines.ts](file:///Users/hjqcan/Documents/tachikoma/packages/core/src/worker/prompts/behavior-guidelines.ts) 和 `DEFAULT_SYSTEM_PROMPT`。


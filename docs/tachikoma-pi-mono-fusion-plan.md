# Tachikoma x pi-mono 深度融合实施方案

> **状态：历史方案，停止推进（2026-08-11）。** ChatEngine 的模型↔工具循环已改为直接使用
> `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-coding-agent` 0.84.1。本文提出的自研 Tool
> Runtime Kernel、Event Stream Loop 和跨 backend 重写不再是目标；旧
> `orchestrate`/worker 实现只作为遗留编排面，不应继续扩展同类循环。默认 `run`
> 已由同一个 ChatEngine 执行。现行方向见 `docs/tachikoma-spiral-roadmap.md`。

## 1. 背景与目标

Tachikoma 当前在复杂生成任务中存在“子任务看似完成，但最终无法闭环”的问题。核心根因是工具调用链路在不同 backend 中分散实现、容错策略不一致、验证时机偏后，导致模型在错误出现时缺乏稳定自修闭环。

本方案目标是将 Tachikoma 底层深度对齐 pi-mono 的稳定执行范式：

- 以明确的 `tool_call -> tool_result` 生命周期作为执行主干。
- 以最小稳定工具剖面（`read/write/edit/bash`）降低策略熵。
- 以可恢复错误下沉（synthetic tool_result）避免子任务被非致命错误直接中断。
- 以会话级任务追踪（todo）和中期联调 smoke 提高闭环率。
- **[NEW] 以 Context Compaction 机制解决长链路任务的上下文溢出问题。**

成功标准：

- 工具缺失/参数错误类问题不再直接导致子任务失败。
- 联调类任务在执行中期即可暴露并修复主要可运行性问题。
- 端到端任务闭环成功率显著提升，且失败日志可直接定位根因。

## 2. 设计原则

- 单一真源：运行期可用工具集合必须由唯一组件决策，prompt/skills/backend 全链路共享。
- 统一生命周期：所有 backend 共享同一工具中间件管线，**基于 Event Stream 驱动**。
- 错误分级：recoverable 错误转 synthetic tool_result；fatal 错误才终止子任务。
- 状态分层：`Todo` 是执行状态真源，`Compaction` 仅负责上下文预算管理，不参与执行裁决。
- 冲突裁决：若摘要状态与 Todo 快照冲突，一律以 Todo 快照为准并触发恢复日志。
- 恢复幂等：replan/resume 重放同一事件不得重复推进任务状态。
- 渐进迁移：以 feature flag 逐步接管，先影子模式再强制模式。
- 可观测先行：每一步改造必须有可量化指标与日志字段。

## 3. 当前实现差距

主要代码位置：

- `/packages/core/src/worker/backends/openai-agent-backend.ts`
- `/packages/core/src/worker/backends/generic-agent-backend.ts`
- `/packages/core/src/worker/backends/claude-agent-backend.ts`
- `/packages/core/src/worker/worker-executor.ts`

关键差距：

- 工具执行逻辑在 OpenAI/Claude/Generic 三条路径重复实现，行为不一致。
- 工具可用性信息分散在 prompt/skills/backend，多处可能漂移。
- 部分 recoverable 错误仍直接升级为任务级失败。
- smoke/browser 验证主要发生在末尾 gate，修复反馈滞后。
- todo 工具已存在，但未被提升为统一执行状态机。
- **缺乏长任务的上下文压缩 (Compaction) 机制，导致 Token 溢出或注意力分散。**

## 4. 目标架构（融合后）

新增核心层：`Tool Runtime Kernel`

建议目录：

- `/packages/core/src/worker/tool-runtime/`

核心职责：

- 管理可用工具快照（单一真源）。
- 统一执行前/后中间件。
- 统一错误分级与 synthetic tool_result 下沉。
- 输出统一事件（tool_call_started/tool_call_finished/tool_call_failed/recovered）。
- **管理会话上下文压缩 (Session Compaction)。**

执行流：

1. Orchestrator/WorkerExecutor 组装任务上下文。
2. Tool Runtime 生成 `ResolvedToolset`（区分 Native Tools 与 Semantic Skills）。
3. Prompt/Skills/Constraint 全部从 `ResolvedToolset` 派生。
4. **Event Stream Loop 启动** (参考 pi-mono `agentLoop`)。
5. 模型发出工具调用。
6. Tool Runtime 执行 before middleware。
7. 工具执行。
8. Tool Runtime 执行 after middleware (含 System Observer 注入)。
9. 出错时按错误等级返回 synthetic tool_result (`isError=true`) 或 fatal。
10. **检查是否需要 Compaction，必要时触发摘要生成。**

## 5. 分阶段实施计划（按收益排序）

### Phase P0-1: 工具执行中间件与 Event Stream 统一化（最高优先级）

目标：引入跨 backend 统一的 `beforeToolCall/afterToolResult` 生命周期，并重构为基于 Event
Stream 的状态机。

参考：`pi-mono/packages/agent/src/agent-loop.ts`

改造项：

- 新增接口：
  - `ToolCallContext` / `ToolResultContext` / `ToolErrorContext`
  - `ToolMiddleware`
- **重构 `ExecutionLoop`**：
  - 剥离具体 Backend 逻辑，改为纯 Event Stream 驱动。
  - 统一管理 `UserMessage -> LLM -> ToolCall -> ToolResult` 状态流转。
- 新增默认中间件链：
  - 参数规范化
  - 约束检查 / 审批检查 / doom-loop 检查
  - 观测埋点
- OpenAI/Generic/Claude backend 改为调用同一 runtime 执行器。

里程碑：

- M1: 影子模式（仅记录，不改变执行结果）。
- M2: Generic backend 完整接管。
- M3: OpenAI/Claude backend 接管。

---

### Phase P0-2: 工具单一真源 + Preflight (Tools vs Skills)

目标：确保“可用工具清单 -> prompt/skills/constraints/backend”严格一致，并明确区分 Native
Tools 与 Semantic Skills。

改造项：

- 新增 `ResolvedToolset`：
  - **Native Tools**: 硬编码原子能力 (File, Bash, MCP)，负责安全与执行。
  - **Semantic Skills**: 动态加载的复杂能力 (Markdown 定义)，负责业务逻辑注入。
  - `profile`: `pi-core` (read/write/edit/bash) / `full`。
  - `hash`（用于回归对比）。
- 新增 preflight：
  - 移除不可用推荐工具。
  - 跳过 `requiresTools` 不满足的 skills。
  - 工具别名映射（`read/write/edit/bash` -> Tachikoma 具体工具名）。

验收标准：

- 不再出现“prompt 提示可用但 runtime 不存在”的工具调用。
- 明确区分原子工具与语义技能的边界。

---

### Phase P0-3: Recoverable 错误 Synthetic Tool Result 化

目标：非致命工具错误不终止子任务，转为可学习反馈继续循环。区分“执行失败”与“功能性错误”。

参考：pi-mono `isError` 标记。

错误分级：

- **Functional Error (isError=true)**: 工具执行成功，但结果是错误信息 (e.g. grep not found, file not
  exist)。模型可根据反馈修正。
- **Execution Failure (Fatal)**: 工具执行过程崩溃 (e.g. timeout, auth failed)。需基础设施层处理。

改造项：

- 新增统一错误转换器 `ToolErrorPolicy`。
- 生成标准 synthetic tool_result：
  - `success=false`
  - `isError=true` (关键标记)
  - `content`: 错误详情
  - `hint` / `recoveryActions`
- 针对 SDK `Tool ... not found` 统一捕获并下沉。

验收标准：

- Recoverable 场景下子任务继续执行并有后续修复动作。
- 日志中清晰区分是模型用错了工具（Functional）还是工具坏了（Execution）。

---

### Phase P1-1: Todo 状态机强化

目标：让多步骤任务有稳定、可恢复、可审计的执行进度。**这是 Tachikoma 优于 pi-mono 隐式状态的关键差异点。**

现状复用：

- `/packages/core/src/tools/core/todo.ts`

改造项：

- Worker 首轮对多步骤任务强制初始化 todo。
- 每轮写回 todo 快照到 session runtime 状态。
- replan/resume 时自动合并 todo 进度，避免重复执行。
- 建立显式状态转移表（FSM）：
  - `pending -> in_progress -> completed|blocked|cancelled`
  - 禁止跳转：如 `pending -> completed`、`completed -> in_progress`
- 增加版本号（`todoRevision`）与乐观并发校验，避免并发 worker 覆写状态。
- 在 UI/日志中统一展示 pending/in_progress/completed 计数。

验收标准：

- 中断后恢复能准确继承 todo 进度。
- 非法状态转移在影子模式下记录告警，在 strict 模式下阻断并返回可恢复错误。
- 重放同一事件不会重复推进 todo（幂等通过）。

---

### Phase P1-2: 基于 System Observer 的中间态验证

目标：将联调可运行性问题从“末尾暴雷”前移到执行中段。

参考：pi-mono `getSteeringMessages` 机制。

改造项：

- 引入 **System Observer** 角色。
- 在 `ExecutionLoop` 注入 `midExecutionProbe`。
- 触发方式：**非中断式注入**。
  - 当检测到关键文件变更（路由/入口/Mock）时，Observer 向 Context 注入一条 `Role: System` 消息。
  - 内容示例：“检测到你修改了 API 路由，请运行测试验证接口可用性。”
- 检查项：Dev server 启动、HTTP health、页面渲染等。

验收标准：

- 联调类失败更早暴露，且通过自然对话引导模型修复，而非硬性打断。

---

### Phase P1-3: Session Compaction (上下文压缩) [NEW]

目标：解决长链路任务导致的 Token 溢出和模型注意力分散问题。

参考：`pi-mono/packages/coding-agent/src/core/compaction`

改造项：

- 引入 `CompactionManager`。
- 策略：
  - 基于 Token 阈值触发。
  - 保留 System Prompt 和最近 N 轮对话。
  - 将中间的历史对话压缩为 `Summary` (摘要)。
  - 关键信息（如 Todo 状态、关键文件路径）需在压缩后保留或重新注入。
  - 摘要中携带 `todoSnapshotHash` + `todoRevision`，恢复时与 session 中真实快照比对。
  - 比对不一致时，强制回注入真实 Todo 快照并记录 `compaction.todo_mismatch`。

验收标准：

- 长时间运行的任务不会因为 Context Window 耗尽而崩溃。
- 压缩后模型仍能保持对任务目标的专注。
- 压缩前后 Todo 语义一致；冲突时执行态仍以 Todo 快照为准。

---

### Phase P1-4: Todo x Compaction 契约与恢复幂等 [NEW]

目标：把 `Todo` 与 `Compaction` 的职责边界固化为可执行契约，避免上线后出现隐式漂移。

改造项：

- 定义 `ExecutionStateContract`：
  - `todoState`（权威执行态）
  - `summaryState`（压缩态）
  - `conflictPolicy=todo_wins`
- 恢复流程强制三步：
  1. 读取 session Todo 快照
  2. 读取压缩摘要并校验 hash/revision
  3. 合并后输出单一恢复上下文（冲突时覆盖为 Todo）
- 引入 `ReplayGuard`：
  - 基于 `eventId` 去重
  - 防止重试导致重复 `completed` 或重复副作用工具调用

验收标准：

- 100+轮长任务中，出现 compaction 后仍无重复完成/回退异常。
- 任意一次恢复后，Todo 统计与实际子任务状态一致。

---

## 6. 接口草案

```ts
// packages/core/src/worker/tool-runtime/types.ts
export interface ResolvedToolset {
  nativeTools: Tool[]; // 原子工具
  semanticSkills: Skill[]; // 语义技能
  profile: 'pi-core' | 'full';
  capabilities: Record<string, boolean>;
  hash: string;
}

export interface ToolCallContext {
  taskId: string;
  callId: string;
  toolName: string;
  input: unknown;
  toolset: ResolvedToolset;
  metadata: Record<string, unknown>;
}

export interface ToolResultContext {
  call: ToolCallContext;
  success: boolean;
  isError: boolean; // NEW: 区分功能性错误与执行成功
  output: unknown;
  durationMs: number;
}

export interface ToolErrorContext {
  call: ToolCallContext;
  error: unknown;
  errorCode?: string;
}

export interface ToolMiddleware {
  beforeToolCall?(ctx: ToolCallContext): Promise<ToolCallContext>;
  afterToolResult?(ctx: ToolResultContext): Promise<ToolResultContext>;
  onToolError?(ctx: ToolErrorContext): Promise<ToolResultContext | null>;
}
```

## 7. 兼容策略与灰度发布

feature flags 建议：

- `toolRuntimeV2.enabled`
- `toolRuntimeV2.shadowMode`
- `toolProfile.default` (`pi-core`/`full`)
- `syntheticToolResult.enabled`
- `midExecutionSmoke.enabled`
- `sessionCompaction.enabled`
- `todoFsm.strictMode`
- `compaction.todoGuard.enabled`
- `resume.replayGuard.enabled`

灰度步骤：

1. Shadow mode 开启，仅记录新链路输出。
2. Generic backend 切流 20% -> 50% -> 100%。
3. OpenAI backend 切流。
4. Claude backend 切流。
5. 默认 toolProfile 改为 `pi-core`。

回滚原则：

- 任一阶段闭环率下降超过阈值，立即回滚到上一阶段。
- 保留旧执行路径 1 个版本窗口。

## 8. 观测与SLO

新增指标：

- `worker.tool.runtime.recoverable_error_count` (isError=true)
- `worker.tool.runtime.synthetic_result_count`
- `worker.tool.runtime.fatal_error_count`
- `worker.tool.runtime.preflight_mismatch_count`
- `orchestrator.mid_smoke.trigger_count`
- `orchestrator.mid_smoke.fail_count`
- `session.compaction.count`
- `session.compaction.todo_mismatch_count`
- `todo.fsm.invalid_transition_count`
- `todo.resume.idempotent_replay_count`
- `task.closure.success_rate`

建议 SLO：

- 任务闭环成功率（联调类）>= 80%。
- recoverable 错误转 synthetic 成功率 >= 95%。
- 未知工具导致的任务硬失败占比 < 1%。

## 9. 回归评测集（Step 5 扩展）

在 `/evals` 增加：

- `tool-not-found-recover.json`
- `invalid-args-recover.json`
- `pi-core-profile.json`
- `mid-smoke-frontend-backend.json`
- `todo-resume.json`
- `long-session-compaction.json`
- `todo-fsm-illegal-transition.json`
- `compaction-todo-consistency.json`
- `resume-idempotency-replay.json`

每个用例要求：

- 记录 tool trajectory。
- 记录 final verification 结果。
- 输出 recoverable/fatal 错误分布。

## 10. 工程任务拆解（可直接导入 TaskMaster）

1. 建立 Tool Runtime Kernel 目录与类型定义。
2. 实现基于 Event Stream 的 `ExecutionLoop` 重构。
3. 实现 ResolvedToolset + preflight (区分 Native/Skills)。
4. 接管 Generic backend 工具执行路径。
5. 接管 OpenAI backend 工具执行路径。
6. 接管 Claude backend（含 MCP bridge 对齐）。
7. 实现 synthetic tool_result 错误策略 (含 isError)。
8. 将 todo 升级为 session 状态机。
9. 实现 System Observer 与 midExecutionProbe。
10. 实现 Session Compaction 机制。
11. 实现 Todo x Compaction 契约与 ReplayGuard。
12. 扩展 evals 与可观测指标。

## 11. 风险与应对

风险：

- 多 backend 同步改造引入兼容性回归。
- 工具集收敛后短期可能降低任务探索能力。
- Compaction 可能导致部分细节丢失。
- Todo 严格状态机在早期可能增加阻断率（模型尚未适配）。

应对：

- 先 shadow 再切流，保证可回滚。
- 维持 `full` profile 作为兜底。
- Compaction 策略需精细化，确保 Todo 等关键状态不被压缩。
- `todoFsm.strictMode` 分阶段开启：先告警再阻断，降低切换风险。

## 12. 结论

该方案不是“增加更多规则”，而是把 Tachikoma 的执行内核从“分散、弱一致”改为“统一、可恢复、可观测”的体系化闭环。通过引入
**Event Stream Kernel**、**System Observer** 和 **Session
Compaction**，我们将构建一个既具备 pi-mono 稳定性，又拥有 Tachikoma 特色状态管理的强大 Agent 运行时。

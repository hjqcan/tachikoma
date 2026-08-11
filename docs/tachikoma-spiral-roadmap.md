# Tachikoma 螺旋路线图（Chatbot → 工具调用者 → 协调者）

> 状态：现行总纲（2026-08-10 起）。本文件取代此前一切以 orchestrator 为架构前提的路线叙事；`docs/tachikoma-desktop-plan.md`
> 的协议/服务/桌面壳部分继续有效，但其引擎核心策略（§4.3「包装 ConversationalRunner」）被本文件修订。

## 0. 方向声明（来自项目所有者，2026-08-10）

> 项目停了 8 个月，架构、代码、功能都老旧了。可以大量变更、修改、优化甚至推翻之前的决定。Tachikoma
> **不一定要 orchestrator**：它首先是一个**顶级的 chatbot**，然后是**顶级的工具调用者**，然后是**顶级的协调者/调度者**。每一件事情先做到极致，再进一步推进，**螺旋上升**。

由此确立三条铁律：

1. **对话是第一公民。**
   任何用户输入首先进入直连对话路径；任务编排是对话的高阶能力，不是前置架构。此前"一句你好也要过 Planner
   → Orchestrator → WorkerPool"的范式废除。
2. **逐圈做到极致。**
   每一圈有明确的"极致标准"，达标才推进下一圈；下一圈只做增量扩展，不推翻上一圈接口。
3. **旧决定可推翻。** 8 个月前的架构判断（五层架构、System 1/System
   2 分层、orchestrator 中心论）不再自动成立；保留的东西必须重新赢得它的位置。

## 1. 三圈定义与极致标准

### 第一圈：顶级 Chatbot（进行中，核心已落地）

直连流式对话：用户消息 → LLM（token 级流式）→ 回复。零编排开销。

| 极致标准                                                                 | 状态                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| token 级流式（`streamText` fullStream，非事后拼装）                      | ✅ `ChatEngine`（`packages/core/src/chat/chat-engine.ts`）               |
| 多 Provider 一键切换（anthropic / openai / openai-compatible），无硬编码 | ✅ `providers.ts`（`createChatModel` 是唯一模型构造入口）+ `/model` 命令 |
| 持久记忆（Memory-First，GoodMemory）                                     | ✅ 回复前召回注入 + 回合后写入（`memory.ts`，见 §3）                     |
| 中断是一等操作（生成中 Ctrl+C 停止、半成品持久化打标）                   | ✅ `interrupt()` + `interrupted` 标记                                    |
| 会话持久化 + 恢复 + 列表                                                 | ✅ `ChatSessionStore`（原子写 JSON）、`chat --session/--list`            |
| 用户消息先落盘（请求发出前持久，崩溃不丢输入）                           | ✅                                                                       |
| 错误显式化（`fullStream` error 部件；SDK 默认吞错行为被屏蔽）            | ✅                                                                       |
| 零网络测试（`ai/test` MockLanguageModelV3 全覆盖）                       | ✅ `tests/chat-engine.test.ts`                                           |
| CLI 入口                                                                 | ✅ `tachikoma chat`（流式渲染 REPL + 斜杠命令）                          |

**第一圈剩余打磨（做完才算极致）**：

- 上下文压缩：超窗口后的历史摘要（当前只有截断窗口 `maxHistoryMessages`）。
- `reasoning-delta` 呈现（fullStream 已有该部件，UI 折叠显示思考流）。
- 会话内 provider 完整切换 UX（当前 `/model` 只换模型名；跨 provider 需带 key）。
- Prompt cache 利用（Anthropic cache_control；长会话成本优化）。
- 真实 API 冒烟纳入 evals（当前仅 mock 测试 + dummy-key 错误路径冒烟）。

### 第二圈：顶级工具调用者（下一步）

在 **同一个 ChatEngine 循环** 上增量启用工具，绝不新建第二条执行路径。

- **机制**：AI SDK v6 的 `streamText({tools})` 原生多步循环；`fullStream` 已内建
  `tool-input-start/delta/end`、`tool-call`、`tool-result`、`tool-error`、`tool-output-denied`
  部件——`ChatEvent` 联合按同名语义增量扩展。
- **工具面**：复用现有 9 个核心工具（`tools/core/`，canonical 名
  `Read/Write/Glob/Bash/Grep/Edit/...`）+ `LocalSandbox` 白名单执行；MCP 工具经 `MCPClientManager`
  接入同一 ToolSet。
- **审批门**：AI SDK v6 原生 tool-approval（`LanguageModelV3ToolApprovalRequest` /
  `tool-output-denied`
  部件）对齐审批流；替代文件轮询侧通道，桌面方案 §4.4 的 escalation 语义在此实现。
- **工作区**：`chat --workdir` 从"记忆维度"升级为"工具作用域"（文件工具根目录 + 沙盒边界）。
- **极致标准**：工具循环零自建协议（AI
  SDK 原生）；每次工具调用可中断、可审批、可回放；错误进入 synthetic
  tool_result 自愈循环（继承 fusion 计划的 error-policy 语义）；工具事件结构化（callId 全链路）。

### 第三圈：顶级协调者/调度者（之后）

- **形态**：聊天循环内 `spawn_subagent`（fork 子代理，Claude
  Code 风格）处理可并行/可隔离的大任务；子代理仍是 ChatEngine 循环（递归同构），不是另一套 Worker 体系。
- **既有 orchestrator 的处置**：保留为"大任务模式"的可选后端（`run`
  命令原样可用），其价值资产——验证门（VerificationGate/BuildGate/SmokeGate）、todo FSM、session
  compaction、replay
  guard——逐步蒸馏成第三圈子代理可复用的服务，而非整层照搬。`docs/向claude code对齐计划.md.resolved`
  的"扁平化"主张在此圈按增量方式兑现：不是删除 orchestrator，而是让它退位为可选组件。
- **极致标准**：单任务默认单循环完成；只有真并行收益时才 fork；父子事件流合并有序；成本可观测。

## 2. 与既有文档/计划的关系

| 文档                                     | 处置                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/tachikoma-desktop-plan.md`         | **部分有效**：协议包（E1）、本机 server（E5）、Electron 壳（D 轨）、安全模型、打包尖峰全部保留；引擎核心从"AgentEngine 包装 ConversationalRunner"改为"以 ChatEngine 为根，逐圈生长"。桌面 UI 对接的事件流 = `ChatEvent`（第二圈后自然覆盖 StreamEvent v2 的结构化工具事件语义）。E2/E3/E4 的实现载体变更，目标不变。 |
| `docs/向claude code对齐计划.md.resolved` | 思想吸收（单循环、fail-closed 工具、压缩），"删除 Orchestrator"改为"退位为可选组件"（第三圈）。                                                                                                                                                                                                                      |
| `docs/tachikoma-pi-mono-fusion-plan.md`  | 已完成的资产（tool runtime kernel、error policy、todo FSM、compaction）在第二/三圈按需蒸馏复用；不再作为独立路线推进。                                                                                                                                                                                               |
| taskmaster 待办 10-16/18                 | 冻结排序，待第二圈完成后按螺旋重排。                                                                                                                                                                                                                                                                                 |
| `README.md` / `CLAUDE.md`                | 待第二圈落地后统一改写（避免每圈改一次）。                                                                                                                                                                                                                                                                           |

## 3. GoodMemory（记忆层，用户自研）

- 库：`goodmemory`（`~/workspace/GoodMemory`，npm ^0.7.2，MIT，Bun 原生，SQLite 零外部依赖）。
- 集成方式：**进程内库集成** + 窄结构接口（`packages/core/src/chat/memory.ts` 的
  `GoodMemoryLike`，只依赖 `recall/buildContext/remember`
  三个方法形状，隔离版本漂移）。不走 MCP（cwd 作用域不适配 per-user 聊天）、不走 HTTP
  bridge（同语言多余一跳）。
- 生命周期：回复前 `recall`（`hasRecallHits` 桶级命中判断，空库不注入框架头）→
  `buildContext(system_prompt_fragment)` 注入；正常完成的回合
  `remember(user+assistant)`；记忆层任何失败静默降级，绝不影响对话。
- Scope：`{userId: $USER, agentId: 'tachikoma-chat', workspaceId?: workdir, sessionId}`；SQLite 显式绝对路径
  `~/.tachikoma/memory/goodmemory.sqlite`（GoodMemory 默认 cwd 相对路径是坑，必须显式）。
- 第二圈升级项：切换到 `goodmemory/runtime-kit`（`beforeModelCall/afterModelCall/observeToolResult`
  与工具循环 1:1 映射）；配置真实 embedding provider（默认哈希 n-gram 只有词法底座）；`/remember`
  显式记忆命令（带 `annotations.remember='always'`）。

## 4. 质量基线（自本轮起为硬门禁）

- `bun x tsc -p packages/core/tsconfig.json --noEmit`
  **0 错误**（本轮清零了 7 个"被容忍"的历史错误：eval/scorer、regression-generator、remote-metrics、remote-tracer）。
- `bun run typecheck`（含测试 tsconfig）0 错误（本轮清理测试文件类型漂移）。
- `bun test packages` 0 失败（root `test` 脚本与 CI 已改为 `bun test packages`，不再误吞 `test-mvp/`
  样例项目的失败）。
- 新增代码必须带零网络单测（mock 模型注入）。

## 5. 本轮（2026-08-10）落地清单

- 新增
  `packages/core/src/chat/`：`types.ts`（ChatEvent 联合）、`providers.ts`（多 Provider 工厂 + 环境解析）、`session-store.ts`（原子写会话存储）、`system-prompt.ts`、`chat-engine.ts`（fullStream 流式循环 + 中断 + 记忆钩子）、`memory.ts`（GoodMemory 适配）。
- 新增 `tachikoma chat`
  CLI（流式 REPL、`/new /sessions /model /help /exit`、Ctrl+C 两段语义、会话恢复回放）。
- `packages/core` 新依赖：`goodmemory@^0.7.2`；barrel 顶层导出 chat 模块。
- 修复：`LLMRequest.systemPrompt` 改为可选（与运行时行为一致）；eval/observability
  7 个历史类型错误清零；测试文件类型漂移清理；root/CI test 范围修正。
- 验证：28 个 chat 测试全过（含 GoodMemory 真实 API 探针：remember → 跨会话 recall →
  buildContext 注入）；全仓 `bun test packages` 1423+ 全绿；core src tsc 0 错误。

# Tachikoma 桌面化总体开发方案（Alma 对标）

> 状态：已评审定稿（2026-08-10）；同日被 `docs/tachikoma-spiral-roadmap.md`
> 部分修订——协议包/本机 server/Electron 壳/安全模型/打包尖峰继续有效，但引擎核心策略从「AgentEngine 包装 ConversationalRunner」改为「以 ChatEngine 为根逐圈生长」。
>
> **2026-08-11 架构重启（5d2d876）后修订**：本文仍是桌面方向的总设计——协议/壳/安全/打包部分继续有效。引擎侧对接对象更新为第一圈冻结的
> `ChatEvent`
> 契约（每个事件携带 sessionId/turnId 的 message_start/message_delta/reasoning_delta/retry/compaction/memory_status/message_complete，直接服务 §2.3 的 WS 按序重放）与
> `ChatSession`（send/abort/setModel/setThinkingLevel/compact/close）。文中引用的收敛前模块（Orchestrator/ConversationalRunner/tools/mcp/skills/checkpoint 等）已随架构重启删除：**能力清单仍然有效，载体改为按螺旋圈层围绕 ChatSession 契约重建**；旧实现的考古入口是 git
> tag `pre-convergence`。§4.2 StreamEvent
> v2 的结构化事件语义已由 ChatEvent 第一圈子集兑现，工具/审批事件（tool_call/approval\_\*）留待第二圈增量扩展。阶段编号（E0–E10、D-A–D-D）仍作为桌面轨引用坐标。

## 1. 背景与目标

### 1.1 背景

Tachikoma 已在 ChatEngine 直接接入 pi-mono 0.84.1 的模型与工具循环；此前
`docs/tachikoma-pi-mono-fusion-plan.md` 的自研 Tool
Runtime 路线已停止推进。下一个产品方向是把 Tachikoma 演进为一个类似 [alma.now](https://alma.now)
的桌面应用：Local-First、Memory-First 的 AI Agent 桌面端。

Alma 的产品要素（来自官方文档）：统一多 Provider 接入（一键切换模型）、隐私（API
key 与会话史留在本机）、跨会话持久记忆、文件/Shell/网络搜索工具、自定义 Prompt、工作区关联（会话绑定项目目录做编码辅助）、MCP 第三方集成、插件；macOS/Windows/Linux；流式 Markdown 聊天界面。

### 1.2 Tachikoma 引擎能力 ↔ Alma 功能映射

| Alma 功能            | Tachikoma 现有对应物                                                     | 差距                                               |
| -------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| 多 Provider 一键切换 | `chat/providers.ts`（pi provider catalog + 自定义 OpenAI-compatible）    | 会话内跨 provider 切换 UX 与 key 管理仍待桌面化    |
| 流式聊天             | `ChatEngine.sendMessage()` → `AsyncGenerator<ChatEvent>`                 | 引擎已有 token/reasoning/tool 事件，桌面壳尚未接入 |
| 持久记忆             | `memory/`（MemoryService 五种 provider）、`agent-identity/`、`/remember` | CLI 链路未启用 memory；无浏览/管理 UI              |
| 文件/Shell 工具      | `tools/core/`（9 个核心工具）+ `LocalSandbox` 白名单                     | 桌面端需要把审批/白名单做成 UI 权限门              |
| 网络搜索             | `tools/core/web-search.ts`（Brave/SerpAPI/Tavily/DuckDuckGo）            | 去留待定（CONTINUITY 结转项）                      |
| 工作区关联           | `workDir` + `<workDir>/.tachikoma/` 会话树                               | 即 Alma 的 workspace 概念，天然对齐                |
| MCP 集成             | `mcp/`（stdio+HTTP 双传输、Cursor/Claude Desktop 配置识别）              | 无管理 UI                                          |
| 自定义 Prompt/插件   | `skills/`（SKILL.md 三级渐进披露、轨迹学习）                             | 无技能库 UI                                        |
| 撤销/回滚            | Checkpoint（git 快照）+ `/undo` `/checkpoints`                           | 无时间线 UI；`interrupt()` 是空壳                  |

结论：引擎侧能力几乎一一对应，缺的是「可嵌入的干净边界」与「桌面壳」。因此本方案的重心是：**先把引擎做成可嵌入的 Agent
Engine（协议 + 门面 + 生命周期 + 审批 API），再在其上建桌面应用**。

### 1.3 成功标准

- 桌面 App 可安装可分发（签名/公证/自动更新），首次运行无需安装 Bun。
- 引擎以 sidecar 二进制形式被桌面壳托管，崩溃可恢复、退出无孤儿进程。
- 渲染进程只依赖 `@tachikoma/protocol`（纯类型 + zod），不透明拖入 ioredis/level/qdrant/playwright。
- 现有两个 CLI（`packages/core/bin/tachikoma.ts`、`packages/cli`）在每个阶段合入后行为不回归。
- 审批（HITL）从「文件轮询竞态」变为一等公民 API，同时修复现有 CLI 与自动仲裁的竞态缺陷。

## 2. 目标架构

### 2.1 三进程模型

```
┌──────────────────────────┐  spawn/监督/进程树击杀   ┌────────────────────────────────┐
│ Electron main（壳）       │────────────────────────▶│ Bun sidecar: tachikoma-engined │
│ 窗口/菜单/托盘/deep link   │  stdin: token+key 引导   │ @tachikoma/server (HTTP+WS)    │
│ safeStorage(keychain)    │  stdout: {"listening"}   │  └ AgentEngine 门面            │
│ 自动更新/崩溃恢复          │◀── /healthz + WS ping ──│     └ ConversationalRunner     │
└───────────▲──────────────┘                          │        └ Orchestrator/Workers  │
            │ contextBridge（极薄：                     │ 会 spawn: MCP stdio/LSP/       │
            │ serverInfo、keychain、原生对话框）          │ dev-server/(Docker)            │
┌───────────┴──────────────┐                          └───────────────▲────────────────┘
│ Renderer (React 19)      │      HTTP /v1 + WS /ws（127.0.0.1，Bearer token）
│ 仅依赖 @tachikoma/protocol │──────────────────────────────────────────┘
└──────────────────────────┘
```

### 2.2 进程基数：v1 每个 workspace 一个 sidecar

两条设计轨道在此有分歧，裁决如下：**v1 采用「每个 workspace（workDir）一个 sidecar 进程」**。

- 理由：core 存在模块级单例（`globalToolRegistry` at
  `packages/core/src/tools/registry.ts:309`、`worker-executor.ts:150-152` 的 `MCPToolRegistrar`
  会向其注入 per-project 的 MCP 工具；另有
  `globalConfig`、`ShellSessionManager`、`FileLockManager`、LSP states
  map）。同进程跑两个项目会交叉污染。进程隔离直接绕开该问题，正确性优先于内存占用。
- `AgentEngine.create()` 对同进程第二个不同 `workDir` 直接抛错，把约束显式化。
- 同一 workspace 的多个会话共享一个引擎（per-session Orchestrator 已支持）。
- 共享引擎（一个 sidecar 服务 N 个项目）留给远期 E10 去单例化之后，由壳侧 supervisor 平滑切换（壳管理
  `Map<workDir, SidecarHandle>`，未来收敛为 1 个 handle 即可，UI 无感）。

### 2.3 传输与握手

- **监听**：sidecar 绑定
  `127.0.0.1:0`（随机端口），向 stdout 输出恰好一行 JSON：`{"event":"listening","port":N,"pid":N,"engineVersion":"…","protocolVersion":…}`；壳 10s 超时读取。
- **鉴权**：壳生成 256-bit 随机 token，经 **stdin** 第一行注入（不走 argv——`ps`
  可见；不走 env——会泄漏给引擎 spawn 的 MCP/LSP/dev-server 子进程）。HTTP 全部要求
  `Authorization: Bearer`；浏览器 `WebSocket` 无法带 header，用 `POST /v1/auth/ws-ticket` 换 30s
  TTL 一次性 ticket → `ws://127.0.0.1:PORT/ws?ticket=…`。
- **来源校验**：带 `Origin` 头但非本 App 来源的请求一律拒绝；body 限长。
- **事件序号与重放**：server 是 `handleMessage()` 生成器的唯一消费者，负责给每个事件分配会话内单调
  `seq`，**先写 WAL**（`<sessionDir>/<sessionId>/events.jsonl`）再扇出到 WS。客户端以
  `{sessionId, fromSeq}`
  订阅，server 重放 WAL 尾部再接续实时流——窗口刷新、断线、sidecar 重启均无损。现有 per-worker
  `thinking.jsonl`/`actions.jsonl` 仍是取证真源，可用于重建 WAL（仅恢复路径）。
- **健康与崩溃恢复**：WS ping 10s +
  `on('exit')`；意外退出按指数退避重启（60s 窗口最多 3 次），超限进入「引擎已崩溃」页并附日志（stderr
  tee 到
  `userData/logs/engined.log`）。重启后 UI 按 seq 游标重放补齐；进行中的 turn 不自动续跑，提供「从最近 checkpoint 恢复」（引擎每 15s 自动存档）。
- **退出保障（防孤儿）四层**：① `before-quit` → `POST /v1/shutdown` →
  `engine.dispose()`（5s 预算）；② SIGTERM，sidecar 捕获后同样 dispose（3s）；③ 强杀：POSIX 用
  `detached:true` 让 sidecar 自领进程组后 `kill(-pid)`，Windows 用
  `taskkill /pid <pid> /T /F`；④ 收割者：sidecar 维护
  `~/.tachikoma/runtime/engine-<pid>.json`（子进程 PID+启动时间防复用、Docker 容器 ID，容器打
  `tachikoma.managed=true` 标签），下次启动收割残留；sidecar 自身以 `--parent-pid`
  看门狗在壳死亡后自杀。

## 3. 关键决策记录（ADR）

| #   | 决策                                                                                                                                                                                          | 理由                                                                                                                                                                                                                                                                                  | 备选与回退                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 桌面壳用 **Electron**（electron-vite + electron-builder）                                                                                                                                     | 单人 TS 开发者：main/preload/renderer/引擎一种语言一套工具链；compiled Bun sidecar ~90-100MB 抹平 Tauri 体积优势的大半；流式聊天 UI 在单一 Chromium 上避免 WKWebView/WebView2/WebKitGTK 三矩阵；`safeStorage` 零原生依赖拿到 keychain；electron-updater + notarytool 是最成熟分发路径 | Tauri 2 回退可行：业务全在 sidecar，壳极薄。切换成本= externalBin+shell 插件、stronghold/keyring 替代 safeStorage、tauri-plugin-updater、Rust 写监督逻辑、加双 WebView 测试 |
| D2  | 本机 API 用**新建 `packages/server`**，不改造 gateway                                                                                                                                         | gateway 的 JWT/RBAC 多租户信任模型不适合单用户 localhost；其 20 条业务路由 16 条是 mock 且从未调用 core；A2A 路由未挂载。server 保持极简、protocol-pure                                                                                                                               | gateway 保留为未来远程/团队部署与 A2A 实验面；其 **output-filter/trace/logger 中间件作为库复用**（对事件文本做密钥/PII 脱敏后再进 UI 与 WAL）                               |
| D3  | 引擎保持 **Bun**，以 `bun build --compile` 出单文件 sidecar；不做 Node 移植                                                                                                                   | 嵌入形态是 sidecar，Node 兼容不带来收益，却要为 AI SDK beta/Claude SDK/fs.watch 语义付全矩阵测试成本                                                                                                                                                                                  | 仍做廉价可移植性收尾（E9）：2 个 sandbox 驱动改 `node:child_process`、`level` 改懒加载——门留着                                                                              |
| D4  | v1 每 workspace 一个 sidecar（§2.2）                                                                                                                                                          | 单例交叉污染；显式抛错防误用                                                                                                                                                                                                                                                          | E10 去单例化后可切共享引擎                                                                                                                                                  |
| D5  | 「扁平化 Orchestrator」重构（`docs/向claude code对齐计划.md.resolved` 第 1 阶段）**推迟到门面+协议之后**                                                                                      | 该文档自述会破坏所有下游消费者；协议做**拓扑无关**设计（subtask 事件可选，golden 测试跑 orchestrated + flat 两套 profile），门面成为屏蔽层，将来扁平化对客户端不可见；pi-mono 融合刚落地，不叠加第二个全引擎重构                                                                      | E5 落地后重新评估                                                                                                                                                           |
| D6  | 数据位置维持现状：全局 `~/.tachikoma/`（identity/全局 skills/全局 MCP/runtime 收割清单），项目 `<workDir>/.tachikoma/`；壳自身状态（窗口几何/密文/更新缓存/日志）在 `app.getPath('userData')` | 与 CLI 及现有会话完全兼容；`EnginePaths` 允许桌面覆盖 `dataDir`/`identityDir`                                                                                                                                                                                                         | —                                                                                                                                                                           |
| D7  | 代码在**本 monorepo**：`packages/protocol` + `packages/server` + `packages/desktop`（现有 `packages/*` workspace glob 已覆盖）                                                                | 与 core 共享类型是最大资产；协议年轻期需要原子跨包改动                                                                                                                                                                                                                                | 独立仓库损失原子改动、增加版本同步摩擦，不选                                                                                                                                |

用户已确认的决策：D1（Electron）、D7（monorepo）、方案文档中文、本次会话仅交付方案文档。

## 4. 接口设计（现在预留的嵌入边界）

### 4.1 `@tachikoma/protocol`（E1）

> 2026-08-12：本节的实现级设计已细化于 `docs/tachikoma-protocol-design.md`
> （对齐架构重启后的 ChatEvent/ChatSession 契约，含方法表、帧模型、演进与测试规则）；本节保留为总设计语境。

**定位**：纯类型 + zod schema，renderer 安全（无 bun/node types、无 DOM 依赖、仅依赖
`zod`）。desktop 永不直接依赖 `@tachikoma/core`。

```
packages/protocol/
  package.json          # 仅依赖 zod
  src/index.ts
  src/version.ts        # PROTOCOL_VERSION + Hello 握手 DTO（capabilities 特性探测）
  src/json.ts           # JsonValue/JsonObject
  src/events.ts         # StreamEvent v1+v2 联合 + zod + safeParseStreamEvent()
  src/session.ts        # SessionSummary / ConversationMessageDTO / CheckpointDTO
  src/task.ts           # TaskDTO / TaskResultDTO / ArtifactDTO（可序列化镜像）
  src/approval.ts       # ApprovalRequestDTO / ApprovalDecision / ApprovalResolvedDTO
  src/config.ts         # LLMSettings / EngineOptionsDTO / EnginePathsDTO
  src/rpc.ts            # RpcRequest/RpcResponse/StreamFrame 信封 + 方法名常量
  test/contract/        # schema 往返 + golden fixtures
```

**迁移 vs 镜像**：

- **迁移（core 侧 re-export 保持兼容）**：`conversation/types.ts:135-247` 的整个 StreamEvent 家族 +
  `ConversationMessage`/`ExecutionSummary`/`Checkpoint`。注意 `PlanGeneratedEvent`
  现引用 orchestrator 内部类型 `SubTask`/`PlannerRole`——协议侧改为可序列化
  `SubTaskDTO {id, objective, description?, dependencies, roleId?, status?}` 与
  `RoleDTO {id, name, responsibilities}`，core 的 re-export 保持既有名字不破坏
  `bin/tachikoma.ts`、`packages/cli`、barrel 与测试。
- **镜像（DTO + mapper，core 类型不动）**：`Task`/`TaskResult`/`Artifact`（core `src/types.ts`
  版本携带非可序列化 context）；`PendingApprovalFile`（`orchestrator/session/types/worker.ts:103`）→
  `ApprovalRequestDTO` **字段名保持一致**，使文件侧通道与协议位兼容。`SessionState` 保持内部（其
  `variables` 装运行时记录），对外只给：

```ts
export interface SessionSummary {
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
  workDir: string;
  title?: string;
  messageCount: number;
  waitingForUser: boolean;
  pendingQuestion?: string;
  activeRun?: { taskId: string; startedAt: number };
}
```

**序列化铁律（契约测试强制）**：禁 `Date`/`Map`/`Set`/类实例/函数；时间戳一律 epoch-ms
number；`unknown` 槽位一律 `JsonValue`；每个 fixture 必须通过
`parse(JSON.parse(JSON.stringify(x)))`。

**版本策略**：`PROTOCOL_VERSION {major, minor}` +
`Hello {protocolVersion, engineVersion, capabilities: string[]}`。仅增量演进：新事件类型/新可选字段 bump
minor；删改字段必须 bump major（尽量避免，宁可加新事件类型）。`capabilities`（如
`'token-streaming'`、`'approvals.escalation'`）让桌面做特性探测而非版本嗅探。CI 守卫：契约测试对 schema 形状做快照（zod
→ 排序 JSON
Schema），形状变化而版本号未 bump 则 CI 失败。客户端对未知事件类型必须**容忍跳过**（`safeParseStreamEvent`
返回 `{ok:false, unknownType}`），这是向前兼容契约。

### 4.2 StreamEvent v2（E3/E4/E7，全部增量）

**4.2.1 结构化工具事件（杀掉 regex）**。现状：backend 产出的 `WorkerMessage`
本就结构化（`worker/types.ts:81` `tool_call {tool, input}`、`:92`
`tool_result {tool, success, result, duration}`），但
`WorkerExecutor.persistMessage`（`worker-executor.ts:798`）把它压平成 `ActionRecord.description`
字符串，runner 再用正则捞回（`conversational-runner.ts:1451` `/^Calling tool:/`、`:1471`
`/^Tool result:/`）。改造（发射点不动，只加结构）：

1. `WorkerMessage` 的 `tool_call`/`tool_result` 增加可选 `callId`（Claude backend 映射 SDK
   `tool_use.id`；generic backend 生成 `call-<uuid>`；OpenAI backend 映射其 call id）。
2. `ActionRecord` 增加可选结构化字段：call 侧
   `params: {tool, input, callId, phase:'call'}`（tool/input 已有，补 callId/phase）；result 侧现在完全没有
   `params`，补 `params: {tool, callId, phase:'result'}`。description 字符串保留（CLI/JSONL 兼容）。
3. runner 的 `onWorkerAction` 优先读
   `params.phase`，regex 作为旧 JSONL 回放的 fallback 保留一个版本后删除。
4. `ToolCallEvent`/`ToolResultEvent` 增加可选
   `callId`/`workerId`/`subtaskId`（后两者本就在事件包络上，现在被丢弃）。

**4.2.2 新增事件类型**（runner 从今天订阅 8 个 orchestrator 事件扩到覆盖所需）：

| 新 StreamEvent                                                           | 来源                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `run_started {taskId}` / `run_finished {taskId, status}`                 | `runWithOrchestrator` 包住 `orchestrator.run()`                               |
| `progress {completedSubtasks, totalSubtasks, currentSubtaskId?, todos?}` | `subtask:progress` + todo 快照（补齐 fusion 计划 P1-1 的「UI 显示计数」欠账） |
| `subtask_retrying {subtaskId, attempt, reason?}`                         | `subtask:retrying`                                                            |
| `checkpoint_created {checkpointId, description?}`                        | `checkpoint:created`                                                          |
| `interrupted {reason?}`                                                  | 新的真 `interrupt()` 路径                                                     |
| `approval_request` / `approval_resolved`                                 | §4.4                                                                          |
| `message_delta {text, workerId?, subtaskId?}`                            | §E7 token 流式（ephemeral，不落 JSONL）                                       |

另：`worker:thinking` 解除 `config.verbose` 门控（`conversational-runner.ts:1428`）——新 runner 选项
`streamWorkerEvents`（引擎设 true，CLI 保持 verbose 语义不变）。

**4.2.3 拓扑无关规则**（保护 D5）：客户端**不得假设** `plan_generated`/`subtask_*`
一定出现；单循环引擎可以只发 thinking/tool/message/progress。写入 protocol README，并用两套 golden
profile（orchestrated / flat）编码进测试。

### 4.3 `AgentEngine` 门面 + 生命周期（E2）

**包装而非重写**
`ConversationalRunner`（1,698 行，稳定）：门面加生命周期/审批/中断语义，runner 只加三个增量方法（`dispose`、`respondToApproval`、真
`interrupt`）。位置：`packages/core/src/engine/`，subpath export `"./engine"`。

```ts
export interface EngineOptions {
  workDir: string; // 必填——无 process.cwd() 回退
  dataDir?: string; // 默认 join(workDir, '.tachikoma')
  identityDir?: string; // 默认 ~/.tachikoma
  llm: LLMSettings; // {provider, model, apiKey, baseUrl?}
  approval?: { mode: 'auto' | 'escalate'; timeoutMs?: number };
  mcp?: { configPath?: string };
  logSink?: LogSink; // E8
  enableCheckpoints?: boolean;
}
export class AgentEngine {
  static create(opts: EngineOptions): Promise<AgentEngine>; // 同进程第二个 workDir → throw
  createSession(): Promise<SessionSummary>;
  openSession(id: string): Promise<EngineSession>;
  listSessions(): Promise<SessionSummary[]>;
  dispose(): Promise<void>; // 幂等全量清理
}
export interface EngineSession {
  sendMessage(text: string): AsyncGenerator<StreamEvent>;
  resumeFromCheckpoint(opts?: ResumeOptions): AsyncGenerator<StreamEvent>;
  respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  interrupt(): Promise<void>;
  getSummary(): Promise<SessionSummary>;
  close(): Promise<void>;
}
```

**`dispose()` 清理链**（修复「泄漏 MCP 子进程/watcher/定时器」）：新增
`ConversationalRunner.dispose()`——遍历 `orchestrators` 调
`orchestrator.cleanup()`（已存在的级联：workerPool.shutdown → WorkerExecutor/backend dispose + MCP
registrar 反注册；memoryService.close；collaborationManager.stop；SessionLifecycleManager.closeSession
→ deviation/watcher/CheckpointManager 停止——**零件都在，只是没人调**）→
`mcpClient.disconnectAll()`（`mcp/client.ts:238`，杀 stdio
MCP 子进程）→ 清空 maps。`AgentEngine.dispose()`
另加：LSP 关停、shell 后台会话、`ChildProcessRegistry.killAll()` 兜底、flush 日志 sink。

**`ChildProcessRegistry`**（`engine/process-registry.ts`）：`register(proc) → unregister`、`killAll(graceMs)`（SIGTERM→等待→SIGKILL）、`list()`。通过模块级
`setActiveProcessRegistry()`
钩子注入，四类 spawn 点接入：`sandbox/drivers/local.ts:914`（已有自跟踪，整合）、`docker.ts:94`（记容器 id 供
`docker rm -f`）、MCP stdio transport、`lsp/server.ts`、shell session manager。

**真 `interrupt()`**：替换 `conversational-runner.ts:858` 的空壳（现在只设
`waitingForUser=true`）。中断管线**已存在**：`BaseAgent` 有 AbortController 与
`executeTask(task, signal)`（`abstracts/base-agent.ts`），`WorkerExecutor.interrupt()` →
`backend.interrupt()`
也在——这是接线不是造件。补充：审批等待轮询（`base-backend.ts:791`）也要观察 abort 信号，让中断能取消挂起的审批等待。完成后向流推
`interrupted` 事件并持久化会话状态。

**`EnginePaths`**（E6）：`resolveEnginePaths({workDir, dataDir?, identityDir?})` →
`{workDir, dataDir, sessionsDir, checkpointsDir, skillsDirs, mcpConfigPath, identityDir, logsDir}`；默认值精确保持今天的磁盘布局（兼容既有会话）。随之做
`process.cwd()` 清扫（18 个文件，见 §5），并加 eslint `no-restricted-syntax` 禁止 core src 再出现
`process.cwd()`。

### 4.4 审批 HITL 一等公民化（E4）

**现状缺陷（已核实，比预想严重）**：`ApprovalArbitrationService.handlePendingApproval`（`approval-arbitration.ts:127`）**总是立刻自动裁决**——所有分支都终于
`approvePendingApproval()` 写回 `approval_response.json`（`respondedBy:'orchestrator'`；默认策略
`defaultDecision:'approve'`，仅 `dangerous_operation`
自动拒绝）。不存在「等人」状态；CLI 的 1s 轮询（`bin/tachikoma.ts:178-275`）在跟进程内仲裁赛跑、且通常跑输。另一个被误读的事实：**runner 的事件队列是 push 型、审批期间并不阻塞**（阻塞的是 worker 的 WorkerMessage 生成器，挂在
`waitForApprovalViaFileProtocol`
的 1s 轮询里，`base-backend.ts:791`）——`approval:received`/`approval:complete`
事件今天就能流出，只是没人订阅。

**方案**（文件侧通道保留为传输层，CLI 字节级兼容）：

1. `ApprovalPolicy` 增加 `escalationMode?: 'off' | 'unmatched' | 'all'`（默认 `'off'`
   = 今天行为，零变化）。`'unmatched'`：走到 defaultDecision 兜底分支时**不写响应**，改发 orchestrator 事件
   `approval:escalated`（携带完整 `PendingApprovalFile`），并起 per-request 定时器；到期**先重读**
   `approval_response.json`（人/CLI 可能已写）再写默认裁决。
2. runner 订阅 `approval:escalated`/`approval:complete`，推流
   `approval_request {requestId, workerId, subtaskId, approvalType, description, details, expiresAt, defaultDecision}`
   与 `approval_resolved {requestId, approved, respondedBy:'user'|'policy'|'timeout', reason?}`。
3. `ConversationalRunner.respondToApproval(sessionId, requestId, {approved, reason?})`：从 pending 表（`approval:escalated`
   填充；fallback 扫 `listPeerWorkers()`+`readPendingApproval()`）解析 workerId，调
   `sessionManager.writeApprovalResponse(...)`（`respondedBy:'human'`）。worker 既有轮询原样收到。
4. CLI 建议同步开
   `escalationMode:'unmatched'`——顺带修掉今天的竞态。`need_user_input`（planner 澄清）与审批保持两条独立通道（回复走
   `sendMessage`，审批走 `respondToApproval`）。

### 4.5 Server RPC 与 HTTP 面（E5 + D 轨）

**信封**（`protocol/src/rpc.ts`，JSON-RPC 形但极简）：

```ts
type RpcRequest = { id: string; method: string; params?: JsonObject };
type RpcResponse = { id: string; result?: JsonValue; error?: { code: string; message: string } };
type StreamFrame =
  { sub: string; sessionId: string; seq: number; event: StreamEvent } | { sub: string; done: true };
```

**WS 方法**：`engine.hello`、`session.subscribe {sessionId, fromSeq}`、`session.sendMessage`（返回 sub
id，事件成帧续流）、`session.interrupt`、`session.respondToApproval`、`session.resumeFromCheckpoint`、`logs.subscribe`、`engine.shutdown`。

**HTTP `/v1`（CRUD，全部映射到既有引擎能力）**：

| 端点                                                                                            | 前端的引擎能力                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /meta`、`POST /auth/ws-ticket`                                                             | 握手/鉴权（§2.3）                                                                                                                                    |
| `POST /sessions {workDir,title?}`、`GET /sessions`、`GET /sessions/:id`                         | runner pool（E2 前）/ `AgentEngine`（E2 后）+ 跨工作区索引 `~/.tachikoma/desktop/sessions-index.json`                                                |
| `POST /sessions/:id/messages`                                                                   | `handleMessage()`；斜杠命令原样透传（引擎已处理 `/undo /checkpoints /continue /retry /clear /help /init /remember /skill`）                          |
| `POST /sessions/:id/interrupt`                                                                  | 真 `interrupt()`（E2 前的过渡 fallback：弃流 + backend dispose + 引导 checkpoint 恢复）                                                              |
| `GET/POST /sessions/:id/approvals*`                                                             | §4.4 审批桥（E4 前用 `SessionWatcher` + 轮询桥接文件协议）                                                                                           |
| `GET /sessions/:id/checkpoints`、`POST .../:cpId/resume`                                        | `SessionState.checkpoints`、`resumeFromCheckpoint()`                                                                                                 |
| `GET /sessions/:id/files?path=`、`GET /sessions/:id/artifacts`、`GET /sessions/:id/diff`        | workDir/`workers/*/artifacts`（realpath 越界防护）、git diff（checkpoint 即 git 快照）                                                               |
| `GET/PUT /settings`、`GET/PUT /providers`、`PUT /providers/:id/key`、`POST /providers/:id/test` | 桌面设置（**响应永不含密钥**，key 仅存 sidecar 内存，spawn 时 stdin 引导 + 变更时该端点热更新）；按角色模型 `{planner,orchestrator,worker}` 先存后用 |
| `GET/PUT /mcp/servers`、`POST /mcp/servers/:name/test`                                          | `mcp/config.ts` 发现链（`.tachikoma/mcp.json`、`~/.cursor/mcp.json`、Claude Desktop 配置）读/并/写 + 连接测试 + 热重启 MCP client                    |
| `GET /skills*`                                                                                  | `~/.tachikoma/skills` + `<workDir>/.tachikoma/skills` 三级披露                                                                                       |
| `GET/POST /memory*`                                                                             | `MemoryService`（桌面链路启用；默认 provider 必须纯 JS，见 E9）                                                                                      |
| `POST /shutdown`                                                                                | 优雅退出（壳专用）                                                                                                                                   |

发现文件：`<dataDir>/server.json`（0600，`{port, pid}`；token 不落盘）。`--selftest`
标志（MockLLMClient 起引擎跑平凡任务后 dispose 退出）供 CI compile-smoke 用。stdio
NDJSON 模式（同信封）作为可选传输保留给未来 Tauri 形态。

## 5. 现状差距清单（全部经 file:line 核实）

### 5.1 阻塞级（必须在对应阶段修）

| #   | 问题                                                                                                                                                                                   | 位置                                                                                                                                 | 修复阶段          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| B1  | `ConversationalRunner` 无 `dispose()`；`Map<sessionId,Orchestrator>` 与 MCPClientManager 永不释放 → 长驻进程泄漏 MCP 子进程/fs.watch/定时器（`Orchestrator.cleanup()` 存在但无人调用） | `conversational-runner.ts`                                                                                                           | E2                |
| B2  | `interrupt()` 空壳，只设 `waitingForUser`                                                                                                                                              | `conversational-runner.ts:858`                                                                                                       | E2                |
| B3  | 审批自动仲裁与人响应竞态；默认 `approve`；无「等人」状态                                                                                                                               | `approval-arbitration.ts:127`（`approvePendingApproval` at :201/:214/:281）；worker 轮询 `base-backend.ts:791`（call site :739，1s） | E4                |
| B4  | `tool_call`/`tool_result` 靠 regex 从描述串捞回；结构化数据在 `persistMessage` 被压平                                                                                                  | `conversational-runner.ts:1451,1471`；`worker-executor.ts:798`；真源 `worker/types.ts:81,92`                                         | E3                |
| B5  | `worker:thinking` 被 `verbose` 门控吞掉                                                                                                                                                | `conversational-runner.ts:1428`                                                                                                      | E3                |
| B6  | provider 硬编码 `'openai'`（4 处）——多 Provider 的直接障碍                                                                                                                             | `conversational-runner.ts:796,982,994,1141`                                                                                          | E6                |
| B7  | 无 token 级流式（`generateText`）                                                                                                                                                      | `planner/llm-client.ts`                                                                                                              | E7（尖峰 B 把关） |
| B8  | `level` 原生插件被 import core 即静态加载 → `bun build --compile` 与瘦客户端的拦路虎                                                                                                   | `src/index.ts:336` → `memory/index.ts:11` → `providers/leveldb.ts:1`                                                                 | E9                |
| B9  | `Bun.spawn` 残留在 2 个 sandbox 驱动（generic backend 无条件 import `createLocalSandbox`）                                                                                             | `sandbox/drivers/local.ts:914`、`docker.ts:94`                                                                                       | E9                |
| B10 | 无共享协议包；gateway 已 fork 出有损事件类型                                                                                                                                           | `gateway/src/a2a/executor.ts:55`                                                                                                     | E1                |
| B11 | Claude SDK backend 默认 `permissionMode:'bypassPermissions'`                                                                                                                           | `claude-agent-backend.ts`                                                                                                            | D-B 安全门（§8）  |

### 5.2 摩擦级

- `process.cwd()`
  回退 18 个文件（清扫清单）：`agents/worker-agent.ts`、`eval/examples/verify-flywheel.ts`、`mcp/config.ts`、`mcp/tool-bridge.ts`、`orchestrator/engines/checkpoint-resume-engine.ts`、`orchestrator/orchestrator.ts`、`orchestrator/runner/execution-loop.ts`、`orchestrator/runner/worker-manager.ts`、`orchestrator/types.ts`、`tools/rag/{hybrid-search,index,upsert}.ts`、`worker/backends/{base,claude-agent,generic-agent,openai-agent}-backend.ts`、`worker/prompts/system-prompt.ts`、`worker/worker-executor.ts`（E6）。
- 相对默认路径（`'.tachikoma'`、`'.tachikoma/checkpoints'`、`'.tachikoma/skills'`）按 CWD 解析（E6，`EnginePaths`
  统一）。
- 四套不统一的配置系统：`config/loader.ts`、`orchestrator/config.ts`、散装 env
  resolver（`session-compaction-env.ts`/`tool-runtime/feature-flags.ts`/lsp）、文件配置——E6 以
  `resolveEngineConfig()` 单入口收敛（内部复用现有件；resolver 已参数化 env，改造小）。
- feature flag 以 `TACHIKOMA_*`
  字符串塞进 worker 子进程 env（`worker-manager.ts:153-159`）——记录在案，E6 顺手改为显式参数。
- 同步阻塞调用：`execSync`（`prompt/system-prompt/env-info.ts:48,61`）、`readFileSync`
  系（verification-gate）——E9。
- 每 run 启动的定时器/watcher 群（SessionWatcher 300ms、CheckpointManager
  15s、DeviationDetector、worker 心跳、collaboration 轮询、WorkingMemory 自动保存、Docker 空闲检查）都有
  `stop()` 但无统一属主——E2 归 `dispose()` 统管。
- 中文 `console.*` 日志散布 ~25 文件未走 Logger；`agentops-client.ts` 硬编码
  `http://localhost:3002`——E8。

### 5.3 卫生级（E0 顺手修）

- ~~根 `package.json` 误加空 npm 包 `"gateway": "^1.0.0"`~~（2026-08-11 已删除）。
- ~~`packages/core/bin/verify_tools.ts` import
  4 个已删除文件，无法运行~~（2026-08-11 已删除死探针及同样失效的 `idea` CLI 门面）。
- 两个 CLI 的事件 `switch` 无 `default:` 分支——加 no-op default 即是 StreamEvent
  v2 的全部 CLI 兼容故事。
- `bun run build:core` 产物 `dist/` 实际缺失而 `packages/cli` 的 `main` 指向它。
- `.env.example` 漂移（`REDIS_URL`/`LEVELDB_PATH` core 从不读；`SANDBOX_*` 前缀与 loader 的
  `TACHIKOMA_SANDBOX_*` 不符）；README 工具表/开发状态过期；`servers/_client.ts` 的
  `@tachikoma/core/mcp/sandbox-ipc` 子路径不在 core exports map（运行时会挂）。

## 6. 分阶段实施计划

### 6.1 引擎轨（E）

| 阶段 | 内容                                                                                                                                                | 规模 | 依赖                   | 对桌面轨的解锁                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------- | ------------------------------------- |
| E0   | 尖峰验证（§7.1 A/B/C）+ §5.3 卫生修复                                                                                                               | S    | —                      | 数据决定 E5/E7/E9 细节                |
| E1   | `@tachikoma/protocol`（§4.1）+ 契约测试 + core re-export                                                                                            | M    | E0                     | **UI 可对 fixtures/mock server 开发** |
| E2   | `AgentEngine` 门面 + `dispose()` + `ChildProcessRegistry` + 真 `interrupt()` + 单 workDir 守卫                                                      | M    | E1                     | 中断按钮、退出保障                    |
| E3   | StreamEvent v2 结构化事件（4.2.1/4.2.2，3a/3b 可并行）                                                                                              | M    | E1,E2                  | 活动面板保真                          |
| E4   | 审批升级 + `respondToApproval`（§4.4，顺带修 CLI 竞态）                                                                                             | M    | E2,E3                  | 审批 UX                               |
| E5   | `packages/server` sidecar + WS/WAL/重放 + `--selftest` + compile 目标                                                                               | M    | E1,E2（与 E3/E4 并行） | **端到端集成**                        |
| E6   | `EnginePaths` + cwd 清扫 + `resolveEngineConfig` + 干掉硬编码 provider                                                                              | M    | E2（与 E3-E5 并行）    | 多 Provider、app-data 覆盖            |
| E7   | token 流式：`LLMClient.streamComplete?` 增量钩子 + `worker:delta` ephemeral 事件（**不落 JSONL**）+ 三 backend 接线                                 | M    | E3 + 尖峰 B            | 打字机效果                            |
| E8   | `LogSink` + ring buffer + `logs.subscribe`；console 清扫（热路径优先）+ eslint no-console；agentops endpoint 可配                                   | S    | E2                     | 调试面板                              |
| E9   | 可移植性收尾：2 个驱动改 `node:child_process`（兼作 Registry 接入点）、`level` 改 `await import` 懒加载 + 纯 JS 默认 memory provider、execSync 改造 | S/M  | 出二进制前             | 打包解锁                              |
| E10  | 去单例化（`ToolRegistry` 实例化下沉、MCP registrar/Shell/FileLock/LSP 按引擎作用域）→ 支持共享 sidecar                                              | L    | 远期                   | 多项目单进程（可选）                  |

### 6.2 桌面轨（D）

| 阶段               | 内容                                                                                                                                                                                                                                                                                                                           | 规模 | 引擎前置                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------ |
| D-A 行走骨架       | `packages/desktop`（electron-vite）单窗口；dev 模式 sidecar 直接 `bun run packages/server`；聊天线程（流式 Markdown）+ 最小活动面板 + 审批卡，对真实 workspace 端到端                                                                                                                                                          | M    | 仅 E1（E5 前可先用薄 server 原型；对今天的 runner 原样可跑） |
| D-B 会话/安全/控制 | 工作区/会话侧栏 + 跨工作区索引；checkpoint 时间线 + `/undo`/恢复对话框；中断按钮；设置页：Provider/密钥（safeStorage）+ 模型选择（含按角色，UI 先行）；沙盒白名单面板（`LocalSandbox` 的 argv 白名单/网络 allowlist/越界防护配置化展示）；kill-tree/收割者硬化；断线重连打磨                                                   | M    | E2（真中断）、E4（审批策略）                                 |
| D-C 打包 alpha     | 三平台 compile sidecar；electron-builder（mac dmg+zip 分 arm64/x64、Win NSIS、Linux AppImage+deb）；签名+公证（sidecar 列入 extra binaries 一起 hardened runtime 签名；entitlements：`allow-jit` 等——尖峰 1 定）；electron-updater beta 通道；引导向导（Provider→key→首个工作区→MCP 导入）；崩溃恢复 UX；遥测 opt-in（默认关） | L    | E5（compile+selftest）、E9（level 懒加载）                   |
| D-D Alma 对齐 v1   | MCP 管理 UI（+Cursor/Claude Desktop 导入）；技能库 UI（含「轨迹学得」徽标）；记忆浏览器（server 启用 MemoryService）；多 Provider 注册表 + 一键切换 + 按角色模型；token 流式渲染；diff/artifacts 打磨；多窗口；Ops 视图（收编 agentops 的 Dashboard/Charts/StatCard，喂真实观测数据）                                          | L    | E6（provider 配置）、E7（流式）、E3（结构化事件）            |

**渲染层栈**：React 19 + Vite 7 + Tailwind v4（自 agentops 平移）；TanStack Query ^5（HTTP CRUD）+
Zustand ^5（WS 实况 reducer/审批队列/连接状态）；react-markdown +
remark-gfm、shiki 懒加载、@tanstack/react-virtual（长事件流虚拟化）。MVP 组件清单：AppShell、SidebarWorkspaces、SessionList、ChatThread、MessageBubble、ThinkingBlock、Composer（斜杠命令提示）、ActivityPanel、PlanGraph、SubtaskRow、ToolCallRow、ApprovalCard（风险徽标/受影响文件/diff 预览/倒计时显示 defaultDecision）、CheckpointTimeline、RestoreDialog、ConnectionBanner、SettingsProvidersPane、OnboardingWizard。

### 6.3 关键路径与合入条件

- 关键路径：**E0 → E1 → E2 → E5 → D-A 集成**；E3/E4/E6 在 capability
  flag 后面并行增益；D-A 的 UI 开发在 E1 后即可对 fixtures 起步。
- 每阶段合入条件：`bun test` + `tsc -b` 全绿；两个 CLI 冒烟（`test-mvp/`
  流程）无回归；协议 schema 快照与版本号一致。

## 7. 验证与测试策略

### 7.1 先行尖峰（按序执行，E0）

1. **尖峰 A：`bun build --compile` 含 core**。10 行入口 import `@tachikoma/core`
   创建 runner；预期失败模式 = `level`（classic-level N-API）；用
   `--external level --external playwright`
   与模拟懒加载补丁重试。产出：单二进制 go/no-go 结论 + 精确 external 清单。
2. **尖峰 B：AI SDK v6 beta `streamText` × OpenRouter/Anthropic**。验证 text delta、流式 tool
   call、最终 usage；锁定通过的确切版本号（现装 `ai@6.0.0-beta.165`）。把关 E7。
3. **尖峰 C：Claude Agent SDK partial messages**。确认 `@anthropic-ai/claude-agent-sdk@0.1.74`
   的增量消息选项与 delta 形状。
4. **桌面尖峰（D-C 前）**：签名+公证 compiled sidecar 于 macOS
   arm64 干净机过 Gatekeeper（失败回退：随包分发 `bun` runtime + JS
   bundle，体验同、体积略增）；WS 万级事件重放（杀 sidecar 中途重启，seq 游标无缝；慢消费者不得反压引擎生成器——server 必须先落 WAL 再发送）；打包后
   `fs.watch` 三平台验证（SessionWatcher 自带轮询回退，量化延迟）；Windows `taskkill /T /F`
   对含 MCP/dev-server 子进程树的击杀 + 收割者对 Docker 标签过滤的验证；safeStorage 无 secrets 服务的 Linux 回退路径。

### 7.2 测试矩阵

| 类型          | 位置                                     | 内容                                                                                                                                                                 |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议契约      | `packages/protocol/test/contract/`       | golden fixtures zod 解析；JSON 往返恒等；未知事件容忍；schema 形状快照 vs `PROTOCOL_VERSION`（未 bump 即 fail）                                                      |
| 事件流 golden | `packages/core/test/engine/`             | MockLLMClient + generic backend + mock sandbox 端到端 → 归一化事件序列（去 timestamp/id）对 golden JSONL；orchestrated 与（后续）flat 两套 profile                   |
| 生命周期泄漏  | `packages/core/test/engine/leak.test.ts` | 包裹 setInterval/setTimeout/fs.watch 计数；run → `dispose()` → 零活句柄；spawn stdio MCP echo fixture + sandbox `sleep`，断言 Registry 清空且 `kill(pid,0)` 抛错     |
| 审批往返      | core + server                            | escalation 下：worker 挂起时收到 `approval_request` → `respondToApproval` → worker 续跑 → `approval_resolved{respondedBy:'user'}`；超时→默认路径；CLI 外部写文件路径 |
| server 集成   | `packages/server/test/`                  | WS 客户端：hello 握手、建会话、sendMessage 成帧、中途 interrupt、断连 dispose；stdio 模式冒烟                                                                        |
| compile 冒烟  | CI job                                   | 构建二进制 → `--selftest`                                                                                                                                            |

## 8. 安全模型

- **权限门**：桌面链路废除 Claude SDK backend 的 `bypassPermissions`
  默认值；审批 API 即权限门。策略矩阵进设置页：`impactScope:low && reversible`
  自动放行；medium/high 必问；按工作区覆盖；「本工作区永远允许工具 X」持久化。E4 落地前的过渡：server 拒绝启用该 backend，默认 generic
  backend（其工具环已走文件审批协议）。
- **密钥**：`safeStorage`（Keychain/DPAPI/libsecret）密文落
  `userData`；明文只短暂存在于 main 内存与 sidecar 内存；不进 settings.json/渲染态/日志。Linux 无 secret
  service 显式警告降级。
- **本机面**：仅 `127.0.0.1`；token stdin 注入；WS 一次性 ticket；Origin 校验；body 限长。
- **渲染硬化**：`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`；preload 只暴露
  `{getServerInfo, secrets, dialogs.chooseDirectory, app.{version,platform}}`；CSP
  `default-src 'self'; connect-src http://127.0.0.1:* ws://127.0.0.1:*; …`；不加载任何远程内容；`shell.openExternal`
  走白名单。
- **shell_run**：`LocalSandbox`
  的 argv 白名单（无 shell）、路径越界/symlink 防护、网络 allowlist 全部配置化进设置页；白名单外命令走审批流而非静默失败；检测到 Docker 时提供「更强隔离」per-workspace 开关。
- **脱敏**：gateway `output-filter`
  作为库在 server 侧过一遍事件文本（工具输出可能回显 env 密钥）再进 UI 与 WAL。

## 9. 风险与开放决策

### 9.1 主要风险

| 风险                                                | 应对                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| AI SDK v6 beta API 漂移                             | 尖峰 B 锁版本；`streamComplete` 为可选增量钩子，`generateText` 路径始终保底                  |
| compiled Bun 二进制的公证/JIT entitlements 不确定性 | 尖峰 1 最先跑；回退方案（分发 bun runtime + bundle）已备                                     |
| `interrupt` 真实语义在四个 backend 上不一致         | E2 以 golden + 泄漏测试验证「无僵尸 worker、无脏会话文件」；D-B 的过渡 fallback 也纳入尖峰 5 |
| 协议过早固化                                        | 仅增量演进 + capabilities 探测 + 拓扑无关规则；D5 把扁平化重构挡在门面之后                   |
| 单人带宽，双轨并行失速                              | 关键路径只有 4 个 M 级阶段；D-A 起步仅需 E1；每阶段独立可合入                                |

### 9.2 开放决策（不阻塞开工）

1. 审批默认策略：建议桌面 `escalationMode:'unmatched'` + `defaultDecision:'reject'` +
   5 分钟超时；CLI 是否同步开启（建议开，修竞态）。
2. `level` 长期去向：懒加载后维持 opt-in，还是换 `bun:sqlite`——待尖峰 A 数据。
3. gateway 未来：保留为 A2A/远程实验面（用协议适配器消费引擎）或退役——不阻塞。
4. fusion 收尾尾巴：`toolProfile.default` 切 `'pi-core'`、`todoFsm.strictMode`
   开严格——与本方案独立，建议在 E3 前后择机。
5. `web_search`/`deep_research`
   去留（CONTINUITY 结转）：桌面对标 Alma 需要 Web 搜索，建议**保留并在 D-D 接入设置页**，不再物理清除。
6. `docs/*.task.md`
   勾选（CONTINUITY 结转）：该文件不存在，建议以本方案 §10 的 roadmap 映射替代，不再单独建 task 文件。

## 10. 与既有路线图的衔接

- **taskmaster 待办映射**：task 10（AgentOps 可观测性）→ D-D Ops 视图 + E8 日志 sink 喂真数据；task
  11（智能路由/模型选择）→ D-D 多 Provider/按角色模型之后自然承接；task
  18（Agent 身份持久化）→ 记忆浏览器的身份分页挂钩；task 12-16 保持 pending，不与桌面轨争带宽。
- **agentops 处置**：`src/client` 的 MainLayout/Dashboard/Charts/StatCard 在 D-D 并入
  `packages/desktop`（删除死代码
  `components/Dashboard.tsx`、`pages/Placeholders.tsx`）；独立 Bun.serve
  dashboard 退役；`remote-metrics/remote-tracer`（现为死代码且有既有 tsc 错误）在 E8 决定修复或删除。
- **文档修订**：README 的工具表/开发状态表更新（工具面收缩后已过期）、Gateway/AgentOps 状态改为实情；`.env.example`
  与 loader 对齐（E0/E6 顺手）。
- **CONTINUITY 账本**：本方案落地后账本切换到桌面化工作项，两个未决问题按 §9.2 第 5/6 条处置。

# @tachikoma/protocol v2 设计与迁移（桌面轨 E1）

> 状态：**已实现**。v1 于 2026-08-12 随提交 c84fb68 落地；当前 v2 于 2026-08-13 随提交 5e5cc7a 加入记忆 lifecycle
> wire 投影，并已同步 core、protocol、server、CLI 和 desktop。上游文档：
> `docs/tachikoma-desktop-plan.md`（总设计，§2.3 传输与握手、§4.1 协议包、§4.5 Server
> RPC）、`docs/tachikoma-spiral-roadmap.md` （ChatEvent 契约与演进规则的语义源头）。
>
> **落地时机**：与第一个真实消费者（`@tachikoma/server`
> 本机 sidecar 或桌面行走骨架 D-A）同一批提交落地。路线图规定 "Placeholder packages and speculative
> services are not progress" —— 本文把契约钉到可直接实现的精度，但不提前创建空包。

## 1. 定位与边界

`@tachikoma/protocol` 是引擎与一切远端消费者（Electron renderer、未来 Web
UI、第三方客户端）之间的**唯一线上契约**：

- **纯类型 + zod schema**。零运行时依赖 bun/node API（renderer 直接 import）；唯一依赖 `zod`。
- **不是**
  RPC 框架、不是传输实现、不含任何网络代码——server 与客户端各自实现传输，共享这里的消息形状与校验。
- **语义源头是 core 的 `ChatEvent`
  契约**（`packages/core/src/chat/types.ts`）。protocol 包是它的 wire 镜像：zod
  schema + 推导类型 + 序列化不变量测试。core 不依赖 protocol，protocol 不依赖 core（类型兼容性由 devDependency 层的契约测试保证，见 §8）。

## 2. Wire 事件模型

### 2.1 事件本体

`ChatEventWire` = core `ChatEvent` 联合的逐字段 zod 镜像。当前成员（第一、二圈已冻结）：

| 事件                     | 关键字段                                                                                   | 备注                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `message_start`          | messageId                                                                                  |                                                                  |
| `message_delta`          | messageId, text                                                                            | token 级增量                                                     |
| `reasoning_delta`        | messageId, text                                                                            | 思考流增量                                                       |
| `retry`                  | attempt, maxAttempts, delayMs, error                                                       | pi 自动重试可见化                                                |
| `compaction`             | phase: start\|complete, reason, aborted?, willRetry?, error?                               |                                                                  |
| `memory_status`          | phase: session_start\|recall\|writeback, status, hasContext?, estimatedTokens?, error?     | status: disabled\|ready\|recalled\|empty\|degraded\|write-failed |
| `tool_call`              | callId, tool, input                                                                        | input 为 JSON 值（pi 工具入参天然可序列化）                      |
| `tool_update`            | callId, tool, output                                                                       |                                                                  |
| `tool_result`            | callId, tool, output, isError                                                              |                                                                  |
| `tool_approval_request`  | callId, tool, input, timeoutMs                                                             | HITL 一等公民                                                    |
| `tool_approval_resolved` | callId, approved, reason: reply\|timeout\|aborted                                          |                                                                  |
| `message_complete`       | messageId, status: success\|interrupted\|failed, content, model, stopReason, usage, error? | 每回合恰好一个终结                                               |

所有事件携带 `sessionId`、`turnId`、`timestamp`（epoch ms）。`usage` 为 pi
Usage 全量（input/output/cacheRead/cacheWrite/cacheWrite1h?/reasoning?/totalTokens/cost）。

**序列化不变量**（契约测试断言）：每个事件 `JSON.parse(JSON.stringify(e))` 与原值 deep-equal；不含
`undefined`
之外的不可序列化值；**任何字段不得含凭证**（schema 层禁止名为 apiKey/token/authorization 的键，测试扫描 fixture 全字段名）。

### 2.2 会话事件帧与重放

引擎事件本身**没有 seq**——序号是传输层职责（desktop-plan §2.3）：server 是 `session.send`
生成器的唯一消费者，为每个事件分配会话内单调 `seq`，**先写 WAL**
（`<dataDir>/sessions/<sessionId>.events.jsonl`）再扇出：

```ts
interface SessionEventFrame {
  v: 1; // 帧版本（独立于 PROTOCOL_VERSION，仅帧结构自身）
  sessionId: string;
  seq: number; // 会话内单调，从 1 起
  event: ChatEventWire;
}
```

客户端以 `{sessionId, fromSeq}` 订阅：server 重放 WAL 中 `seq > fromSeq`
的帧后接续实时流。窗口刷新、断线、sidecar 重启均无损。`fromSeq: 0` 表示全量重放。

### 2.3 未知事件容忍

第三圈将增量加入协调类事件。客户端**必须**容忍未知 `event.type`：

```ts
function parseSessionEventFrame(raw: unknown):
  | { ok: true; frame: SessionEventFrame }
  | { ok: true; frame: UnknownEventFrame } // seq/sessionId 可解析、event.type 未知
  | { ok: false; error: string }; // 帧结构本身损坏
```

未知事件保留原始 JSON（`raw` 字段）供日志/降级 UI 显示"[未识别事件]"，**绝不丢 seq**
（丢 seq 会破坏重放游标）。

## 3. 握手与版本

```ts
const PROTOCOL_VERSION = 2;

interface HelloRequest {
  protocolVersion: number;
  client: string;
} // client: "tachikoma-desktop/0.2.0"
interface HelloResponse {
  protocolVersion: number; // server 实现的版本
  engineVersion: string; // @tachikoma/core VERSION
  capabilities: string[]; // 见下
  session: { workDir?: string; toolset?: 'read-only' | 'coding' }; // 本 sidecar 的工具姿态
}
```

- server 校验请求中的 `protocolVersion` 为整数，并在响应中报告自身版本。仓内消费者直接使用
  `@tachikoma/protocol` 导出的
  `PROTOCOL_VERSION`，因此保持精确对齐；仓外消费者必须在继续 RPC 前比较响应版本。
- `capabilities` 是字符串集合而非位图，与事件演进同规则（只增不改）。初始集： `"chat"`,
  `"reasoning"`, `"tools"`, `"approvals"`, `"memory"`, `"compaction"`,
  `"session-replay"`。现行全集以 `protocol/src/version.ts` 的 `CAPABILITIES` 为唯一事实源（此后已增
  `"session-workspace"`、`"memory-management"`、`"image-input"`、 `"skills"`）。客户端按能力渲染（无
  `"tools"` 则不渲染工具面板）。任何 schema 增量都要重生成 `protocol/tests/__snapshots__/`
  快照并在提交里说明（§7.3）。
- API key **永不过线**：凭证属于 sidecar 进程环境（env / pi auth.json / models.json 的 `$ENV`
  插值），Hello 与一切响应不含密钥；`session.model` 只有 `{provider, model}`。

### 3.1 v1 → v2：记忆 lifecycle

v2 的唯一破坏性迁移是给 strict `MemoryRecord` wire DTO 增加可选
`lifecycle: 'active' | 'superseded' | 'inactive'`。它用于反馈规则的管理面状态，避免把已替代或已停用的规则展示成当前生效规则。

虽然字段可选，但 v1 客户端的 strict
schema 会拒绝带该字段的 v2 响应，因此版本升为 2，而不是伪装成透明兼容。升级要求：

- producer 与 consumer 同步升级 `@tachikoma/protocol`，并使用导出的 `PROTOCOL_VERSION` 和 schema；
- `memory.list` / `memory.search` 保留 lifecycle，CLI 和 desktop 只在 feedback 上展示状态；
- 无 lifecycle 的旧记录及非 feedback 记录仍合法，不需要迁移 canonical memory 或 storage schema；
- 不保留 v1 DTO shim；协议 schema 快照负责守住 v2 形状。

## 4. RPC 方法表

传输：HTTP（请求/响应）+ WS（事件流），仅 127.0.0.1，Bearer
token 经 stdin 引导注入，WS 用一次性 ticket（细节见 desktop-plan §2.3，本包只定义消息形状）。

统一信封：

```ts
interface RpcRequest<M extends string, P> {
  id: string;
  method: M;
  params: P;
}
interface RpcOk<R> {
  id: string;
  ok: true;
  result: R;
}
interface RpcError {
  id: string;
  ok: false;
  error: { code: RpcErrorCode; message: string };
}
type RpcErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'conflict' // 会话已有生成中的回合
  | 'invalid_params'
  | 'unsupported'
  | 'internal';
```

方法与当前引擎 API 的一一映射（右列为 core 现有实现）：

| method                      | params                                                        | result                    | core 对应                      |
| --------------------------- | ------------------------------------------------------------- | ------------------------- | ------------------------------ |
| `engine.hello`              | HelloRequest                                                  | HelloResponse             | —                              |
| `engine.listModels`         | {}                                                            | {models: Model[]}         | `engine.listModels`            |
| `engine.shutdown`           | {}                                                            | {}                        | server 侧 dispose 级联         |
| `session.create`            | {model?, thinkingLevel?, title?, workDir?, toolset?, skills?} | SessionSummary            | `engine.createSession`         |
| `session.list`              | {}                                                            | SessionSummary[]          | `engine.listSessions`          |
| `session.open`              | {sessionId}                                                   | SessionSummary            | `engine.openSession`           |
| `session.delete`            | {sessionId}                                                   | {deleted: boolean}        | `engine.deleteSession`         |
| `session.send`              | {sessionId, text, images?}                                    | {turnId}                  | `session.send`（事件走 WS 帧） |
| `session.abort`             | {sessionId}                                                   | {aborted: boolean}        | `session.abort`                |
| `session.respondToApproval` | {sessionId, callId, approved, scope?}                         | {matched: boolean}        | `session.respondToApproval`    |
| `session.setModel`          | {sessionId, model}                                            | {model}                   | `session.setModel`             |
| `session.setThinkingLevel`  | {sessionId, level}                                            | {level}                   | `session.setThinkingLevel`     |
| `session.rename`            | {sessionId, title}                                            | {title}                   | `session.rename`               |
| `session.compact`           | {sessionId, instructions?}                                    | CompactionResult          | `session.compact`              |
| `memory.list`               | {}                                                            | {records: MemoryRecord[]} | `engine.memoryList`            |
| `memory.search`             | {query}                                                       | {records: MemoryRecord[]} | `engine.memorySearch`          |
| `memory.forget`             | {memoryId}                                                    | {forgotten: boolean}      | `engine.memoryForget`          |
| `memory.clear`              | {}                                                            | {deleted: number}         | `engine.memoryClear`           |
| `session.subscribe`（WS）   | {sessionId, fromSeq}                                          | SessionEventFrame 流      | server WAL 重放 + 实时         |

DTO 直接镜像 core 现有 JSON-safe 类型：`SessionSummary` = `ChatSessionSummary`（含 status:
ready\|corrupt 与 error）、`CompactionResult` = `ChatCompactionResult`、`MemorySnapshot` =
`ChatMemorySnapshot`、`MemoryRecord` = `ChatMemoryRecord`、`ModelRef` =
`ChatModelRef`。协议不预占尚未实现的方法；现行方法集合以 `packages/protocol/src/rpc.ts` 的
`RPC_METHODS` 为唯一事实源。

## 5. 并发与会话语义（wire 层承诺）

- 一个会话同时至多一个在途回合：`session.send` 在生成中返回 `conflict`。
- `session.send` 立即返回 `turnId`；事件（含该回合的 `message_start`
  到终结）全部走订阅流。客户端不等 HTTP 响应渲染——以帧为准。
- 终结保证与 core 一致：每 turnId 恰好一个
  `message_complete`（server 崩溃恢复场景由 WAL 重放补齐；重启后未终结的回合由 server 补发合成
  `message_complete{status:'failed', error:'engine restarted'}`——**合成帧同样写 WAL**，保证游标一致）。
- 审批超时语义在引擎侧（timeoutMs 随 `tool_approval_request`
  下发，UI 可显示倒计时）；客户端崩溃等价于不应答 → 超时默认拒，安全姿态不依赖客户端存活。

## 6. 安全不变量（协议层可测试的部分）

1. 全部 schema 拒绝未知顶层字段（`strict()`）——防止意外把引擎内部字段漏上线。
2. fixture 全字段名扫描：不得出现 apiKey/secret/token/authorization/password。
3. `tool_approval_request.input` 原样透传（UI 必须能展示模型到底要干什么——尤其 bash 的 `command`
   字段），这是审批有效性的前提，不脱敏、不截断；脱敏是显示层的选择。
4. 事件文本（message_delta 等）不做协议层过滤；输出脱敏属于 server 中间件（desktop-plan §8）。

## 7. 演进规则

与 ChatEvent 契约同规则，落成协议条文：

1. **只增不改**：新事件类型、新可选字段、新方法、新 capability；已有字段不改名不改义不删除。
2. 破坏性变更 = `PROTOCOL_VERSION` +1，且必须提供迁移说明；v1 → v2 见 §3.1。
3. **schema 快照守卫**：`protocol/tests/__snapshots__/schema.json`（每个 schema 的 JSON
   Schema 导出快照）入库；CI 上快照变化而 PROTOCOL_VERSION 未动 → 仅允许纯增量 diff（新增 properties
   / 新增 union 成员），否则失败。
4. capability 字符串一经发布永不复用于不同语义。

## 8. 测试与 CI

protocol 包自身（零网络、零 bun API）：

- **round-trip**：每个事件/DTO/信封一组 fixture，`schema.parse(JSON.parse(JSON.stringify(x)))`
  恒等；坏 fixture（缺字段/错类型/未知顶层字段）必须被拒。
- **未知事件容忍**：`parseSessionEventFrame` 对未来事件类型返回 UnknownEventFrame 且保 seq。
- **快照守卫**：见 §7.3。
- **凭证扫描**：见 §6.2。

跨包契约测试（放在 protocol 包，`@tachikoma/core` 仅 devDependency）：

```ts
// 双向可赋值断言：core 事件 ⊆ wire 类型，wire 类型 ⊆ core 事件。
// 编译期完成（tsc 即测试），运行期零成本；core 契约增量时此处强制同步 protocol。
const _coreToWire: ChatEventWire = {} as import('@tachikoma/core').ChatEvent;
const _wireToCore: import('@tachikoma/core').ChatEvent = {} as ChatEventWire;
```

CI：并入现有 verify 管线（typecheck/test/build/pack 各自然扩展到新包）；dist 导出面按 core 同款精确钉死测试。

## 9. 实施切入点（与 D-A/E5 同批）

```
packages/protocol/
  src/
    version.ts        # PROTOCOL_VERSION, capabilities 常量
    events.ts         # ChatEventWire schemas + SessionEventFrame + parseSessionEventFrame
    rpc.ts            # 信封 + 方法表 schemas
    dto.ts            # SessionSummary / CompactionResult / MemorySnapshot / ModelRef
    index.ts          # 显式导出面（钉死测试）
  tests/              # §8 全部
  package.json        # deps: zod；devDeps: @tachikoma/core, typescript
```

上述目录、server 消费者、模型目录与记忆管理 RPC 均已落地。后续协议增量直接修改现有 schema、
`RPC_METHODS` 与对应契约测试，不创建 placeholder package 或预留方法。

## 10. 显式非目标

- 不做多引擎路由/多租户（本机单用户，desktop-plan ADR 已裁决）。
- 不做流内压缩/二进制帧（本机回环，JSON 行足够；性能问题出现前不优化）。
- 不做客户端 SDK（zod schema 即 SDK；各端自行薄封装）。
- 不迁移 CLI 到 RPC——CLI 保持进程内直连 core（同进程没有理由过序列化边界）。

# @tachikoma/core

Tachikoma 核心库 - 提供智能体、上下文管理、工具、沙盒、MCP 集成等核心功能。

## 安装

```bash
bun add @tachikoma/core
```

## 模块

| 模块           | 描述                            | 状态      |
| -------------- | ------------------------------- | --------- |
| `types`        | 核心类型定义                    | ✅ 完成   |
| `config`       | 配置管理与环境覆盖              | ✅ 完成   |
| `factories`    | 工厂函数与依赖注入              | ✅ 完成   |
| `abstracts`    | 抽象基类实现                    | ✅ 完成   |
| `planner`      | LLM 规划器（任务分解与委托）    | ✅ 完成   |
| `orchestrator` | 统筹者（plan→assign→aggregate） | ✅ 完成   |
| `session`      | 共享文件系统协调机制            | ✅ 完成   |
| `checkpoint`   | 检查点与任务恢复                | ✅ 完成   |
| `worker`       | Worker 后端（混合架构）         | ✅ 完成   |
| `context`      | 上下文管理（压缩、摘要、卸载）  | ✅ 完成   |
| `sandbox`      | 沙盒管理（隔离执行）            | ✅ 完成   |
| `agents`       | 智能体实现（工作者等）          | 🚧 待实现 |
| `tools`        | 原子工具库                      | 🚧 待实现 |
| `mcp`          | MCP 集成                        | 🚧 待实现 |

## MVP 已知限制

- Claude Agent SDK 模式下，Tachikoma 自有工具的 MCP 桥接尚未实现，必要时请强制使用通用后端或接受工具不可用。
- 沙盒隔离仅对 `isCommandBased: true` 的工具通过 `sandbox.runCommand` 生效；非命令型 JS 工具在沙盒降级/不可用时仍在宿主进程执行，可开启 `strictSandbox` 拒绝此类工具。
- 可观测性为轻量 Console/内存实现，未接 OTLP/Prometheus；traceId 主要在 WorkerExecutor 生成，跨层追踪需后续透传。
- 审批文件协议需 Orchestrator 写入/清理，未配置回调时按默认决策超时处理。
- MCP 能力、工具库与具体 Agents 仍在建设中，属于后续迭代范围。

## 核心流程：plan → assign → monitor → aggregate

Orchestrator 实现了完整的任务执行流程：

```
┌──────────────────────────────────────────────────────────────┐
│                     Orchestrator 执行流程                      │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌──────────┐  │
│   │  Plan   │ => │ Assign  │ => │ Monitor │ => │ Aggregate│  │
│   │ (规划)  │    │ (分配)  │    │ (监控)  │    │  (聚合)  │  │
│   └─────────┘    └─────────┘    └─────────┘    └──────────┘  │
│        │              │              │               │        │
│        v              v              v               v        │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌──────────┐  │
│   │ Planner │    │ Worker  │    │ Session │    │  Result  │  │
│   │  (LLM)  │    │  Pool   │    │ Manager │    │ Merger   │  │
│   └─────────┘    └─────────┘    └─────────┘    └──────────┘  │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### 1. Plan (规划阶段)

Planner 使用 LLM 将高层任务分解为可执行的子任务：

```typescript
import { Planner, createLLMClient } from '@tachikoma/core/planner';

// 创建 LLM 客户端
const llmClient = createLLMClient({
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  maxTokens: 4096,
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 创建规划器
const planner = new Planner({ llmClient });

// 执行规划
const planResult = await planner.plan({
  task: {
    id: 'task-001',
    type: 'development',
    objective: '实现用户认证模块',
    constraints: ['使用 JWT', '支持 OAuth 2.0'],
    priority: 'high',
    complexity: 'complex',
  },
  context: {
    maxSubtasks: 5,
    availableTools: ['file_write', 'code_execute', 'api_call'],
  },
});

console.log('规划结果:', planResult.output);
// 输出: { subtasks: [...], executionPlan: {...}, delegation: {...} }
```

### 2. Assign (分配阶段)

WorkerPool 管理 Worker 资源，按策略分配子任务：

```typescript
import { DefaultWorkerPool, createWorkerPool } from '@tachikoma/core/orchestrator';

// 创建 Worker 池
const workerPool = createWorkerPool({
  minWorkers: 1,
  maxWorkers: 5,
  selectionStrategy: 'least-loaded', // 或 'round-robin', 'random', 'capability-match'
  idleTimeout: 300000,
});

// 注册 Worker
workerPool.register({
  id: 'worker-001',
  status: 'idle',
  capabilities: ['code', 'file', 'api'],
});

// 分配任务
const assignment = await workerPool.assign({
  id: 'subtask-001',
  objective: '创建 JWT 签发逻辑',
  requiredCapabilities: ['code'],
});

if (assignment.success) {
  console.log(`任务已分配给: ${assignment.workerId}`);
}
```

### 3. Monitor (监控阶段)

SessionFileManager 提供文件监控、审批处理、偏离检测：

```typescript
import {
  SessionFileManager,
  createAndInitializeSessionFileManager,
} from '@tachikoma/core/orchestrator';

// 创建并初始化会话管理器
const sessionManager = await createAndInitializeSessionFileManager('session-001', {
  rootDir: '.tachikoma',
  enableWatch: true,
  watchPollInterval: 500,
});

// 注册 Worker
await sessionManager.registerWorker('worker-001');

// 监听审批请求
sessionManager.on('pending_approval_created', async (event) => {
  const approval = event.data;
  console.log(`收到审批请求: ${approval.type} - ${approval.description}`);

  // 自动处理或等待人工审批
  await sessionManager.writeApprovalResponse(event.workerId!, {
    requestId: approval.requestId,
    respondedAt: Date.now(),
    approved: true,
    respondedBy: 'orchestrator',
    reason: '低影响操作，自动批准',
  });
});

// 监听 Worker 状态变化
sessionManager.on('worker_status_changed', async (event) => {
  console.log(`Worker ${event.workerId} 状态: ${event.data.status}`);
});

// 启动文件监控
await sessionManager.startWatching();
```

### 4. Aggregate (聚合阶段)

收集所有子任务结果，合并为最终输出：

```typescript
// Orchestrator 自动处理聚合
const orchestrator = new Orchestrator('orch-001', {
  planner,
  workerPool,
  sessionManager,
  config: {
    aggregation: {
      strategy: 'merge', // 或 'first', 'last', 'vote'
      allowPartialSuccess: true, // 允许部分成功
      partialSuccessThreshold: 0.5, // 成功率阈值
    },
  },
});

// 执行任务
const result = await orchestrator.run({
  id: 'task-001',
  type: 'development',
  objective: '实现用户认证模块',
  constraints: ['使用 JWT'],
});

console.log(`任务状态: ${result.status}`);
console.log(`成功子任务: ${result.metrics.successCount}`);
console.log(`失败子任务: ${result.metrics.failureCount}`);
console.log(`总耗时: ${result.metrics.duration}ms`);
```

## Worker Backend (混合架构)

Worker Backend 提供统一的后端抽象，支持：

- **Claude 模型**: 使用 Claude Agent SDK（可选）
- **OpenAI/Gemini**: 使用自研通用后端（GenericAgentBackend）

### 基本使用

```typescript
import { createWorkerExecutor, type WorkerExecutorConfig } from '@tachikoma/core/worker';

// 创建执行器
const executor = await createWorkerExecutor({
  backendConfig: {
    provider: 'anthropic', // 或 'openai', 'google'
    model: 'claude-3-5-sonnet-20241022',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  sessionManager, // 可选，用于审计日志
  workerId: 'worker-001',
});

// 执行子任务（流式）
for await (const msg of executor.execute(subtask, tools)) {
  switch (msg.type) {
    case 'thinking':
      console.log('思考:', msg.content);
      break;
    case 'tool_call':
      console.log('调用工具:', msg.tool);
      break;
    case 'output':
      console.log('输出:', msg.content);
      break;
  }
}

// 或收集完整结果
const result = await executor.executeAndCollect(subtask, tools);
console.log(`成功: ${result.success}, 耗时: ${result.metrics.duration}ms`);

// 释放资源
await executor.dispose();
```

### 资源限制配置

```typescript
const result = await executor.executeAndCollect(subtask, tools, {
  resourceLimits: {
    maxThinkingRounds: 30, // 最大思考轮数
    maxToolCalls: 100, // 最大工具调用次数
    maxTotalTokens: 500_000, // Token 预算
    maxMessageWindow: 50, // 上下文消息窗口
  },
  riskPolicy: {
    sensitiveTools: ['rm', 'delete', 'drop'],
    sensitivePatterns: [/password/i, /secret/i],
    highRiskThreshold: 0.8,
  },
});
```

### Sandbox 安全策略

```typescript
// 工具定义：高风险工具必须设置 isCommandBased: true
const deleteTool: Tool = {
  name: 'delete_file',
  description: 'Delete a file',
  isCommandBased: true, // 必须为 true，否则将被拒绝执行
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  outputSchema: { type: 'object' },
  execute: async (input, ctx) => {
    /* 通过 sandbox.runCommand 实现 */
  },
};

// 安全策略配置
const result = await toolExecutor.execute(tool, input, {
  workDir: process.cwd(),
  securityPolicy: {
    strictSandbox: true, // 开启后所有工具必须是 isCommandBased
    highRiskTools: ['delete', 'rm', 'exec'], // 自定义高风险工具列表
  },
});
```

> ⚠️ **安全注意事项**：
>
> - 高风险工具（如 delete, exec）如果没有设置 `isCommandBased: true` 将被拒绝执行
> - 非命令型工具的 `execute()` 会在宿主进程中直接执行，无进程隔离
> - 建议在生产环境开启 `strictSandbox` 模式

## 完整 Orchestrator 示例

```typescript
import {
  Orchestrator,
  createOrchestratorConfig,
  DefaultWorkerPool,
  createAndInitializeSessionFileManager,
} from '@tachikoma/core/orchestrator';
import { Planner, createLLMClient } from '@tachikoma/core/planner';
import type { Task } from '@tachikoma/core';

async function main() {
  // 1. 创建 LLM 客户端
  const llmClient = createLLMClient({
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    maxTokens: 4096,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // 2. 创建组件
  const planner = new Planner({ llmClient });
  const workerPool = new DefaultWorkerPool({
    minWorkers: 1,
    maxWorkers: 3,
    selectionStrategy: 'least-loaded',
  });
  const sessionManager = await createAndInitializeSessionFileManager('main-session');

  // 3. 配置 Orchestrator
  const config = createOrchestratorConfig({
    approval: {
      autoApproveTypes: ['file_operation'],
      lowImpactAutoApprove: true,
      reversibleAutoApprove: true,
    },
    deviationDetection: {
      enabled: true,
      checkInterval: 10000,
    },
    checkpoint: {
      enabled: true,
      interval: 30000,
    },
  });

  // 4. 创建 Orchestrator
  const orchestrator = new Orchestrator('main-orch', {
    planner,
    workerPool,
    sessionManager,
    config,
  });

  // 5. 监听事件
  orchestrator.on('plan:start', () => console.log('📋 开始规划...'));
  orchestrator.on('plan:complete', () => console.log('✅ 规划完成'));
  orchestrator.on('subtask:assigned', (data) => console.log(`📤 分配子任务: ${data?.subtaskId}`));
  orchestrator.on('subtask:complete', (data) => console.log(`✅ 子任务完成: ${data?.subtaskId}`));
  orchestrator.on('approval:received', () => console.log('🔔 收到审批请求'));
  orchestrator.on('deviation:detected', () => console.log('⚠️ 检测到偏离'));

  // 6. 执行任务
  const task: Task = {
    id: 'task-001',
    type: 'development',
    objective: '实现用户认证功能，包括登录、注册、密码重置',
    constraints: ['使用 JWT 进行会话管理', '密码使用 bcrypt 加密', '支持邮箱验证'],
  };

  try {
    const result = await orchestrator.run(task);

    console.log('\n======== 任务结果 ========');
    console.log(`状态: ${result.status}`);
    console.log(`耗时: ${result.metrics.duration}ms`);
    console.log(`Token 使用: ${result.metrics.tokensUsed}`);

    if (result.status === 'success') {
      console.log('输出:', JSON.stringify(result.output, null, 2));
    } else {
      console.log('错误:', result.output?.error);
    }
  } finally {
    // 7. 清理资源
    await orchestrator.stop();
    await sessionManager.close();
  }
}

main().catch(console.error);
```

## 共享文件系统

### 目录结构

```
.tachikoma/
└── sessions/
    └── {session-id}/
        ├── orchestrator/                    # 统筹者目录
        │   ├── plan.json                    # 任务计划
        │   ├── progress.json                # 执行进度
        │   ├── decisions.jsonl              # 决策日志
        │   └── checkpoints/                 # 检查点目录
        │       ├── checkpoint-001.json
        │       └── checkpoint-002.json
        ├── workers/                         # Worker 目录
        │   └── {worker-id}/
        │       ├── status.json              # Worker 状态
        │       ├── thinking.jsonl           # 思考过程日志
        │       ├── actions.jsonl            # 行动日志
        │       ├── pending_approval.json    # 待审批请求
        │       ├── approval_response.json   # 审批响应
        │       ├── intervention.json        # 干预指令
        │       └── artifacts/               # 产出物目录
        └── shared/                          # 共享目录
            ├── context.json                 # 共享上下文
            └── messages.jsonl               # 消息日志
```

### 文件格式说明

#### plan.json (任务计划)

```json
{
  "sessionId": "session-001",
  "taskId": "task-001",
  "createdAt": 1701936000000,
  "updatedAt": 1701936100000,
  "version": 1,
  "plannerOutput": {
    "taskId": "task-001",
    "subtasks": [
      {
        "id": "subtask-1",
        "parentId": "task-001",
        "objective": "设计数据库模型",
        "constraints": ["使用 PostgreSQL"],
        "status": "pending"
      }
    ],
    "delegation": {
      "mode": "communication",
      "workerCount": 2,
      "timeout": 300000,
      "retryPolicy": {
        "maxRetries": 3,
        "baseDelay": 1000,
        "backoffFactor": 2
      }
    },
    "executionPlan": {
      "isParallel": false,
      "steps": [{ "order": 1, "subtaskIds": ["subtask-1"], "parallel": false }]
    }
  }
}
```

#### progress.json (执行进度)

```json
{
  "sessionId": "session-001",
  "taskId": "task-001",
  "status": "executing",
  "currentStep": 2,
  "totalSteps": 5,
  "completedSubtasks": ["subtask-1", "subtask-2"],
  "failedSubtasks": [],
  "runningSubtasks": ["subtask-3"],
  "startedAt": 1701936000000,
  "updatedAt": 1701936500000,
  "estimatedRemaining": 120000
}
```

#### status.json (Worker 状态)

```json
{
  "workerId": "worker-001",
  "status": "thinking",
  "currentSubtask": {
    "id": "subtask-3",
    "objective": "实现 API 接口",
    "startedAt": 1701936400000
  },
  "progress": 45,
  "lastHeartbeat": 1701936500000
}
```

#### pending_approval.json (待审批请求)

```json
{
  "requestId": "approval-001",
  "workerId": "worker-001",
  "subtaskId": "subtask-3",
  "requestedAt": 1701936450000,
  "type": "file_deletion",
  "description": "删除旧配置文件",
  "details": {
    "affectedFiles": ["config/old.json"],
    "impactScope": "low",
    "reversible": true
  },
  "timeout": 30000,
  "defaultDecision": "approve"
}
```

### SessionFileManager API

```typescript
import {
  SessionFileManager,
  createAndInitializeSessionFileManager,
} from '@tachikoma/core/orchestrator';

// 创建会话管理器
const manager = await createAndInitializeSessionFileManager('session-001', {
  rootDir: '.tachikoma',
  enableWatch: true,
});

// === Worker 管理 ===
await manager.registerWorker('worker-001');
const workerPath = manager.getWorkerPath('worker-001');

// === 计划文件操作 ===
await manager.writePlan({
  taskId: 'task-001',
  createdAt: Date.now(),
  version: 1,
  plannerOutput: {
    /* ... */
  },
});
const plan = await manager.readPlan();

// === 进度文件操作 ===
await manager.writeProgress({
  taskId: 'task-001',
  status: 'executing',
  currentStep: 1,
  totalSteps: 3,
  completedSubtasks: [],
  failedSubtasks: [],
  runningSubtasks: ['subtask-1'],
  startedAt: Date.now(),
});
const progress = await manager.readProgress();

// === Worker 状态操作 ===
await manager.writeWorkerStatus('worker-001', {
  status: 'thinking',
  progress: 30,
  lastHeartbeat: Date.now(),
});
const status = await manager.readWorkerStatus('worker-001');

// === 审批流程 ===
const pendingApproval = await manager.readPendingApproval('worker-001');
if (pendingApproval) {
  await manager.writeApprovalResponse('worker-001', {
    requestId: pendingApproval.requestId,
    respondedAt: Date.now(),
    approved: true,
    respondedBy: 'orchestrator',
    reason: '自动批准',
  });
}

// === 干预指令 ===
await manager.writeIntervention('worker-001', {
  type: 'guidance',
  reason: '检测到思路偏离',
  instructions: '请回到主任务目标',
  suggestedNextSteps: ['重新分析需求', '检查约束条件'],
});

// === 共享上下文 ===
await manager.writeSharedContext({
  objective: '实现用户认证',
  constraints: ['使用 JWT'],
  sharedKnowledge: {
    data: { selectedFramework: 'express' },
    updatedAt: Date.now(),
  },
});

// === 消息日志 ===
await manager.appendMessage({
  senderId: 'orchestrator',
  receiverId: 'worker-001',
  direction: 'orchestrator_to_worker',
  type: 'task_assignment',
  content: { subtaskId: 'subtask-1' },
});
const messages = await manager.readMessages(10);

// === 决策日志 ===
await manager.appendDecision({
  type: 'approval',
  workerId: 'worker-001',
  decision: { approved: true, reason: '低影响操作' },
});
const decisions = await manager.readDecisions(20);

// === 思考/行动日志 ===
const thinkingLogs = await manager.readThinkingLogs('worker-001', 10);
const actionLogs = await manager.readActionLogs('worker-001', 10);

// === 清理 ===
await manager.close();
```

### Peer 读取 (Worker 间协调)

支持 Worker 读取其他 Worker 或 Orchestrator 的共享数据，用于 Agent 间协调：

```typescript
import { createAndInitializeSessionFileManager } from '@tachikoma/core/orchestrator';

const manager = await createAndInitializeSessionFileManager('session-001');
await manager.registerWorker('worker-001');
await manager.registerWorker('worker-002');

// === 列出所有 Worker ===
const peerWorkers = await manager.listPeerWorkers();
console.log('Peer Workers:', peerWorkers); // ['worker-001', 'worker-002']

// === 读取其他 Worker 状态 ===
const peerStatus = await manager.readPeerStatus('worker-002', {
  retries: 3, // 可选：重试次数
  backoffDelay: 100, // 可选：重试间隔(ms)
});
if (peerStatus?.status === 'acting') {
  console.log(`Worker-002 进度: ${peerStatus.progress}%`);
}

// === 读取思考/行动日志 ===
const peerThinking = await manager.readPeerThinking('worker-002', 10);
const peerActions = await manager.readPeerActions('worker-002', 10);

// === 读取 artifacts ===
const artifacts = await manager.listPeerArtifacts('worker-002');
if (artifacts.includes('result.json')) {
  const content = await manager.readPeerArtifact('worker-002', 'result.json');
  console.log('Artifact:', content);
}

// === 读取 Orchestrator 计划 ===
const plan = await manager.readOrchestratorPlan();
console.log('当前计划:', plan?.plannerOutput.subtasks);

await manager.close();
```

> **重试机制**: Peer 读取方法内置重试，处理原子写入过程中的短暂窗口期。默认重试 2 次，延迟 50ms。

## 检查点与任务恢复

CheckpointManager 支持长时任务的检查点保存与恢复：

```typescript
import {
  CheckpointManager,
  createCheckpointManager,
  createSubtaskSnapshots,
} from '@tachikoma/core/orchestrator';

// 创建检查点管理器
const checkpointManager = new CheckpointManager('session-001', sessionManager, {
  rootDir: '.tachikoma',
  maxCheckpoints: 5,
  autoSave: true,
  autoSaveInterval: 30000,
});

// === 保存检查点 ===
const checkpoint = await checkpointManager.saveCheckpoint({
  taskId: 'task-001',
  planStatus: 'executing',
  currentStep: 2,
  totalSteps: 5,
  completedSubtaskIds: ['subtask-1', 'subtask-2'],
  failedSubtaskIds: [],
  runningSubtaskIds: ['subtask-3'],
  subtaskSnapshots: createSubtaskSnapshots(subtasks, executionState),
  completedResults: { 'subtask-1': { output: 'done' } },
  totalRetries: 0,
  totalTokens: 1500,
});

console.log(`检查点已保存: ${checkpoint.id}`);

// === 列出检查点 ===
const checkpoints = await checkpointManager.listCheckpoints();
console.log(`共有 ${checkpoints.length} 个检查点`);

// === 恢复检查点 ===
const restoreResult = await checkpointManager.restore({
  strategy: 'resume', // 从最后成功的子任务继续
  // strategy: 'retry-failed', // 重试失败的子任务
  // strategy: 'restart-all',  // 完全重新开始
  skipFailed: false,
  resetRetryCount: false,
});

if (restoreResult.success) {
  console.log('恢复成功');
  console.log('可恢复的子任务:', restoreResult.resumableSubtaskIds);
} else {
  console.log('恢复失败:', restoreResult.error);
}

// === 分析恢复策略 ===
const analysis = await checkpointManager.analyzeRecoveryStrategy(checkpoint);
console.log('建议策略:', analysis.suggestedStrategy);
console.log('原因:', analysis.reason);

// === 自动保存 ===
checkpointManager.startAutoSave();
// ... 执行任务 ...
checkpointManager.stopAutoSave();

// === 清理 ===
await checkpointManager.close();
```

## 审批与干预流程

### 审批策略配置

```typescript
const orchestrator = new Orchestrator('orch-001', {
  config: {
    approval: {
      // 默认决策（当无其他规则匹配时）
      defaultDecision: 'approve',

      // 自动批准的操作类型
      autoApproveTypes: ['file_operation'],

      // 自动拒绝的操作类型
      autoRejectTypes: ['dangerous_operation'],

      // 低影响操作自动批准
      lowImpactAutoApprove: true,

      // 可逆操作自动批准
      reversibleAutoApprove: true,

      // 审批超时时间
      timeout: 30000,
    },
  },
});
```

### 偏离检测配置

```typescript
const orchestrator = new Orchestrator('orch-001', {
  config: {
    deviationDetection: {
      // 启用偏离检测
      enabled: true,

      // 检测间隔（毫秒）
      checkInterval: 10000,

      // 读取思考日志的条数
      thinkingLogLimit: 20,

      // 偏离阈值 (0-1)
      deviationThreshold: 0.7,

      // 干预冷却时间（同一 Worker 不会频繁干预）
      interventionCooldown: 60000,

      // 自动干预的严重程度阈值
      autoInterventionSeverity: 'high',

      // 启用基于规则的检测（重复模式、卡住等）
      enableRuleBasedDetection: true,

      // 启用 LLM 模型评估
      enableModelEvaluation: false,
    },
  },
});

// 监听偏离事件
orchestrator.on('deviation:detected', (data) => {
  console.log('检测到偏离:', data);
});

orchestrator.on('deviation:intervention', (data) => {
  console.log('已发送干预指令:', data);
});
```

## 事件系统

Orchestrator 支持丰富的事件监听：

```typescript
// 规划事件
orchestrator.on('plan:start', () => {
  /* 规划开始 */
});
orchestrator.on('plan:complete', (data) => {
  /* 规划完成 */
});
orchestrator.on('plan:error', (error) => {
  /* 规划失败 */
});

// 子任务事件
orchestrator.on('subtask:assigned', (data) => {
  /* 子任务已分配 */
});
orchestrator.on('subtask:complete', (data) => {
  /* 子任务完成 */
});
orchestrator.on('subtask:error', (data) => {
  /* 子任务失败 */
});
orchestrator.on('subtask:retrying', (data) => {
  /* 子任务重试 */
});

// 聚合事件
orchestrator.on('aggregate:start', () => {
  /* 聚合开始 */
});
orchestrator.on('aggregate:complete', (data) => {
  /* 聚合完成 */
});

// 审批事件
orchestrator.on('approval:received', (data) => {
  /* 收到审批请求 */
});
orchestrator.on('approval:complete', (data) => {
  /* 审批已处理 */
});

// 偏离检测事件
orchestrator.on('deviation:detected', (data) => {
  /* 检测到偏离 */
});
orchestrator.on('deviation:intervention', (data) => {
  /* 已发送干预 */
});

// 检查点事件
orchestrator.on('checkpoint:saved', (data) => {
  /* 检查点已保存 */
});
orchestrator.on('checkpoint:restored', (data) => {
  /* 检查点已恢复 */
});
```

## 配置管理

```typescript
import { loadConfig, createConfigBuilder, DEFAULT_CONFIG } from '@tachikoma/core';

// 方式 1: 直接加载（自动合并环境变量）
const config = loadConfig();

// 方式 2: 带覆盖选项
const config = loadConfig(
  {
    models: {
      orchestrator: { model: 'custom-model' },
    },
  },
  {
    loadFromEnvironment: true,
  }
);

// 方式 3: 使用 Builder 模式
const config = createConfigBuilder()
  .orchestratorModel({ model: 'custom-orchestrator' })
  .workerModel({ maxTokens: 8192 })
  .contextThresholds({ hardLimit: 500_000 })
  .sandbox({ timeout: 3600_000 })
  .build();
```

### 环境变量配置

```bash
# 模型配置
TACHIKOMA_ORCHESTRATOR_PROVIDER=anthropic
TACHIKOMA_ORCHESTRATOR_MODEL=claude-opus-4
TACHIKOMA_ORCHESTRATOR_MAX_TOKENS=8192

# 上下文配置
TACHIKOMA_CONTEXT_HARD_LIMIT=1000000
TACHIKOMA_CONTEXT_ROT_THRESHOLD=200000

# 沙盒配置
TACHIKOMA_SANDBOX_TIMEOUT=1800000
TACHIKOMA_SANDBOX_NETWORK_MODE=restricted

# AgentOps 配置
TACHIKOMA_TRACING_ENABLED=true
TACHIKOMA_LOGGING_LEVEL=info
```

## 工厂与依赖注入

```typescript
import {
  FactoryRegistry,
  defaultRegistry,
  createAgent,
  createOrchestrator,
  createWorker,
} from '@tachikoma/core';

// 使用默认注册表创建（返回 Stub 实现）
const agent = createAgent('orchestrator');

// 注册自定义实现
defaultRegistry.registerAgent('orchestrator', (id, config) => {
  return new MyCustomOrchestrator(id, config);
});

// 现在 createAgent 会使用自定义实现
const customAgent = createAgent('orchestrator');

// 便捷创建函数
const orchestrator = createOrchestrator();
const worker = createWorker();
```

## 类型定义

核心类型包括：

- `Agent` - 智能体接口
- `Task` / `TaskResult` - 任务定义与结果
- `Tool` - 工具定义
- `ContextManager` - 上下文管理器接口
- `Sandbox` - 沙盒接口
- `Config` - 完整配置类型

```typescript
import type {
  Agent,
  AgentType,
  AgentConfig,
  Task,
  TaskResult,
  Tool,
  ContextManager,
  Sandbox,
  Config,
} from '@tachikoma/core';

// Orchestrator 类型
import type {
  OrchestratorTask,
  SubTask,
  PlannerInput,
  PlannerOutput,
  WorkerMessage,
  CheckpointState,
  AggregatedResult,
  ApprovalPolicy,
  DeviationDetectionConfig,
} from '@tachikoma/core/orchestrator';

// Session 类型
import type {
  SessionConfig,
  PlanFile,
  ProgressFile,
  WorkerStatusFile,
  PendingApprovalFile,
  ApprovalResponseFile,
  InterventionFile,
  SharedContextFile,
  MessageRecord,
  DecisionRecord,
} from '@tachikoma/core/orchestrator';
```

## 开发

```bash
# 运行测试
bun test

# 运行特定测试文件
bun test packages/core/tests/orchestrator.test.ts

# 类型检查
bun run typecheck

# 构建
bun run build
```

### 测试覆盖

- `orchestrator.test.ts` - Orchestrator 单元测试
- `planner.test.ts` - Planner 单元测试
- `worker-pool.test.ts` - WorkerPool 单元测试
- `session-file-manager.test.ts` - SessionFileManager 单元测试
- `checkpoint-manager.test.ts` - CheckpointManager 单元测试
- `contract.test.ts` - 文件协议契约测试
- `integration.test.ts` - 端到端集成测试
- `observability.test.ts` - 可观测性模块测试

## 可观测性

Tachikoma 提供轻量级的可观测性支持，包括结构化日志、Tracing Span 和 Metrics 收集。

### 基本使用

```typescript
import {
  createLogger,
  createTracer,
  createMetrics,
  createObservability,
  WORKER_METRICS,
} from '@tachikoma/core';

// 创建单独的实例
const logger = createLogger({ level: 'info' });
const tracer = createTracer();
const metrics = createMetrics();

// 或使用组合工厂
const obs = createObservability({
  logger: { level: 'debug' },
  tracer: { enabled: true },
  metrics: { enabled: true },
});

// 使用 Logger
obs.logger.info('任务开始', { taskId: 'task-001', workerId: 'worker-001' });
obs.logger.debug('详细信息', { step: 1, data: { key: 'value' } });

// 使用 Tracer
const span = obs.tracer.startSpan('worker.execute', {
  attributes: { taskId: 'task-001' },
});
span.addEvent('tool_call', { tool: 'file_read' });
span.addTag('success', true);
span.setStatus('ok');
span.end();

// 使用 Metrics
obs.metrics.increment(WORKER_METRICS.TOOL_CALLS_COUNT, 1, { workerId: 'worker-001' });
obs.metrics.timing(WORKER_METRICS.EXECUTION_DURATION, 1500, { status: 'success' });

// 获取指标快照
const snapshot = obs.metrics.getMetrics();
console.log(snapshot.metrics);
```

### 日志输出格式

```json
{
  "level": "info",
  "ts": "2025-01-01T12:00:00.000Z",
  "msg": "任务开始",
  "traceId": "a1b2c3d4e5f6...",
  "spanId": "1234abcd...",
  "taskId": "task-001",
  "workerId": "worker-001"
}
```

### 集成到 WorkerExecutor

```typescript
import { createWorkerExecutor, createObservability } from '@tachikoma/core';

const obs = createObservability({ logger: { level: 'debug' } });

const executor = await createWorkerExecutor({
  backendConfig: { provider: 'openai', model: 'gpt-4' },
  workerId: 'worker-001',
  logger: obs.logger,
  tracer: obs.tracer,
  metrics: obs.metrics,
});

// 执行时会自动记录日志和 metrics
const result = await executor.executeAndCollect(subtask, tools);

// 获取执行指标
console.log('Metrics:', obs.metrics.getMetrics());
```

### 预定义指标

| 名称                        | 类型      | 描述         |
| --------------------------- | --------- | ------------ |
| `worker.execution.duration` | histogram | 执行持续时间 |
| `worker.tool_calls.count`   | counter   | 工具调用次数 |
| `worker.thinking.rounds`    | counter   | 思考轮次     |
| `worker.tokens.used`        | gauge     | Token 使用量 |
| `worker.errors.count`       | counter   | 错误次数     |
| `sandbox.command.duration`  | histogram | 命令执行耗时 |
| `sandbox.file.read_count`   | counter   | 文件读取次数 |

## 许可证

MIT

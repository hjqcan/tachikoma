# @tachikoma/core

Tachikoma 核心库 - 提供智能体、上下文管理、工具、沙盒、MCP 集成等核心功能。

## 安装

```bash
bun add @tachikoma/core
```

## 模块

| 模块        | 描述                           | 状态      |
| ----------- | ------------------------------ | --------- |
| `types`     | 核心类型定义                   | ✅ 完成   |
| `config`    | 配置管理与环境覆盖             | ✅ 完成   |
| `factories` | 工厂函数与依赖注入             | ✅ 完成   |
| `abstracts` | 抽象基类实现                   | ✅ 完成   |
| `agents`    | 智能体实现（统筹者、工作者等） | 🚧 待实现 |
| `context`   | 上下文管理（压缩、摘要、卸载） | 🚧 待实现 |
| `tools`     | 原子工具库                     | 🚧 待实现 |
| `sandbox`   | 沙盒管理                       | 🚧 待实现 |
| `mcp`       | MCP 集成                       | 🚧 待实现 |

## 使用示例

### 基本使用

```typescript
import {
  VERSION,
  loadConfig,
  createAgent,
  createSandbox,
  createContextManager,
} from '@tachikoma/core';

console.log(`Tachikoma Core v${VERSION}`);

// 加载配置
const config = loadConfig();

// 创建智能体
const orchestrator = createAgent('orchestrator', { config });
const worker = createAgent('worker', { config });

// 创建沙盒
const sandbox = createSandbox({ config });

// 创建上下文管理器
const contextManager = createContextManager({ config });
```

### 配置管理

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

支持通过环境变量覆盖配置：

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

### 工厂与依赖注入

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

### 扩展抽象基类

```typescript
import { BaseAgent, BaseSandbox, SimpleContextManager } from '@tachikoma/core';
import type { Task, TaskResult, AgentConfig } from '@tachikoma/core';

// 继承 BaseAgent 实现自定义智能体
class MyOrchestrator extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, 'orchestrator', config);
  }

  protected async executeTask(task: Task): Promise<TaskResult> {
    // 实现具体的任务执行逻辑
    // ...
  }
}

// 设置生命周期钩子
agent.setHooks({
  onBeforeRun: async (task) => {
    console.log(`Starting task: ${task.id}`);
  },
  onAfterRun: async (task, result) => {
    console.log(`Completed task: ${task.id} with status: ${result.status}`);
  },
});
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
```

## 开发

```bash
# 运行测试
bun test

# 类型检查
bun run typecheck

# 构建
bun run build
```

## 许可证

MIT

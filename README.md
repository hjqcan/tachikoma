# Tachikoma

> 以 pi-mono 为执行内核的编码助手 - Bun + TypeScript 实现

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3.14-f9f1e1.svg)](https://bun.sh/)

## 🎯 项目简介

**Tachikoma** 是一个对话优先的编码助手。默认 `chat` 与 `run` 共用
`ChatEngine`，模型流式、工具调用闭环和 `read/bash/edit/write/grep/find`
直接来自 pi-mono；旧 Orchestrator-Worker 系统仍可通过显式 `orchestrate`
命令使用，但不再是默认执行路径。

### 核心特性

- 💬 **对话优先**: ChatEngine 提供 token 级流式、多 Provider、会话恢复与中断
- 🔧 **pi-mono 工具循环**: 直接使用 pi 的模型↔工具循环和标准编码工具，不维护同功能执行器
- 🧠 **可选多智能体编排**: 旧 Orchestrator-Worker 由 `orchestrate` 显式进入
- 📦 **MCP 集成**: 完整的 Model Context Protocol 支持（Client/Router/Discovery/代码生成）
- 🗂️ **上下文工程**: 智能压缩、摘要、卸载、隔离、缓存五大策略
- 🧩 **多智能体协作**: WorkerPool + Collaboration 模块实现 Agent 间通信
- 🔒 **安全沙盒**: Docker/Firecracker 驱动的隔离执行环境
- 📊 **可观测性**: OpenTelemetry 追踪 + Prometheus 指标
- 📋 **SpecKit**: 面向规范开发 (Spec-Driven Development) 工作流

## 🏗️ 系统架构

```text
chat ─┐
      ├─> ChatEngine ─> pi-agent-core ─> pi-coding-agent tools
run ──┘        │
               └─> session transcript / GoodMemory（chat 可选）

orchestrate ─> ConversationalRunner ─> Orchestrator ─> Worker backends（旧兼容面）
```

## 📚 文档

| 文档               | 描述                                    |
| ------------------ | --------------------------------------- |
| [PRD](docs/PRD.md) | 产品需求文档 - 完整的系统设计和开发计划 |
| [参考资料](docs/)  | 架构设计参考文档集合                    |

## 🚀 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.3.14
- Docker (用于沙盒环境，可选)
- Node.js >= 22.19 (仅在不用 Bun 直接运行 pi 包时需要)

### 安装

```bash
# 克隆仓库
git clone https://github.com/hjqcan/tachikoma.git
cd tachikoma

# 安装依赖
bun install

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件，设置 ANTHROPIC_API_KEY、OPENROUTER_API_KEY 或 OPENAI_API_KEY
```

### CLI 使用

```bash
# 执行任务
bun run packages/core/bin/tachikoma.ts run \
  --task "帮我实现一个 TODO 应用" \
  --workdir ./my-project

# 显式使用旧多智能体编排器
bun run packages/core/bin/tachikoma.ts orchestrate \
  --task "规划并实现一个 TODO 应用" \
  --workdir ./my-project

# SpecKit 初始化
bun run packages/core/bin/tachikoma.ts speckit init --workdir ./my-project
```

### 环境变量

| 变量名                 | 描述                             | 必需 |
| ---------------------- | -------------------------------- | ---- |
| `ANTHROPIC_API_KEY`    | Anthropic API Key                | 是\* |
| `OPENROUTER_API_KEY`   | OpenRouter API Key               | 是\* |
| `OPENAI_API_KEY`       | OpenAI API Key                   | 是\* |
| `OPENROUTER_BASE_URL`  | API 端点 (默认: OpenRouter)      | 否   |
| `TACHIKOMA_CHAT_MODEL` | `run`/`chat` 使用的模型名称      | 否   |
| `TACHIKOMA_LOG_LEVEL`  | 日志级别 (debug/info/warn/error) | 否   |

> \*至少需要设置其中一个 API Key

## 📁 项目结构

```
tachikoma/
├── docs/                        # 文档
│   ├── PRD.md                   # 产品需求文档
│   └── references/              # 参考资料
├── packages/
│   ├── core/                    # 核心库 (主要开发区)
│   │   ├── bin/                 # CLI 入口
│   │   │   └── tachikoma.ts     # 主命令行工具
│   │   └── src/
│   │       ├── abstracts/       # 抽象基类 (BaseAgent, BaseSandbox)
│   │       ├── agents/          # 智能体实现 (WorkerAgent)
│   │       ├── collaboration/   # 多智能体协作 (Registry, Broker, Blackboard)
│   │       ├── config/          # 配置管理
│   │       ├── conversation/    # 多轮对话运行时
│   │       ├── factories/       # 工厂注册表
│   │       ├── mcp/             # MCP 集成 (Client, Router, Discovery)
│   │       ├── memory/          # 记忆系统 (MemoryService + 多后端)
│   │       ├── observability/   # 可观测性 (Logger, Tracer, Metrics)
│   │       ├── orchestrator/    # 统筹者 (Planner, WorkerPool, Session)
│   │       ├── planner/         # 任务规划器 (LLM 驱动)
│   │       ├── prompt/          # Prompt 上下文工程
│   │       ├── rag/             # 检索增强生成
│   │       ├── sandbox/         # 沙盒管理 (Docker/Local 驱动)
│   │       ├── skills/          # Skills 加载与执行
│   │       ├── speckit/         # SpecKit SDD 模块
│   │       ├── tools/           # 工具系统 (20+ 核心工具)
│   │       └── worker/          # 工作者 (Executor, Backend)
│   ├── sandbox/                 # 沙盒镜像配置 (Dockerfile)
│   ├── gateway/                 # API 网关
│   ├── agentops/                # AgentOps 仪表板
│   └── cli/                     # 独立 CLI 包
├── skills/                      # 官方 Skills 库
├── servers/                     # MCP 服务器代理
└── tests/                       # 测试套件
```

## 🧩 核心模块

### ChatEngine（默认运行时）

`chat` 与 `run` 的唯一执行内核。它持久化完整 pi transcript，并直接启用 pi 的标准编码工具：

```typescript
import { ChatEngine, resolveChatModelConfig } from '@tachikoma/core';

const engine = new ChatEngine({
  dataDir: './.tachikoma/chats',
  workDir: './my-project',
  model: resolveChatModelConfig(),
});
const session = await engine.createSession();
for await (const event of engine.sendMessage(session.sessionId, '创建一个 React 组件')) {
  console.log(event.type, event);
}
```

> `workDir` 是 pi 工具的 cwd 和相对路径基准，不是沙盒边界；审批/沙盒 hook 仍在后续安全门计划中。

### Orchestrator（可选旧编排器）

负责任务规划、分配和聚合的核心组件：

```typescript
import { Orchestrator } from '@tachikoma/core';

const orchestrator = new Orchestrator('main', {
  config: {
    planner: { maxSubtasks: 10 },
    workerPool: { maxWorkers: 5 },
  },
});

const result = await orchestrator.run({
  id: 'task-001',
  type: 'composite',
  objective: '实现用户认证系统',
  constraints: ['使用 JWT', '支持 OAuth'],
});
```

### ConversationalRunner（旧编排门面）

仅由显式 `orchestrate`/评估链使用，不是默认 `run` 的底层：

```typescript
import { ConversationalRunner } from '@tachikoma/core';

const runner = new ConversationalRunner({
  workDir: './my-project',
  llm: { apiKey: process.env.OPENROUTER_API_KEY },
});

const session = await runner.createSession();
for await (const event of runner.handleMessage(session.sessionId, '创建一个 React 组件')) {
  console.log(event.type, event);
}
```

### 旧编排工具系统（20+ 工具）

下列自研工具属于 `orchestrate`/worker 兼容面。默认 `run` 使用 pi 的
`read/bash/edit/write/grep/find`，不要在 ChatEngine 中复制这些执行器。

| 类别     | 工具                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| 文件操作 | `file_read`, `file_write`, `file_list`, `file_patch`, `file_replace_markers` |
| 代码搜索 | `code_search`, `grep_search`                                                 |
| 执行     | `shell_run`, `run_tests`, `type_check`                                       |
| 浏览器   | `browser_navigate`, `browser_click`, `browser_input`, `browser_screenshot`   |
| 网络     | `web_search`, `deep_research`                                                |
| 智能体   | `spawn_subagent`, `submit_result`, `report_back`                             |
| 辅助     | `env_get`, `package_info`, `security_check`                                  |

### MCP 集成

```typescript
import { MCPClientManager, MCPModeRouter, ToolDiscovery } from '@tachikoma/core';

// 动态发现和加载 MCP 工具
const discovery = createToolDiscovery(clientManager);
const tools = await discovery.discoverTools();

// 路由模式 (direct / sandbox / code-gen)
const router = createMCPModeRouter(clientManager, {
  defaultMode: 'direct',
});
```

### 多智能体协作

```typescript
import { CollaborationManager, FileBlackboard, FilePubSubHub } from '@tachikoma/core';

const collaboration = createCollaborationManager({
  mode: 'file', // 或 'redis'
  rootDir: './.tachikoma/collaboration',
});

// Agent 注册、消息代理、共享黑板
await collaboration.registry.register({ agentId: 'worker-1', role: 'worker' });
await collaboration.blackboard.write('shared-key', { data: 'value' });
```

## 🎯 设计理念

### 1. 统筹者-工作者模式

参考 Anthropic 的 Orchestrator-Workers 模式：

- **统筹者 (Orchestrator)**: 负责复杂推理、任务规划和协调 (低频)
- **工作者 (Worker)**: 负责具体任务执行 (高频)
- **规划器 (Planner)**: LLM 驱动的任务分解，生成 DAG 依赖图

### 2. 上下文工程五大策略

| 策略                  | 描述                         | 实现模块              |
| --------------------- | ---------------------------- | --------------------- |
| **缩减 (Reduction)**  | 压缩（可逆）+ 摘要（不可逆） | `prompt/strategies/`  |
| **卸载 (Offloading)** | 转储到文件系统               | `prompt/memory/`      |
| **检索 (Retrieval)**  | 按需加载上下文               | `rag/`, `memory/`     |
| **隔离 (Isolation)**  | 子智能体独立上下文           | `worker/`, `sandbox/` |
| **缓存 (Caching)**    | KV 缓存优化                  | `prompt/cache/`       |

### 3. 分层式行为空间

| 层级        | 描述                  | 效率优势               |
| ----------- | --------------------- | ---------------------- |
| **Layer 1** | 原子函数调用 (20+ 个) | 约束解码，Schema 安全  |
| **Layer 2** | 沙盒工具 (shell 命令) | 不占用函数调用上下文   |
| **Layer 3** | 软件包/API (代码执行) | 处理大量数据和内存计算 |

### 4. 面向规范开发 (Spec-Driven Development)

Tachikoma 集成了 SpecKit 模块，支持规范驱动的开发工作流：

```bash
# 初始化 SpecKit 目录结构
tachikoma speckit init --workdir ./my-project
```

**工作流：**

1. **Constitution** - 建立项目宪法和治理原则
2. **Specification** - 将需求转化为结构化功能规范
3. **Plan** - 基于规范和技术栈生成实现计划
4. **Tasks** - 分解计划为可执行任务

**目录结构：**

```
.tachikoma/speckit/
├── memory/           # 项目宪法 (constitution.md)
├── specs/            # 功能规范 (001-feature-name/)
│   └── {spec-id}/
│       ├── spec.md
│       ├── plan.md
│       └── tasks.md
└── templates/        # 模板文件
```

## 🔧 技术栈

| 类别       | 技术                         |
| ---------- | ---------------------------- |
| **运行时** | Bun                          |
| **语言**   | TypeScript 5.0+              |
| **Web**    | Hono / Elysia                |
| **存储**   | Redis + LevelDB              |
| **向量库** | Qdrant / Chroma (可选)       |
| **沙盒**   | Docker / Firecracker / Local |
| **可观测** | OpenTelemetry + Prometheus   |
| **验证**   | Zod                          |

## 📊 开发状态

| 模块            | 状态      | 说明                                    |
| --------------- | --------- | --------------------------------------- |
| Orchestrator    | ✅ 完成   | plan→assign→aggregate 流程、检查点恢复  |
| Planner         | ✅ 完成   | LLM 任务分解、DAG 生成                  |
| Worker          | ✅ 完成   | GenericAgentBackend、进度追踪、降级策略 |
| Tools (20+)     | ✅ 完成   | 文件/Shell/浏览器/搜索/子智能体等       |
| MCP 集成        | ✅ 完成   | Client/Router/Registrar/Discovery       |
| Conversation    | ✅ 完成   | 多轮对话、意图分析、反馈循环            |
| Memory          | ✅ 完成   | MemoryService + Redis/LevelDB/Vector    |
| Collaboration   | ✅ 完成   | 文件/Redis 双后端 Agent 协作            |
| Prompt Engine   | ✅ 完成   | 上下文工程五策略                        |
| Skills          | ✅ 完成   | 加载/执行/渐进披露                      |
| SpecKit         | 🔄 进行中 | 初始化/模板生成完成，生成器整合中       |
| API Gateway     | 📋 计划中 | 安全网关层                              |
| AgentOps 仪表板 | 📋 计划中 | 可视化监控                              |

## 🤝 贡献

欢迎贡献！请查看 [贡献指南](CONTRIBUTING.md) 了解详情。

## 📄 许可证

[MIT License](LICENSE)

## 🙏 致谢

本项目参考了以下优秀的研究和实践：

- [Anthropic - Building Effective AI Agents](https://docs.anthropic.com/en/docs/build-with-claude/building-effective-agents)
- [Anthropic - Context Engineering](https://docs.anthropic.com/en/docs/build-with-claude/context-engineering)
- [Anthropic - Code Execution with MCP](https://docs.anthropic.com/en/docs/build-with-claude/code-execution-mcp)
- [Manus - 上下文工程实践](https://manus.ai)
- [LangChain - Agent Frameworks](https://langchain.com)

---

_如果你有任何不清楚的地方，请向我提问。_

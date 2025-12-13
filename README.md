# Tachikoma

> 类 Claude Code 多智能体系统 (MAS) - Bun + TypeScript 实现

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-f9f1e1.svg)](https://bun.sh/)

## 🎯 项目简介

**Tachikoma**
是一个基于统筹者-工作者（Orchestrator-Worker）模式的多智能体编码系统。名称取自《攻壳机动队》中的思考战车 AI，象征具有自主思考能力的智能代理系统。

### 核心特性

- 🧠 **双系统架构**: System 2 (慢思考/规划) + System 1 (快执行/行动)
- 🔧 **分层式行为空间**: 原子函数 → 沙盒工具 → 软件包/API
- 📦 **Code Execution with MCP**: 通过代码执行调用工具，减少 80%+ Token 消耗
- 🗂️ **上下文工程**: 智能压缩、摘要、卸载，防止"上下文腐烂"
- 🔒 **安全沙盒**: 完全隔离的代码执行环境
- 📊 **AgentOps**: 完整的可观测性、评估和持续改进机制

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Layer 5: AgentOps & Governance                   │
│         (可观测性、评估、质量飞轮、持续改进)                           │
├─────────────────────────────────────────────────────────────────────┤
│                Layer 4: Context & Memory Management                  │
│         (上下文工程、会话管理、长期记忆、Skills)                        │
├─────────────────────────────────────────────────────────────────────┤
│              Layer 3: Execution Core & Tools (System 1)              │
│         (工作者智能体、代码沙盒、分层式行为空间、MCP)                    │
├─────────────────────────────────────────────────────────────────────┤
│             Layer 2: Orchestration & Planning (System 2)             │
│         (统筹者智能体、任务分解、长时任务管理、A2A)                      │
├─────────────────────────────────────────────────────────────────────┤
│              Layer 1: Interaction & Security Gateway                 │
│         (API网关、安全执行点、身份认证、集中式日志)                      │
└─────────────────────────────────────────────────────────────────────┘
```

## 📚 文档

| 文档               | 描述                                    |
| ------------------ | --------------------------------------- |
| [PRD](docs/PRD.md) | 产品需求文档 - 完整的系统设计和开发计划 |
| [参考资料](docs/)  | 架构设计参考文档集合                    |

## 🚀 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.0
- Docker (用于沙盒环境)
- Node.js >= 20 (可选)

### 安装

```bash
# 克隆仓库
git clone https://github.com/hjqcan/tachikoma.git
cd tachikoma

# 安装依赖
bun install

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件，设置 API 密钥等

# 启动开发服务器
bun run dev
```

## 📁 项目结构

```
tachikoma/
├── docs/                     # 文档
│   ├── PRD.md               # 产品需求文档
│   └── references/          # 参考资料
├── packages/
│   ├── core/                # 核心库
│   │   ├── src/agents/      # 智能体实现
│   │   ├── src/conversation/# 多轮对话 runtime
│   │   ├── src/prompt/      # Prompt 上下文工程（internal）
│   │   ├── src/tools/       # 工具系统
│   │   ├── src/sandbox/     # 沙盒管理
│   │   └── src/mcp/         # MCP 集成
│   ├── gateway/             # API 网关
│   ├── agentops/            # 可观测性
│   └── cli/                 # 命令行工具
├── skills/                  # Skills 库
├── servers/                 # MCP 服务器代理
└── sandbox/                 # 沙盒环境配置
```

## 🎯 设计理念

### 1. 统筹者-工作者模式

参考 Anthropic 的 Orchestrator-Workers 模式：

- **统筹者**: 负责复杂推理、任务规划和协调 (低频)
- **工作者**: 负责具体任务执行 (高频)

### 2. 上下文工程五大策略

| 策略                  | 描述                         |
| --------------------- | ---------------------------- |
| **缩减 (Reduction)**  | 压缩（可逆）+ 摘要（不可逆） |
| **卸载 (Offloading)** | 转储到文件系统               |
| **检索 (Retrieval)**  | 按需加载上下文               |
| **隔离 (Isolation)**  | 子智能体独立上下文           |
| **缓存 (Caching)**    | KV 缓存优化                  |

### 3. 分层式行为空间

| 层级        | 描述                    | 效率优势               |
| ----------- | ----------------------- | ---------------------- |
| **Layer 1** | 原子函数调用 (10-20 个) | 约束解码，Schema 安全  |
| **Layer 2** | 沙盒工具 (shell 命令)   | 不占用函数调用上下文   |
| **Layer 3** | 软件包/API (代码执行)   | 处理大量数据和内存计算 |

## 🔧 技术栈

- **运行时**: Bun
- **语言**: TypeScript
- **Web 框架**: Hono / Elysia
- **数据存储**: Redis + LevelDB
- **沙盒**: Docker / Firecracker
- **可观测性**: OpenTelemetry + Prometheus + Grafana
- **任务队列**: BullMQ

## 📊 开发计划

| 阶段    | 周期 | 内容                 |
| ------- | ---- | -------------------- |
| Phase 1 | 4 周 | 基础架构与安全网关层 |
| Phase 2 | 4 周 | 统筹与规划层         |
| Phase 3 | 3 周 | 执行核心与工具层     |
| Phase 4 | 3 周 | 上下文与持久层       |
| Phase 5 | 2 周 | AgentOps 与治理层    |

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

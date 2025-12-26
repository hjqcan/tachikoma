# Orchestrator Skills 设计规划

> 统筹者智能体技能系统设计文档
>
> 版本: v1.0 | 日期: 2025-12-26 | 状态: 规划中

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [业界调研](#2-业界调研)
3. [技能分类体系](#3-技能分类体系)
4. [详细技能设计](#4-详细技能设计)
5. [技术实现方案](#5-技术实现方案)
6. [实施路线图](#6-实施路线图)
7. [评估指标](#7-评估指标)

---

## 1. 背景与动机

### 1.1 现状分析

Tachikoma 采用 **Orchestrator-Worker** 双系统架构：

| 组件                        | 角色                       | 当前 Skills 支持 |
| --------------------------- | -------------------------- | ---------------- |
| **Orchestrator (System 2)** | 慢思考、任务规划、资源协调 | ❌ 无            |
| **Worker (System 1)**       | 快执行、具体任务实现       | ✅ 完整支持      |

**问题**:
Worker 可以加载领域技能（如代码审查、测试模式等），但 Orchestrator 缺乏对应的"元技能"支持，导致规划质量依赖于 prompt 硬编码。

### 1.2 为什么 Orchestrator 需要 Skills

1. **规划模式复用**: 不同项目类型（新建项目、功能添加、bug 修复）有不同的最佳实践模式
2. **上下文工程决策**: 何时压缩、何时摘要、何时隔离需要策略指导
3. **Worker 协调策略**: 角色分配、并行度控制、依赖管理需要经验积累
4. **自我反思能力**: 规划评估、风险识别、恢复策略需要结构化知识

### 1.3 目标

- 提升 Planner 的任务分解质量
- 增强 Orchestrator 的上下文管理能力
- 实现可复用、可扩展的规划知识库
- 填补业界在 Orchestrator 层 Skills 的空白

---

## 2. 业界调研

### 2.1 主要框架/产品能力对比

| 能力领域       | Manus       | AutoGPT      | LangGraph     | CrewAI      | Tachikoma (目标)      |
| -------------- | ----------- | ------------ | ------------- | ----------- | --------------------- |
| **上下文工程** | ✅ 五策略   | 基础         | 状态管理      | 基础        | ✅ 五策略 + Skills    |
| **任务分解**   | ✅ DAG      | ✅ 递归      | ✅ 节点化     | ✅ 任务链   | ✅ DAG + 模式库       |
| **记忆管理**   | ✅ 多层记忆 | ✅ 短期/长期 | ✅ 状态持久化 | 基础        | ✅ MemoryService      |
| **自我反思**   | 隐式        | ✅ 显式循环  | 隐式          | 隐式        | ⭐ 需增强             |
| **资源规划**   | 隐式        | ✅ 预算感知  | 隐式          | 隐式        | ⭐ 需增强             |
| **条件路由**   | 隐式        | 隐式         | ✅ 显式定义   | 隐式        | ⭐ 需增强             |
| **角色定义**   | 隐式        | 隐式         | 隐式          | ✅ 显式定义 | ⭐ 需增强             |
| **协作协议**   | 基础        | 基础         | 状态共享      | ✅ 对话式   | ✅ Collaboration 模块 |

### 2.2 Anthropic 官方 Skills 分析

来源: `github.com/anthropics/skills`

| Skill                | 类型       | Orchestrator 可用性 |
| -------------------- | ---------- | ------------------- |
| `algorithmic-art`    | Creative   | ❌ Worker 专用      |
| `brand-guidelines`   | Enterprise | ❌ Worker 专用      |
| `mcp-builder`        | Technical  | ⚠️ 可借鉴           |
| `skill-creator`      | Meta       | ✅ 可用于自动生成   |
| `webapp-testing`     | Technical  | ❌ Worker 专用      |
| `docx/pdf/pptx/xlsx` | Document   | ❌ Worker 专用      |

**结论**: 官方重点是执行能力，缺少规划层专用技能。

---

## 3. 技能分类体系

### 3.1 Orchestrator Skills 分类

```
skills/
├── worker/                     # Worker 专用技能 (现有)
│   ├── code-review/
│   ├── testing-patterns/
│   └── ...
│
├── orchestrator/               # Orchestrator 专用技能 (新增)
│   ├── planning/               # 规划类
│   │   ├── task-decomposition/
│   │   ├── project-archetypes/
│   │   └── dependency-analysis/
│   │
│   ├── delegation/             # 委托类
│   │   ├── worker-roles/
│   │   ├── parallelization/
│   │   └── load-balancing/
│   │
│   ├── context/                # 上下文类
│   │   ├── budget-management/
│   │   ├── summarization-triggers/
│   │   └── isolation-strategy/
│   │
│   ├── monitoring/             # 监控类
│   │   ├── progress-evaluation/
│   │   ├── replan-triggers/
│   │   └── quality-gates/
│   │
│   └── recovery/               # 恢复类
│       ├── risk-mitigation/
│       ├── rollback-strategy/
│       └── escalation-policy/
│
└── shared/                     # 共享技能
    ├── communication/
    └── logging/
```

### 3.2 技能与组件映射

| 技能类别   | 主要消费者                  | 加载时机      |
| ---------- | --------------------------- | ------------- |
| Planning   | Planner                     | 任务规划时    |
| Delegation | Orchestrator                | Worker 分配时 |
| Context    | PromptEngine / Orchestrator | 上下文管理时  |
| Monitoring | Orchestrator                | 任务执行中    |
| Recovery   | Orchestrator                | 异常处理时    |

---

## 4. 详细技能设计

### 4.1 task-decomposition (任务分解)

**路径**: `skills/orchestrator/planning/task-decomposition/SKILL.md`

```yaml
---
name: task-decomposition
description: |
  任务分解模式与最佳实践。用于将复杂任务分解为可执行的子任务，
  生成 DAG 依赖图，并估算复杂度和时间。
triggers:
  - 规划复杂任务
  - 分解大型目标
  - 生成子任务
scope: orchestrator
---
```

**核心内容**:

```markdown
# Task Decomposition Patterns

## 1. WBS (Work Breakdown Structure)

### 原则

- **100% 规则**: 子任务之和必须覆盖父任务的全部工作量
- **互斥性**: 子任务之间不应有重叠
- **可交付物导向**: 每个叶子节点应产出可验证的交付物

### 分解层级

1. **Phase (阶段)**: 项目的主要里程碑
2. **Deliverable (交付物)**: 可验证的工作产出
3. **Work Package (工作包)**: 可分配给单个 Worker 的任务单元

## 2. MECE 原则

**Mutually Exclusive, Collectively Exhaustive**

### 检查清单

- [ ] 子任务是否互不重叠？
- [ ] 子任务合起来是否覆盖完整？
- [ ] 是否遗漏了边界情况？
- [ ] 是否有隐含的跨领域依赖？

## 3. 依赖关系识别

### 依赖类型

| 类型                  | 描述                | 示例                |
| --------------------- | ------------------- | ------------------- |
| Finish-to-Start (FS)  | A 完成后 B 才能开始 | 设计 → 实现         |
| Start-to-Start (SS)   | A 开始后 B 才能开始 | 前端 ↔ 后端联调     |
| Finish-to-Finish (FF) | A 完成后 B 才能完成 | 功能实现 → 集成测试 |

### 关键路径识别

1. 识别所有 FS 依赖链
2. 计算每条路径的总时间
3. 最长路径即为关键路径
4. 关键路径上的任务需优先执行

## 4. 复杂度评估

### 评估维度

| 维度     | 低 (1-3) | 中 (4-6)   | 高 (7-10)  |
| -------- | -------- | ---------- | ---------- |
| 代码规模 | <100 行  | 100-500 行 | >500 行    |
| 依赖数量 | 0-1      | 2-3        | >3         |
| 不确定性 | 明确需求 | 部分模糊   | 高度不确定 |
| 技术风险 | 熟悉技术 | 学习曲线   | 新技术探索 |

### 估时公式
```

估计时间 = 基准时间 × (1 + 复杂度系数 × 0.2) × 风险因子

```

## 5. 分解示例

### 输入
```

目标: 实现用户认证系统约束: 使用 JWT, 支持 OAuth, 30分钟超时

````

### 输出
```json
{
  "subtasks": [
    {
      "id": "auth-1",
      "objective": "设计认证 API 接口规范",
      "dependencies": [],
      "complexity": "simple",
      "estimatedMinutes": 15
    },
    {
      "id": "auth-2",
      "objective": "实现 JWT 生成和验证模块",
      "dependencies": ["auth-1"],
      "complexity": "moderate",
      "estimatedMinutes": 30
    },
    {
      "id": "auth-3",
      "objective": "集成 OAuth 提供商 (Google/GitHub)",
      "dependencies": ["auth-1"],
      "complexity": "moderate",
      "estimatedMinutes": 45
    },
    {
      "id": "auth-4",
      "objective": "实现会话管理和超时逻辑",
      "dependencies": ["auth-2"],
      "complexity": "simple",
      "estimatedMinutes": 20
    },
    {
      "id": "auth-5",
      "objective": "编写认证模块集成测试",
      "dependencies": ["auth-2", "auth-3", "auth-4"],
      "complexity": "moderate",
      "estimatedMinutes": 30
    }
  ]
}
````

````

---

### 4.2 project-archetypes (项目类型模板)

**路径**: `skills/orchestrator/planning/project-archetypes/SKILL.md`

```yaml
---
name: project-archetypes
description: |
  常见项目类型的规划模板。根据任务特征自动匹配最佳实践模式，
  提供标准化的阶段划分和检查点。
triggers:
  - 新项目规划
  - 识别项目类型
  - 选择开发模式
scope: orchestrator
---
````

**核心内容**:

````markdown
# Project Archetypes

## 1. Greenfield Development (新建项目)

### 特征识别

- 目标包含 "创建", "新建", "从零开始"
- 无现有代码库引用
- 需要技术栈选型

### 标准阶段

1. **Scaffolding (脚手架)** - 10%
   - 初始化项目结构
   - 配置开发环境
   - 设置 CI/CD 基础

2. **Core Architecture (核心架构)** - 25%
   - 设计系统架构
   - 定义核心接口
   - 搭建基础设施

3. **Feature Implementation (功能实现)** - 45%
   - 实现核心功能
   - 并行开发多模块
   - 持续集成验证

4. **Integration & Testing (集成测试)** - 15%
   - 模块集成
   - 端到端测试
   - 性能优化

5. **Documentation & Polish (文档完善)** - 5%
   - 编写文档
   - 代码审查
   - 最终验收

---

## 2. Feature Addition (功能添加)

### 特征识别

- 目标包含 "添加", "实现", "支持"
- 引用现有代码库
- 需要与现有系统集成

### 标准阶段

1. **Codebase Analysis (代码分析)** - 15%
   - 理解现有架构
   - 识别扩展点
   - 评估影响范围

2. **Interface Design (接口设计)** - 15%
   - 定义新增接口
   - 规划集成方式
   - 兼容性评估

3. **Implementation (实现)** - 50%
   - 编写核心代码
   - 实现边界处理
   - 本地验证

4. **Integration Testing (集成测试)** - 15%
   - 与现有功能集成
   - 回归测试
   - 边界测试

5. **Documentation (文档)** - 5%
   - 更新 API 文档
   - 添加使用示例

---

## 3. Bug Fix (问题修复)

### 特征识别

- 目标包含 "修复", "解决", "bug", "问题"
- 有具体错误描述或复现步骤
- 需要定位根因

### 标准阶段

1. **Reproduction (复现)** - 20%
   - 确认问题存在
   - 建立复现步骤
   - 记录预期 vs 实际行为

2. **Root Cause Analysis (根因分析)** - 30%
   - 追踪错误来源
   - 理解失败机制
   - 识别关联问题

3. **Fix Implementation (修复实现)** - 25%
   - 编写最小修复
   - 避免引入新问题
   - 本地验证

4. **Regression Testing (回归测试)** - 20%
   - 添加防护测试
   - 运行相关测试套件
   - 验证无副作用

5. **Documentation (文档)** - 5%
   - 记录问题和解决方案
   - 更新已知问题列表

---

## 4. Refactoring (重构)

### 特征识别

- 目标包含 "重构", "优化", "改进", "清理"
- 功能行为不变
- 关注代码质量或性能

### 标准阶段

1. **Test Baseline (测试基线)** - 20%
   - 确保测试覆盖率
   - 添加缺失测试
   - 记录当前行为

2. **Incremental Refactoring (增量重构)** - 50%
   - 小步重构
   - 每步验证测试通过
   - 保持提交粒度小

3. **Performance Validation (性能验证)** - 15%
   - 对比重构前后性能
   - 识别潜在瓶颈
   - 优化热点

4. **Code Review (代码审查)** - 10%
   - 同行审查
   - 架构评审
   - 文档更新

5. **Final Verification (最终验证)** - 5%
   - 完整测试套件
   - 无回归确认

---

## 5. 类型匹配逻辑

```typescript
function matchProjectArchetype(objective: string, constraints: string[]): Archetype {
  const lowerObj = objective.toLowerCase();

  if (lowerObj.match(/创建|新建|从零|initialize|bootstrap|scaffold/)) {
    return 'greenfield';
  }

  if (lowerObj.match(/修复|解决|bug|fix|issue|problem|error/)) {
    return 'bugfix';
  }

  if (lowerObj.match(/重构|优化|清理|refactor|optimize|clean/)) {
    return 'refactoring';
  }

  // 默认为功能添加
  return 'feature_addition';
}
```
````

````

---

### 4.3 worker-roles (Worker 角色定义)

**路径**: `skills/orchestrator/delegation/worker-roles/SKILL.md`

```yaml
---
name: worker-roles
description: |
  Worker 角色定义与任务分配策略。基于任务特征自动匹配最佳执行者，
  支持专业化分工和负载均衡。
triggers:
  - 分配子任务
  - 选择 Worker
  - 角色匹配
scope: orchestrator
---
````

**核心内容**:

````markdown
# Worker Roles

## 1. 预定义角色

### frontend-specialist

**能力领域**:

- React/Vue/Angular 组件开发
- CSS/样式系统
- 用户界面交互
- 响应式设计
- 无障碍访问

**匹配关键词**: `UI`, `组件`, `页面`, `样式`, `CSS`, `前端`, `界面`, `交互`

---

### backend-specialist

**能力领域**:

- API 设计与实现
- 数据库操作
- 服务端逻辑
- 认证授权
- 性能优化

**匹配关键词**: `API`, `服务`, `数据库`, `后端`, `接口`, `服务器`, `认证`

---

### testing-specialist

**能力领域**:

- 单元测试
- 集成测试
- E2E 测试
- 测试覆盖率
- Mock 策略

**匹配关键词**: `测试`, `test`, `验证`, `覆盖率`, `断言`, `mock`

---

### devops-specialist

**能力领域**:

- CI/CD 流水线
- Docker 容器化
- 部署配置
- 监控告警
- 基础设施

**匹配关键词**: `部署`, `CI`, `CD`, `Docker`, `容器`, `流水线`, `监控`

---

### docs-specialist

**能力领域**:

- API 文档
- 用户指南
- 架构文档
- 代码注释
- README

**匹配关键词**: `文档`, `README`, `指南`, `说明`, `注释`, `API 文档`

---

## 2. 角色匹配算法

```typescript
interface RoleMatch {
  roleId: string;
  score: number;
  reasons: string[];
}

function matchRole(subtask: SubTask): RoleMatch[] {
  const objective = subtask.objective.toLowerCase();
  const matches: RoleMatch[] = [];

  for (const role of PREDEFINED_ROLES) {
    let score = 0;
    const reasons: string[] = [];

    for (const keyword of role.keywords) {
      if (objective.includes(keyword)) {
        score += keyword.length; // 长关键词权重更高
        reasons.push(`匹配关键词: ${keyword}`);
      }
    }

    if (score > 0) {
      matches.push({ roleId: role.id, score, reasons });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}
```
````

## 3. 并行分配策略

### 独立任务并行

```
条件: 子任务之间无依赖
策略: 按角色分组，并行分配
最大并行度: min(可用 Worker 数, 独立任务数)
```

### 流水线并行

```
条件: 子任务形成线性依赖链
策略: 前序任务完成后立即启动后序
优化: 任务拆分以增加并行机会
```

### 混合模式

```
条件: 部分任务独立，部分有依赖
策略:
  1. 识别关键路径
  2. 优先调度关键路径任务
  3. 非关键任务填充空闲 Worker
```

## 4. 负载均衡

### 策略选项

| 策略          | 描述                      | 适用场景         |
| ------------- | ------------------------- | ---------------- |
| Round-Robin   | 轮询分配                  | 任务复杂度均匀   |
| Least-Loaded  | 分配给最空闲 Worker       | 任务复杂度差异大 |
| Role-Affinity | 优先分配给匹配角色        | 专业化任务       |
| Sticky        | 相关任务分配给同一 Worker | 需要上下文连续性 |

````

---

### 4.4 context-budget (上下文预算管理)

**路径**: `skills/orchestrator/context/budget-management/SKILL.md`

```yaml
---
name: context-budget
description: |
  上下文窗口预算管理策略。定义何时触发压缩、摘要或卸载，
  确保上下文不会"腐烂"影响模型性能。
triggers:
  - 上下文超阈值
  - 规划大型任务
  - 优化 token 使用
scope: orchestrator
---
````

**核心内容**:

```markdown
# Context Budget Management

## 1. 阈值体系
```

┌─────────────────────────────────────────────────┐ │ Hard Limit (1M) │
← 模型物理限制 ├─────────────────────────────────────────────────┤ │ Rot Threshold (200k) │
← 性能下降点 ├─────────────────────────────────────────────────┤ │ Summarization Trigger (150k) │
← 强制摘要 ├─────────────────────────────────────────────────┤ │ Compaction Trigger (128k) │
← 触发压缩 ├─────────────────────────────────────────────────┤ │ Comfort Zone (< 100k) │
← 最佳性能区 └─────────────────────────────────────────────────┘

```

## 2. 预算分配原则

### Orchestrator 上下文分配
| 组成部分 | 建议占比 | 说明 |
|----------|----------|------|
| 系统提示 | 5-10% | 角色定义 + Skills |
| 任务描述 | 10-15% | 目标 + 约束 |
| 计划状态 | 15-20% | 当前 DAG + 进度 |
| Worker 报告 | 30-40% | 子任务结果摘要 |
| 历史决策 | 10-15% | 关键决策记录 |
| 缓冲区 | 10-15% | 预留给响应生成 |

### Worker 上下文分配
| 组成部分 | 建议占比 | 说明 |
|----------|----------|------|
| 系统提示 | 5-10% | 角色 + 指南 + Skills |
| 子任务描述 | 10-15% | 目标 + 约束 |
| 代码上下文 | 40-50% | 相关文件内容 |
| 工具调用历史 | 15-20% | 最近操作记录 |
| 缓冲区 | 10-15% | 预留给响应生成 |

## 3. 缩减策略选择

### 决策树
```

上下文超过阈值? ├─ < 128k: 不处理 ├─ 128k-150k: 执行压缩 │ └─ 压缩后 < 128k? │ ├─ 是: 完成 │
└─ 否: 继续评估 ├─ 150k-200k: 执行摘要 │ └─ 优先摘要旧消息 └─ >
200k: 强制摘要 + 卸载 └─ 卸载工具输出到文件

````

### 压缩 vs 摘要选择
| 条件 | 选择 | 原因 |
|------|------|------|
| 信息可能需要恢复 | 压缩 | 可逆 |
| 工具输出过大 | 卸载 | 保留引用 |
| 历史对话过长 | 摘要 | 提取关键信息 |
| 重复信息多 | 压缩 | 去重效果好 |

## 4. 信息优先级

### 保留优先级 (高 → 低)
1. 当前任务目标和约束
2. 最近 5 次工具调用
3. 未解决的阻塞问题
4. 关键决策记录
5. 修改的文件列表
6. 历史对话摘要
7. 旧工具调用详情

### 卸载候选
- 大型文件内容 (> 5k tokens)
- 命令输出 (> 2k tokens)
- 已完成子任务的详细结果
- 调试日志

## 5. 监控指标

```typescript
interface ContextBudgetMetrics {
  currentTokens: number;
  utilizationPercent: number;

  // 分布
  systemPromptTokens: number;
  taskContextTokens: number;
  toolHistoryTokens: number;
  messageHistoryTokens: number;

  // 缩减历史
  compactionCount: number;
  summarizationCount: number;
  offloadCount: number;

  // 效率
  tokensSavedByCompaction: number;
  tokensSavedBySummarization: number;
}
````

````

---

### 4.5 progress-evaluation (进度评估)

**路径**: `skills/orchestrator/monitoring/progress-evaluation/SKILL.md`

```yaml
---
name: progress-evaluation
description: |
  子任务进度评估与重规划触发条件。定义如何判断任务是否正常推进，
  以及何时需要人工干预或自动重规划。
triggers:
  - 子任务完成
  - 子任务超时
  - 检测异常
scope: orchestrator
---
````

**核心内容**:

````markdown
# Progress Evaluation

## 1. 完成信号识别

### 成功信号

| 信号类型   | 检测方式                    | 置信度 |
| ---------- | --------------------------- | ------ |
| 显式声明   | Worker 调用 `submit_result` | 高     |
| 测试通过   | `run_tests` 返回成功        | 高     |
| 构建成功   | `type_check` / build 通过   | 中-高  |
| 文件变更   | 目标文件已创建/修改         | 中     |
| 无错误退出 | Worker 正常结束             | 中     |

### 失败信号

| 信号类型 | 检测方式             | 严重程度 |
| -------- | -------------------- | -------- |
| 显式失败 | Worker 报告错误      | 高       |
| 测试失败 | `run_tests` 返回失败 | 高       |
| 构建失败 | 编译/类型错误        | 高       |
| 超时     | 超过预估时间 2x      | 中       |
| 循环检测 | 相同操作重复 3+ 次   | 中       |
| 资源耗尽 | Token 超限           | 高       |

## 2. 进度健康度评分

```typescript
interface ProgressHealth {
  score: number; // 0-100
  status: 'healthy' | 'warning' | 'critical';
  factors: HealthFactor[];
}

interface HealthFactor {
  name: string;
  weight: number;
  value: number;
  reason: string;
}

function calculateHealth(subtask: SubTask, execution: ExecutionState): ProgressHealth {
  const factors: HealthFactor[] = [];

  // 时间因素 (30%)
  const timeRatio = execution.elapsed / subtask.estimatedMinutes;
  factors.push({
    name: '时间进度',
    weight: 0.3,
    value: timeRatio <= 1 ? 100 : Math.max(0, 100 - (timeRatio - 1) * 50),
    reason: timeRatio <= 1 ? '按时推进' : `超时 ${((timeRatio - 1) * 100).toFixed(0)}%`,
  });

  // 错误因素 (30%)
  const errorPenalty = Math.min(execution.errorCount * 20, 100);
  factors.push({
    name: '错误频率',
    weight: 0.3,
    value: 100 - errorPenalty,
    reason: execution.errorCount === 0 ? '无错误' : `${execution.errorCount} 次错误`,
  });

  // 工具调用效率 (20%)
  const toolEfficiency = (execution.successfulToolCalls / execution.totalToolCalls) * 100;
  factors.push({
    name: '工具效率',
    weight: 0.2,
    value: toolEfficiency,
    reason: `${toolEfficiency.toFixed(0)}% 成功率`,
  });

  // 循环检测 (20%)
  const loopPenalty = Math.min(execution.duplicateToolCalls * 30, 100);
  factors.push({
    name: '循环风险',
    weight: 0.2,
    value: 100 - loopPenalty,
    reason:
      execution.duplicateToolCalls === 0 ? '无循环' : `${execution.duplicateToolCalls} 次重复`,
  });

  const score = factors.reduce((sum, f) => sum + f.value * f.weight, 0);

  return {
    score,
    status: score >= 70 ? 'healthy' : score >= 40 ? 'warning' : 'critical',
    factors,
  };
}
```
````

## 3. 重规划触发条件

### 自动触发

| 条件                | 动作           | 优先级 |
| ------------------- | -------------- | ------ |
| 健康度 < 40         | 暂停并重规划   | 高     |
| 子任务连续失败 3 次 | 尝试备选方案   | 高     |
| 超时 > 3x 估时      | 拆分或降级     | 中     |
| 依赖项变更          | 更新受影响任务 | 中     |
| 资源冲突检测        | 串行化冲突任务 | 低     |

### 需人工确认

| 条件         | 动作     | 原因       |
| ------------ | -------- | ---------- |
| 需求变更     | 重新规划 | 影响范围大 |
| 技术方案争议 | 选择方案 | 需要决策   |
| 安全风险     | 审批继续 | 合规要求   |
| 成本超预算   | 确认预算 | 资源限制   |

## 4. 聚合结果评估

### 整体完成度

```typescript
function calculateOverallProgress(plan: Plan): number {
  let totalWeight = 0;
  let completedWeight = 0;

  for (const subtask of plan.subtasks) {
    const weight = getSubtaskWeight(subtask);
    totalWeight += weight;

    if (subtask.status === 'completed') {
      completedWeight += weight;
    } else if (subtask.status === 'in_progress') {
      completedWeight += weight * 0.5; // 进行中算一半
    }
  }

  return completedWeight / totalWeight;
}

function getSubtaskWeight(subtask: SubTask): number {
  // 基于复杂度和估时
  const complexityMultiplier = {
    simple: 1,
    moderate: 2,
    complex: 4,
  };
  return (subtask.estimatedMinutes || 30) * complexityMultiplier[subtask.complexity];
}
```

````

---

### 4.6 risk-mitigation (风险缓解)

**路径**: `skills/orchestrator/recovery/risk-mitigation/SKILL.md`

```yaml
---
name: risk-mitigation
description: |
  风险识别与缓解策略。定义常见失败模式的识别方法和恢复动作，
  支持 Checkpoint 恢复和优雅降级。
triggers:
  - 任务失败
  - 异常检测
  - 风险评估
scope: orchestrator
---
````

**核心内容**:

```markdown
# Risk Mitigation

## 1. 常见失败模式

### 技术类

| 模式       | 症状        | 根因         | 恢复策略        |
| ---------- | ----------- | ------------ | --------------- |
| Token 耗尽 | 响应截断    | 上下文过大   | 强制摘要 + 重试 |
| 工具超时   | 无响应      | 命令阻塞     | 终止 + 超时重试 |
| 解析失败   | JSON 错误   | 模型输出异常 | 提示修正 + 重试 |
| 依赖缺失   | import 错误 | 包未安装     | 安装依赖 + 重试 |
| 权限拒绝   | 访问被拒    | 权限不足     | 请求授权 / 降级 |

### 逻辑类

| 模式     | 症状     | 根因         | 恢复策略        |
| -------- | -------- | ------------ | --------------- |
| 死循环   | 重复操作 | 条件判断错误 | 检测并中断      |
| 任务漂移 | 偏离目标 | 目标理解偏差 | 重申目标 + 重试 |
| 资源冲突 | 并发错误 | 同时修改     | 串行化          |
| 依赖阻塞 | 等待超时 | 前序任务卡住 | 备选路径        |

### 环境类

| 模式     | 症状     | 根因       | 恢复策略        |
| -------- | -------- | ---------- | --------------- |
| 网络错误 | 连接失败 | 网络不稳定 | 指数退避重试    |
| API 限流 | 429 错误 | 请求过多   | 降低并发 + 延迟 |
| 沙盒崩溃 | 进程终止 | 资源超限   | 重建沙盒        |

## 2. 风险评估矩阵
```

影响 ↑ 高 │ ⚠️ 中风险 │ 🔴 高风险 │
💀 极高风险 │ 监控 + 预案│ 主动缓解 │ 必须处理 ───┼───────────┼───────────┼─────────── 中 │
✅ 低风险 │ ⚠️ 中风险 │
🔴 高风险 │ 接受 │ 监控 + 预案│ 主动缓解 ───┼───────────┼───────────┼─────────── 低 │ ✅ 低风险 │
✅ 低风险 │ ⚠️ 中风险 │ 接受 │ 接受 │ 监控 ───┴───────────┴───────────┴─────────── 概率 → 低 中 高

````

## 3. 恢复动作库

### 自动恢复
```typescript
const AUTO_RECOVERY_ACTIONS = {
  // Token 相关
  TOKEN_EXHAUSTION: async (ctx) => {
    await ctx.promptEngine.autoReduce();
    return { retry: true };
  },

  // 工具相关
  TOOL_TIMEOUT: async (ctx, { toolName, attempt }) => {
    if (attempt < 3) {
      await sleep(1000 * attempt); // 指数退避
      return { retry: true };
    }
    return { escalate: true, reason: '工具持续超时' };
  },

  // 解析相关
  PARSE_ERROR: async (ctx, { output }) => {
    // 尝试修复 JSON
    const fixed = tryFixJSON(output);
    if (fixed) {
      return { retry: true, fixedOutput: fixed };
    }
    return { retry: true, hint: '请严格输出有效 JSON' };
  },

  // 循环相关
  DOOM_LOOP: async (ctx, { toolName, count }) => {
    return {
      abort: true,
      reason: `工具 ${toolName} 重复调用 ${count} 次`,
      suggestion: '请尝试不同的方法'
    };
  }
};
````

### 需审批恢复

```typescript
const APPROVAL_REQUIRED_ACTIONS = {
  // 高风险操作
  DESTRUCTIVE_OPERATION: {
    description: '即将执行破坏性操作',
    options: ['approve', 'deny', 'modify'],
    timeout: 300_000, // 5 分钟
    defaultOnTimeout: 'deny',
  },

  // 外部调用
  EXTERNAL_API_CALL: {
    description: '即将调用外部 API',
    options: ['approve', 'deny'],
    timeout: 60_000,
    defaultOnTimeout: 'deny',
  },

  // 重大决策
  MAJOR_DECISION: {
    description: '需要确认重大技术决策',
    options: ['approve', 'alternative', 'deny'],
    timeout: 600_000, // 10 分钟
    defaultOnTimeout: 'wait', // 继续等待
  },
};
```

## 4. Checkpoint 恢复

### 检查点类型

| 类型 | 触发时机   | 包含内容   |
| ---- | ---------- | ---------- |
| 阶段 | 阶段完成   | 完整状态   |
| 周期 | 每 10 分钟 | 增量状态   |
| 事件 | 关键操作前 | 上下文快照 |

### 恢复流程

```
1. 加载最近有效检查点
2. 验证检查点完整性
3. 恢复执行状态
4. 重建 Worker 上下文
5. 识别需重做的任务
6. 继续执行
```

## 5. 优雅降级

### 降级层级

| 层级 | 条件           | 措施         |
| ---- | -------------- | ------------ |
| L1   | 非关键功能失败 | 跳过并记录   |
| L2   | 并行失败       | 改为串行     |
| L3   | 自动化失败     | 生成手动指令 |
| L4   | 多次重试失败   | 升级给人类   |

### 降级示例

```typescript
async function executeWithDegradation(subtask: SubTask): Promise<Result> {
  // L0: 正常执行
  try {
    return await worker.execute(subtask);
  } catch (e) {
    log.warn('L0 失败，尝试 L1', e);
  }

  // L1: 简化执行
  try {
    return await worker.execute(subtask, { simplified: true });
  } catch (e) {
    log.warn('L1 失败，尝试 L2', e);
  }

  // L2: 分步执行
  try {
    const steps = await planner.breakDownFurther(subtask);
    return await executeStepsSerially(steps);
  } catch (e) {
    log.warn('L2 失败，尝试 L3', e);
  }

  // L3: 生成手动指令
  const manualInstructions = await generateManualInstructions(subtask);
  return {
    status: 'degraded',
    output: manualInstructions,
    requiresHumanAction: true,
  };
}
```

````

---

## 5. 技术实现方案

### 5.1 Skills 加载器扩展

**当前**: `SkillsLoader` 仅支持 Worker 加载

**目标**: 支持 Orchestrator/Planner 按需加载

```typescript
// skills/loader.ts - 扩展

export type SkillScope = 'worker' | 'orchestrator' | 'shared';

export interface SkillMetadata {
  name: string;
  description: string;
  triggers: string[];
  scope: SkillScope;  // 新增
}

export class SkillsLoader {
  // 新增: 按 scope 加载
  async loadByScope(scope: SkillScope): Promise<Skill[]> {
    const skillsDirs = [
      path.join(this.skillsRoot, scope),
      path.join(this.skillsRoot, 'shared')
    ];

    return this.loadFromDirs(skillsDirs);
  }

  // 新增: Planner 专用加载
  async loadForPlanner(objective: string): Promise<Skill[]> {
    return this.loadByTrigger(objective, { scope: 'orchestrator' });
  }
}
````

### 5.2 Planner 集成

```typescript
// planner/planner.ts - 扩展

export class Planner {
  private skillsLoader?: SkillsLoader;

  async plan(input: PlannerInput): Promise<PlanResult> {
    // 1. 加载规划相关技能
    const skills = await this.loadPlanningSkills(input.task.objective);

    // 2. 构建增强 prompt
    const prompt = this.buildPromptWithSkills(input, skills);

    // 3. 执行规划
    return this.executePlan(prompt);
  }

  private async loadPlanningSkills(objective: string): Promise<Skill[]> {
    if (!this.skillsLoader) return [];

    return this.skillsLoader.loadByTrigger(objective, {
      scope: 'orchestrator',
      categories: ['planning', 'delegation'],
    });
  }
}
```

### 5.3 Orchestrator 集成

```typescript
// orchestrator/orchestrator.ts - 扩展

export class Orchestrator {
  private skillsLoader?: SkillsLoader;

  async executeTask(task: Task): Promise<TaskResult> {
    // 加载监控和恢复技能
    const monitoringSkills = await this.loadSkillsByCategory('monitoring');
    const recoverySkills = await this.loadSkillsByCategory('recovery');

    // 注入到执行上下文
    const context = {
      ...this.baseContext,
      skills: { monitoring: monitoringSkills, recovery: recoverySkills },
    };

    return this.runWithSkills(task, context);
  }
}
```

### 5.4 配置扩展

```typescript
// config/orchestrator-config.ts

export interface OrchestratorSkillsConfig {
  /** 是否启用 Orchestrator Skills */
  enabled: boolean;

  /** Skills 目录 */
  skillsRoot: string;

  /** 默认加载的 Skills */
  defaultSkills: string[];

  /** 按阶段加载的 Skills */
  phaseSkills: {
    planning: string[];
    delegation: string[];
    monitoring: string[];
    recovery: string[];
  };
}
```

---

## 6. 实施路线图

### 6.1 Phase 1: Foundation (Week 1-2)

**目标**: 基础设施和核心技能

| 任务                                 | 优先级 | 预估工时 |
| ------------------------------------ | ------ | -------- |
| 扩展 SkillsLoader 支持 scope         | P0     | 4h       |
| 创建 `skills/orchestrator/` 目录结构 | P0     | 1h       |
| 实现 `task-decomposition` Skill      | P0     | 6h       |
| 实现 `project-archetypes` Skill      | P0     | 4h       |
| 集成到 Planner                       | P0     | 4h       |
| 编写单元测试                         | P1     | 4h       |

**交付物**:

- 支持 Orchestrator scope 的 SkillsLoader
- 2 个核心规划 Skills
- Planner 集成验证

### 6.2 Phase 2: Delegation (Week 3)

**目标**: Worker 委托策略

| 任务                      | 优先级 | 预估工时 |
| ------------------------- | ------ | -------- |
| 实现 `worker-roles` Skill | P0     | 4h       |
| 实现角色匹配算法          | P0     | 4h       |
| 集成到 WorkerManager      | P1     | 4h       |
| 编写集成测试              | P1     | 4h       |

**交付物**:

- Worker 角色定义 Skill
- 角色匹配集成

### 6.3 Phase 3: Context (Week 4)

**目标**: 上下文管理技能

| 任务                        | 优先级 | 预估工时 |
| --------------------------- | ------ | -------- |
| 实现 `context-budget` Skill | P0     | 6h       |
| 集成到 PromptEngine         | P0     | 4h       |
| 添加预算监控指标            | P1     | 3h       |
| 编写压力测试                | P1     | 3h       |

**交付物**:

- 上下文预算管理 Skill
- PromptEngine 增强

### 6.4 Phase 4: Monitoring & Recovery (Week 5-6)

**目标**: 监控和恢复能力

| 任务                             | 优先级 | 预估工时 |
| -------------------------------- | ------ | -------- |
| 实现 `progress-evaluation` Skill | P0     | 6h       |
| 实现 `risk-mitigation` Skill     | P0     | 6h       |
| 集成到 Orchestrator 主循环       | P0     | 8h       |
| 实现自动恢复动作                 | P1     | 6h       |
| 编写 E2E 测试                    | P1     | 4h       |

**交付物**:

- 完整的监控和恢复 Skills
- Orchestrator 增强

### 6.5 Milestone Summary

```
Week 1-2: 🏗️ Foundation
          ├── SkillsLoader 扩展
          └── 核心规划 Skills

Week 3:   🤝 Delegation
          └── Worker 角色分配

Week 4:   📊 Context
          └── 预算管理增强

Week 5-6: 🛡️ Monitoring & Recovery
          └── 完整的监控恢复体系
```

---

## 7. 评估指标

### 7.1 功能指标

| 指标           | 基线           | 目标  | 测量方法     |
| -------------- | -------------- | ----- | ------------ |
| 任务分解质量   | 人工评估 3.5/5 | 4.2/5 | LLM-as-Judge |
| 角色匹配准确率 | N/A            | > 85% | 人工验证     |
| 上下文利用率   | 80%            | > 95% | 自动监控     |
| 自动恢复成功率 | N/A            | > 70% | 执行统计     |

### 7.2 效率指标

| 指标             | 基线    | 目标      | 测量方法 |
| ---------------- | ------- | --------- | -------- |
| 规划 Token 消耗  | 5k/任务 | < 3k/任务 | 自动统计 |
| 重规划频率       | 20%     | < 10%     | 执行统计 |
| 子任务一次成功率 | 70%     | > 85%     | 执行统计 |
| 人工干预频率     | 30%     | < 15%     | 执行统计 |

### 7.3 质量指标

| 指标          | 基线 | 目标  | 测量方法 |
| ------------- | ---- | ----- | -------- |
| Skills 覆盖率 | 0%   | > 80% | 代码审计 |
| 测试覆盖率    | N/A  | > 70% | 自动测试 |
| 文档完整性    | N/A  | 100%  | 人工审计 |

---

## 附录

### A. 参考资料

1. [Anthropic - Building Effective AI Agents](https://docs.anthropic.com/en/docs/build-with-claude/building-effective-agents)
2. [Manus - Context Engineering](https://manus.ai/context-engineering)
3. [LangGraph - StateGraph](https://langchain-ai.github.io/langgraph/)
4. [CrewAI - Roles and Tasks](https://docs.crewai.com/)
5. [AutoGPT - Goal Decomposition](https://docs.agpt.co/)
6. [Agent Skills Specification](https://agentskills.io)

### B. 相关模块

- `packages/core/src/skills/` - Skills 系统
- `packages/core/src/planner/` - Planner 实现
- `packages/core/src/orchestrator/` - Orchestrator 实现
- `packages/core/src/prompt/` - 上下文工程

### C. 变更历史

| 版本 | 日期       | 作者           | 变更     |
| ---- | ---------- | -------------- | -------- |
| v1.0 | 2025-12-26 | Tachikoma Team | 初始版本 |

---

_如有问题或建议，请在项目 Issue 中提出。_

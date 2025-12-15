# Conversation Module

多轮对话系统，支持迭代对话、错误恢复和上下文持久化。

## 模块结构

```
conversation/
├── types.ts                   # 核心类型定义
├── session-store.ts           # 会话持久化存储
├── intent-analyzer.ts         # 用户意图分析
├── feedback-loop.ts           # 执行结果分析与决策
├── prompt-builder.ts          # Prompt 上下文构建
├── conversational-runner.ts   # 主执行器
└── index.ts                   # 模块导出
```

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    ConversationalRunner                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           SessionState (via SessionStore)                │   │
│  │  sessionId, messages[], checkpoints[], variables{}       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌──────────┐  ┌──────────┐  │  ┌──────────┐  ┌─────────────┐  │
│  │ Intent   │→ │ Planner/ │→ │→ │ Workers  │→ │   Result    │  │
│  │ Analyzer │  │ Orch     │  │  │          │  │ Aggregator  │  │
│  └──────────┘  └──────────┘  │  └──────────┘  └─────────────┘  │
│        ↑                     │                       │          │
│        │                     │                       ▼          │
│        │              ┌──────┴───────────────────────────┐     │
│        └──────────────│         FeedbackLoop             │     │
│                       │  - Error Classification          │     │
│                       │  - Auto-retry / Ask User / Replan│     │
│                       └──────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

## 核心组件

| 组件                     | 职责                                         |
| ------------------------ | -------------------------------------------- |
| **SessionStore**         | 持久化会话状态：消息历史、检查点、变量       |
| **IntentAnalyzer**       | 判断用户意图：新任务/继续/修改/撤销/查询     |
| **FeedbackLoop**         | 分析执行结果，决定：自动重试/请求澄清/重规划 |
| **PromptBuilder**        | 管理上下文窗口，压缩历史避免超限             |
| **ConversationalRunner** | 协调所有组件，处理多轮对话                   |

## 类型定义

### 用户意图

```typescript
enum UserIntent {
  NEW_TASK, // 全新任务
  CONTINUE, // 继续上一任务（如 "继续"）
  MODIFY, // 修改刚才的结果（如 "把颜色改成红色"）
  CLARIFY, // 回答 Agent 的问题
  UNDO, // 撤销操作
  QUERY, // 询问状态/进度
}
```

### 反馈动作

```typescript
enum FeedbackAction {
  AUTO_RETRY, // 自动重试（如网络错误）
  REPLAN, // 需要重新规划（如发现依赖问题）
  ASK_USER, // 需要用户澄清
  COMPLETE, // 任务完成
  PARTIAL_COMPLETE, // 部分完成，等待下一轮
}
```

### 会话状态

```typescript
interface SessionState {
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
  workDir: string;

  messages: ConversationMessage[];
  compressedHistory?: string;

  currentPlan?: { subtasks: SubTask[]; executionOrder: string[] };
  completedSubtasks: string[];
  pendingSubtasks: string[];

  checkpoints: Checkpoint[];
  variables: Record<string, unknown>;

  waitingForUser: boolean;
  pendingQuestion?: string;
}
```

## API 使用

```typescript
import { ConversationalRunner } from '@anthropic/tachikoma-core/conversation';

// 初始化
const runner = new ConversationalRunner({
  sessionDir: './.tachikoma/conversations',
  workDir: process.cwd(),
  llm: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
  },
});

// 创建会话
const session = await runner.createSession();

// 处理用户消息（流式输出）
for await (const event of runner.handleMessage(session.sessionId, '创建一个 React 项目')) {
  switch (event.type) {
    case 'thinking':
      console.log('💭', event.content);
      break;
    case 'tool_call':
      console.log('🔧', event.tool);
      break;
    case 'complete':
      console.log('✅', event.summary);
      break;
  }
}

// 继续对话
for await (const event of runner.handleMessage(session.sessionId, '把按钮颜色改成蓝色')) {
  // ...
}

// 撤销
for await (const event of runner.handleMessage(session.sessionId, '撤销')) {
  // ...
}

// 中断执行
await runner.interrupt(session.sessionId);
```

## 流式事件类型

| 事件类型           | 说明           |
| ------------------ | -------------- |
| `thinking`         | Agent 思考过程 |
| `tool_call`        | 工具调用请求   |
| `tool_result`      | 工具执行结果   |
| `subtask_complete` | 子任务完成     |
| `need_user_input`  | 需要用户输入   |
| `complete`         | 任务完成       |
| `error`            | 错误发生       |

## 特性

- ✅ **多轮迭代** - 用户可以说 "把按钮改大一点"
- ✅ **错误恢复** - Agent 可以请求澄清或自动重试
- ✅ **上下文保持** - 跨轮次记住变量和状态
- ✅ **可中断执行** - 用户可以随时打断并修改方向
- ✅ **检查点撤销** - 支持撤销到之前的检查点
- ✅ **历史压缩** - 长会话自动压缩避免 token 超限

## 与 Orchestrator 的关系

```
ConversationalRunner
├── SessionStore          (会话持久化)
├── IntentAnalyzer        (意图识别)
├── PromptBuilder         (上下文构建)
├── FeedbackLoop          (反馈分析)
└── Orchestrator          (任务执行)
    ├── Planner           (任务规划)
    └── WorkerPool        (Worker 池)
```

`ConversationalRunner` 是对话层的入口，内部调用 `Orchestrator` 来执行具体任务。

多轮对话架构设计,目前只是搭了架构,没有实现

┌─────────────────────────────────────────────────────────────────┐ │ ConversationSession │ │
┌─────────────────────────────────────────────────────────────┐│ │ │ sessionId, createdAt,
lastActiveAt ││ │ │ conversationHistory: Message[] ││ │ │ executionContext: { files, state,
checkpoints } ││ │ └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘ │ ▼
┌─────────────────────────────────────────────────────────────────┐ │ ConversationalRunner │ │ │ │
┌─────────┐ ┌──────────┐ ┌─────────┐ ┌─────────────┐ │ │ │ Intent │ → │ Planner/ │ → │ Workers │ → │
Result │ │ │ │ Analyzer│ │ Replanner│ │ │ │ Aggregator │ │ │ └─────────┘ └──────────┘ └─────────┘
└─────────────┘ │ │ ↑ │ │ │ │ ↑ │ │ │ │ │ │ │ │ │ ┌─────────┴──────────────────────────────┤ │ │ │ │
▼ │ │ │ │ ┌─────────────────────────────────────────┐ │ │ │ │ │ FeedbackLoop │ │ │ │ │ │ - Execution
Result Analysis │ │ │ │ │ │ - Error Classification │ │ │ │ │ │ - Auto-retry vs User Clarification │
│ │ │ │ └─────────────────────────────────────────┘ │ │ │ │ │ │ │ └────┴─────────────────────┘ │ │ │
└─────────────────────────────────────────────────────────────────┘

核心组件组件 职责 ConversationSession 持久化会话状态：历史消息、执行上下文、检查点 IntentAnalyzer 判断用户意图：新任务 / 继续上一任务 / 修改 / 问答 Replanner 基于执行结果和用户反馈重新规划 FeedbackLoop 分析执行结果，决定：自动重试 / 请求澄清 / 完成 ContextManager 管理上下文窗口，压缩历史避免超限关键设计决策 typescript
// 意图类型 enum UserIntent { NEW_TASK, // 全新任务 CONTINUE, // 继续上一任务（如 "继续"）MODIFY,
// 修改刚才的结果（如 "把颜色改成红色"）CLARIFY, // 回答 Agent 的问题 UNDO, // 撤销操作 QUERY,
// 询问状态/进度 } // 执行结果处理 enum FeedbackAction { AUTO_RETRY,
// 自动重试（如网络错误）REPLAN, // 需要重新规划（如发现依赖问题）ASK_USER,
// 需要用户澄清 COMPLETE, // 任务完成 PARTIAL_COMPLETE,
// 部分完成，等待下一轮 } 状态持久化 typescript interface SessionState { // 会话元数据 sessionId:
string; createdAt: number; lastActiveAt: number;

// 对话历史（压缩后）conversationHistory: CompressedMessage[];

// 当前执行状态 currentPlan?: Plan; completedSubtasks: string[]; pendingSubtasks: string[];

// 文件系统快照（用于 undo）checkpoints: Checkpoint[];

// 上下文变量（跨轮次共享）variables: Record<string, unknown>; } API 设计 typescript class
ConversationalRunner { // 处理用户输入（核心入口）async handleMessage( sessionId: string,
userMessage: string ): AsyncGenerator<StreamEvent>;

// 恢复会话 async resumeSession(sessionId: string): Promise<SessionState>;

// 撤销到检查点 async undoToCheckpoint( sessionId: string, checkpointId: string ): Promise<void>;

// 流式中断 async interrupt(sessionId: string): Promise<void>; } 与现有架构的关系现有: MVPRunner
(一次性)

扩展后: ConversationalRunner ├── SessionManager (新增) ├── IntentAnalyzer (新增) ├── Planner (复用)
├── WorkerExecutor (复用) ├── FeedbackLoop (新增) └── ContextCompressor (新增) 这个架构允许：

多轮迭代 - 用户可以说"把按钮改大一点" 错误恢复 -
Agent 可以请求澄清或自动重试上下文保持 - 跨轮次记住变量和状态可中断执行 - 用户可以随时打断并修改方向

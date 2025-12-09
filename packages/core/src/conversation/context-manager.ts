/**
 * Context Manager
 *
 * 管理对话上下文，压缩历史避免超限
 */

import type { SessionState, ConversationMessage } from './types';

// =============================================================================
// 常量
// =============================================================================

const DEFAULT_MAX_MESSAGES = 20;
const SUMMARY_THRESHOLD = 10;

// =============================================================================
// ContextManager 类
// =============================================================================

/**
 * 上下文管理器
 */
export class ContextManager {
  private readonly maxMessages: number;

  constructor(options: { maxMessages?: number } = {}) {
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  }

  /**
   * 构建 LLM 上下文
   */
  buildContext(session: SessionState): string {
    const parts: string[] = [];

    // 1. 系统上下文
    parts.push('## 会话上下文\n');
    parts.push(`工作目录: ${session.workDir}`);
    parts.push(`会话时长: ${this.formatDuration(Date.now() - session.createdAt)}`);

    // 2. 变量上下文
    if (Object.keys(session.variables).length > 0) {
      parts.push('\n## 共享变量');
      for (const [key, value] of Object.entries(session.variables)) {
        parts.push(`- ${key}: ${JSON.stringify(value)}`);
      }
    }

    // 3. 当前计划状态
    if (session.currentPlan) {
      parts.push('\n## 当前计划');
      parts.push(`总子任务: ${session.currentPlan.subtasks.length}`);
      parts.push(`已完成: ${session.completedSubtasks.length}`);
      parts.push(`待执行: ${session.pendingSubtasks.length}`);
    }

    // 4. 压缩的历史摘要
    if (session.compressedHistory) {
      parts.push('\n## 历史摘要');
      parts.push(session.compressedHistory);
    }

    // 5. 最近的对话
    const recentMessages = this.getRecentMessages(session);
    if (recentMessages.length > 0) {
      parts.push('\n## 最近对话');
      for (const msg of recentMessages) {
        const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? 'Agent' : '系统';
        parts.push(`[${role}] ${msg.content.substring(0, 200)}${msg.content.length > 200 ? '...' : ''}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * 获取最近的消息
   */
  getRecentMessages(session: SessionState): ConversationMessage[] {
    const messages = session.messages;
    if (messages.length <= this.maxMessages) {
      return messages;
    }
    return messages.slice(-this.maxMessages);
  }

  /**
   * 检查是否需要压缩历史
   */
  needsCompression(session: SessionState): boolean {
    return session.messages.length > this.maxMessages;
  }

  /**
   * 压缩历史消息
   *
   * 注意：实际压缩需要 LLM 来生成摘要，这里只做结构处理
   */
  async compressHistory(
    session: SessionState,
    summarizer: (messages: ConversationMessage[]) => Promise<string>
  ): Promise<SessionState> {
    if (!this.needsCompression(session)) {
      return session;
    }

    // 保留最近的消息
    const recentMessages = session.messages.slice(-SUMMARY_THRESHOLD);
    const oldMessages = session.messages.slice(0, -SUMMARY_THRESHOLD);

    // 使用 LLM 生成摘要
    const summary = await summarizer(oldMessages);

    // 更新会话
    return {
      ...session,
      messages: recentMessages,
      compressedHistory: session.compressedHistory
        ? `${session.compressedHistory}\n\n${summary}`
        : summary,
    };
  }

  /**
   * 提取关键变量
   */
  extractVariables(
    messages: ConversationMessage[]
  ): Record<string, unknown> {
    const variables: Record<string, unknown> = {};

    for (const msg of messages) {
      // 从执行摘要中提取文件信息
      if (msg.executionSummary?.filesAffected) {
        variables.lastFilesAffected = msg.executionSummary.filesAffected;
      }
    }

    return variables;
  }

  /**
   * 格式化持续时间
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}小时${minutes % 60}分钟`;
    }
    if (minutes > 0) {
      return `${minutes}分钟`;
    }
    return `${seconds}秒`;
  }

  /**
   * 构建继续执行的提示
   */
  buildContinuePrompt(session: SessionState): string {
    if (session.pendingSubtasks.length === 0) {
      return '没有待执行的任务。';
    }

    const nextSubtaskId = session.pendingSubtasks[0];
    const nextSubtask = session.currentPlan?.subtasks.find(
      (s) => s.id === nextSubtaskId
    );

    if (!nextSubtask) {
      return '无法找到下一个子任务。';
    }

    return `继续执行任务。\n\n下一个子任务: ${nextSubtask.objective}`;
  }

  /**
   * 构建修改任务的提示
   */
  buildModifyPrompt(
    session: SessionState,
    target: string | undefined,
    newValue: string | undefined
  ): string {
    const parts: string[] = ['用户请求修改:'];

    if (target && newValue) {
      parts.push(`把 "${target}" 改成 "${newValue}"`);
    } else {
      parts.push('请根据用户的修改请求调整之前的工作。');
    }

    // 添加受影响文件的上下文
    const lastFiles = session.variables.lastFilesAffected;
    if (Array.isArray(lastFiles) && lastFiles.length > 0) {
      parts.push(`\n最近修改的文件: ${lastFiles.join(', ')}`);
    }

    return parts.join('\n');
  }
}

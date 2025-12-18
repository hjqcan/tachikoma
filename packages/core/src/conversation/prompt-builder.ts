/**
 * Conversation Prompt Builder
 *
 * Builds LLM prompt context for ConversationalRunner and compresses history to avoid overruns.
 */

import type { SessionState, ConversationMessage } from './types';

// =============================================================================
// 常量
// =============================================================================

const DEFAULT_MAX_MESSAGES = 20;
const SUMMARY_THRESHOLD = 10;

// =============================================================================
// PromptBuilder 类
// =============================================================================

/**
 * 会话 Prompt 构建器
 *
 * Used by ConversationalRunner to manage multi-turn conversation context.
 * Note: This is a prompt string builder, not the public ConversationContextManager interface.
 */
export class ConversationPromptBuilder {
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
    parts.push('## Session Context\n');
    parts.push(`Working directory: ${session.workDir}`);
    parts.push(`Session duration: ${this.formatDuration(Date.now() - session.createdAt)}`);

    // 2. 变量上下文（包含上次任务目标和错误信息）
    if (Object.keys(session.variables).length > 0) {
      parts.push('\n## Shared Variables');
      // 优先显示重要变量
      if (session.variables.lastObjective) {
        parts.push(`- Last objective: ${session.variables.lastObjective}`);
      }
      if (session.variables.lastRunError) {
        parts.push(`- Last run error: ${session.variables.lastRunError}`);
      }
      // 其他变量
      for (const [key, value] of Object.entries(session.variables)) {
        if (key !== 'lastObjective' && key !== 'lastRunError' && key !== 'lastFilesAffected') {
          parts.push(`- ${key}: ${JSON.stringify(value)}`);
        }
      }
    }

    // 3. 当前计划状态（包含具体子任务信息）
    if (session.currentPlan) {
      parts.push('\n## Current Plan');
      parts.push(`Total subtasks: ${session.currentPlan.subtasks.length}`);
      parts.push(`Completed: ${session.completedSubtasks.length}`);
      parts.push(`Pending: ${session.pendingSubtasks.length}`);
      
      // 显示已完成的子任务（让 LLM 知道之前做了什么）
      const completedSubtasks = session.currentPlan.subtasks.filter(
        st => session.completedSubtasks.includes(st.id)
      );
      if (completedSubtasks.length > 0) {
        parts.push('\nCompleted subtasks:');
        for (const st of completedSubtasks.slice(-5)) { // 最近 5 个
          parts.push(`  - ${st.objective} (${st.status})`);
        }
        if (completedSubtasks.length > 5) {
          parts.push(`  ... and ${completedSubtasks.length - 5} more`);
        }
      }

      // 显示失败的子任务
      const failedSubtasks = session.currentPlan.subtasks.filter(
        st => st.status === 'failure'
      );
      if (failedSubtasks.length > 0) {
        parts.push('\nFailed subtasks:');
        for (const st of failedSubtasks.slice(-3)) {
          parts.push(`  - ${st.objective}`);
        }
      }
    }

    // 4. 之前创建/修改的文件（非常重要）
    if (Array.isArray(session.variables.lastFilesAffected) && session.variables.lastFilesAffected.length > 0) {
      const files = session.variables.lastFilesAffected as string[];
      parts.push('\n## Recently Created/Modified Files');
      for (const file of files.slice(-15)) { // 最近 15 个文件
        parts.push(`  - ${file}`);
      }
      if (files.length > 15) {
        parts.push(`  ... and ${files.length - 15} more`);
      }
    }

    // 5. 压缩的历史摘要
    if (session.compressedHistory) {
      parts.push('\n## History Summary');
      parts.push(session.compressedHistory);
    }

    // 6. 最近的对话
    const recentMessages = this.getRecentMessages(session);
    if (recentMessages.length > 0) {
      parts.push('\n## Recent Conversation');
      for (const msg of recentMessages) {
        const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
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
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }
    return `${seconds}s`;
  }

  /**
   * 构建继续执行的提示
   */
  buildContinuePrompt(session: SessionState): string {
    if (session.pendingSubtasks.length === 0) {
      return 'No pending tasks.';
    }

    const nextSubtaskId = session.pendingSubtasks[0];
    const nextSubtask = session.currentPlan?.subtasks.find(
      (s) => s.id === nextSubtaskId
    );

    if (!nextSubtask) {
      return 'Unable to find the next subtask.';
    }

    return `Continue execution.\n\nNext subtask: ${nextSubtask.objective}`;
  }

  /**
   * 构建修改任务的提示
   */
  buildModifyPrompt(
    session: SessionState,
    target: string | undefined,
    newValue: string | undefined
  ): string {
    const parts: string[] = ['User requested changes:'];

    if (target && newValue) {
      parts.push(`Change "${target}" to "${newValue}"`);
    } else {
      parts.push('Please adjust the previous work based on the user request.');
    }

    // 添加受影响文件的上下文
    const lastFiles = session.variables.lastFilesAffected;
    if (Array.isArray(lastFiles) && lastFiles.length > 0) {
      parts.push(`\nRecently modified files: ${lastFiles.join(', ')}`);
    }

    return parts.join('\n');
  }
}

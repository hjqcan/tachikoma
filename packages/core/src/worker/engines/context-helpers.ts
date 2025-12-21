/**
 * Context Helper Functions
 *
 * 上下文消息创建和转换工具函数
 * 用于 LLM 对话上下文管理
 */

import type { ContextMessage } from '../../prompt';

// ============================================================================
// 消息 ID 生成器
// ============================================================================

let messageIdCounter = 0;

/**
 * 重置消息 ID 计数器（用于测试）
 */
export function resetMessageIdCounter(): void {
  messageIdCounter = 0;
}

// ============================================================================
// 消息创建函数
// ============================================================================

/**
 * 创建用户消息
 */
export function createUserMessage(content: string): ContextMessage {
  return {
    id: `user-${++messageIdCounter}`,
    role: 'user',
    content,
    timestamp: Date.now(),
    format: 'full',
  };
}

/**
 * 创建助手消息
 */
export function createAssistantMessage(content: string): ContextMessage {
  return {
    id: `assistant-${++messageIdCounter}`,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    format: 'full',
  };
}

/**
 * 创建工具结果消息
 */
export function createToolMessage(toolCallId: string, result: string): ContextMessage {
  return {
    id: `tool-${++messageIdCounter}`,
    role: 'tool',
    content: result,
    timestamp: Date.now(),
    format: 'full',
    toolResult: {
      callId: toolCallId,
      output: result,
      success: true,
    },
  };
}

/**
 * 创建系统消息（用于上下文注入）
 */
export function createSystemMessage(content: string, id?: string): ContextMessage {
  return {
    id: id ?? `system-${++messageIdCounter}`,
    role: 'system',
    content,
    timestamp: Date.now(),
    format: 'full',
  };
}

// ============================================================================
// 消息转换函数
// ============================================================================

/**
 * LLM 消息格式
 */
export interface LLMMessageFormat {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 将上下文消息转换为 LLM 可接受的格式
 * 
 * 注意：system 消息（如摘要、状态提醒）转换为 user 消息注入，
 * 以保留压缩后的上下文信息
 */
export function contextToLLMMessages(context: ContextMessage[]): LLMMessageFormat[] {
  const result: LLMMessageFormat[] = [];

  for (const msg of context) {
    if (msg.role === 'tool') {
      result.push({
        role: 'user',
        content: `Tool result: ${msg.content}`,
      });
    } else if (msg.role === 'system') {
      // System 消息（摘要、状态提醒等）转换为 user 消息注入
      result.push({
        role: 'user',
        content: `[System Context]\n${msg.content}`,
      });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  return result;
}

/**
 * 过滤上下文消息，只保留 user 和 assistant 角色
 */
export function filterUserAssistantMessages(context: ContextMessage[]): ContextMessage[] {
  return context.filter(msg => msg.role === 'user' || msg.role === 'assistant');
}

/**
 * 计算消息内容的大致 token 数（简单估算）
 * 
 * 使用简单的字符数估算：~4 字符 = 1 token
 */
export function estimateMessageTokens(message: ContextMessage): number {
  return Math.ceil(message.content.length / 4);
}

/**
 * 计算消息列表的总 token 数
 */
export function estimateTotalTokens(messages: ContextMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

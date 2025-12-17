/**
 * 卸载策略实现
 *
 * 将大内容卸载到文件系统，保留引用标识符
 *
 * 核心原则（来自 Manus）：
 * "文件系统是终极上下文：大小不受限制，天然持久化，并且代理可以直接操作"
 *
 * @module context/strategies/offload
 */

import type {
  ContextMessage,
  OffloadConfig,
  OffloadResult,
} from '../types';
import type { LanguageCode } from '../language';

// ============================================================================
// 卸载策略
// ============================================================================

/**
 * 文件管理器接口
 */
export interface OffloadFileManager {
  /**
   * 写入文件
   */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * 读取文件
   */
  readFile(path: string): Promise<string>;

  /**
   * 检查文件是否存在
   */
  exists(path: string): Promise<boolean>;
}

/**
 * 卸载策略
 *
 * 将大内容卸载到文件系统，在上下文中保留引用
 */
export class OffloadStrategy {
  private readonly config: OffloadConfig;

  constructor(config: OffloadConfig) {
    this.config = config;
  }

  /**
   * 卸载消息内容到文件
   */
  async offload(
    messages: ContextMessage[],
    fileManager: OffloadFileManager,
    estimateTokens: (content: string) => number,
    language: LanguageCode = 'zh'
  ): Promise<OffloadResult> {
    const messageIds: string[] = [];
    const filePaths: string[] = [];
    let savedTokens = 0;

    for (const message of messages) {
      // 跳过已经是紧凑格式的消息
      if (message.format === 'compact') {
        continue;
      }

      // 检查是否超过阈值
      const tokens = estimateTokens(message.content);
      if (tokens < this.config.tokenThreshold) {
        continue;
      }

      // 生成文件路径
      const filePath = this.generateFilePath(message);

      // 写入文件
      const content = this.serializeForOffload(message);
      await fileManager.writeFile(filePath, content);

      // 更新消息
      const originalContent = message.content;
      message.fullContent = originalContent;
      message.content = this.createPlaceholder(message, filePath, language);
      message.format = 'compact';
      message.recoveryRef = `file://${filePath}`;

      messageIds.push(message.id);
      filePaths.push(filePath);
      savedTokens += tokens - estimateTokens(message.content);
    }

    return {
      success: true,
      messageIds,
      filePaths,
      savedTokens,
    };
  }

  /**
   * 从文件恢复消息内容
   */
  async recover(
    message: ContextMessage,
    fileManager: OffloadFileManager
  ): Promise<ContextMessage> {
    if (message.format !== 'compact' || !message.recoveryRef) {
      return message;
    }

    // 检查是否是文件引用
    if (!message.recoveryRef.startsWith('file://')) {
      // 如果有 fullContent，直接恢复
      if (message.fullContent) {
        return {
          ...message,
          content: message.fullContent,
          format: 'full',
        };
      }
      return message;
    }

    // 从文件恢复
    const filePath = message.recoveryRef.slice(7); // 移除 "file://"
    const exists = await fileManager.exists(filePath);

    if (!exists) {
      // 文件不存在，尝试使用 fullContent
      if (message.fullContent) {
        return {
          ...message,
          content: message.fullContent,
          format: 'full',
        };
      }
      return message;
    }

    const content = await fileManager.readFile(filePath);
    const recovered = this.deserializeFromOffload(content);

    return {
      ...message,
      content: recovered.content,
      format: 'full',
    };
  }

  /**
   * 批量卸载上下文快照
   */
  async offloadSnapshot(
    messages: ContextMessage[],
    fileManager: OffloadFileManager,
    label?: string
  ): Promise<string> {
    const timestamp = Date.now();
    const fileName = label
      ? `context_snapshot_${label}_${timestamp}.${this.config.fileFormat}`
      : `context_snapshot_${timestamp}.${this.config.fileFormat}`;

    const filePath = `${this.config.workDir}/${fileName}`;

    let content: string;
    if (this.config.fileFormat === 'jsonl') {
      content = messages
        .map((m) => JSON.stringify(this.serializeMessage(m)))
        .join('\n');
    } else if (this.config.fileFormat === 'json') {
      content = JSON.stringify(messages.map((m) => this.serializeMessage(m)), null, 2);
    } else {
      content = messages
        .map((m) => `[${m.role}] ${m.content}`)
        .join('\n\n---\n\n');
    }

    await fileManager.writeFile(filePath, content);
    return filePath;
  }

  // ========================================
  // 私有方法
  // ========================================

  private generateFilePath(message: ContextMessage): string {
    const timestamp = Date.now();
    const ext = this.config.fileFormat;
    return `${this.config.workDir}/offload_${message.id}_${timestamp}.${ext}`;
  }

  private serializeForOffload(message: ContextMessage): string {
    const data = this.serializeMessage(message);

    if (this.config.fileFormat === 'json') {
      return JSON.stringify(data, null, 2);
    } else if (this.config.fileFormat === 'jsonl') {
      return JSON.stringify(data);
    } else {
      return `[${message.role}]\n${message.content}`;
    }
  }

  private serializeMessage(message: ContextMessage): Record<string, unknown> {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      toolCall: message.toolCall,
      toolResult: message.toolResult,
    };
  }

  private deserializeFromOffload(content: string): { content: string } {
    try {
      const data = JSON.parse(content) as { content?: string };
      return { content: data.content || content };
    } catch {
      // 纯文本格式
      return { content };
    }
  }

  private createPlaceholder(
    message: ContextMessage,
    filePath: string,
    language: LanguageCode
  ): string {
    const roleLabel = this.getRoleLabel(message.role, language);
    if (language === 'en') {
      return `[${roleLabel} content offloaded to: ${filePath}]`;
    }
    return `[${roleLabel}内容已卸载到文件: ${filePath}]`;
  }

  private getRoleLabel(role: string, language: LanguageCode): string {
    switch (role) {
      case 'user':
        return language === 'en' ? 'User message' : '用户消息';
      case 'assistant':
        return language === 'en' ? 'Assistant response' : '助手响应';
      case 'tool':
        return language === 'en' ? 'Tool result' : '工具结果';
      case 'system':
        return language === 'en' ? 'System message' : '系统消息';
      default:
        return language === 'en' ? 'Message' : '消息';
    }
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建卸载策略
 */
export function createOffloadStrategy(config: OffloadConfig): OffloadStrategy {
  return new OffloadStrategy(config);
}

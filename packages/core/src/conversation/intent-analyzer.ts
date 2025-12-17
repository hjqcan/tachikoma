/**
 * Intent Analyzer
 *
 * 分析用户消息，识别意图类型
 */

import { UserIntent, type IntentAnalysisResult, type SessionState } from './types';

// =============================================================================
// 意图模式匹配
// =============================================================================

/**
 * 意图模式定义
 */
interface IntentPattern {
  intent: UserIntent;
  patterns: RegExp[];
  keywords: string[];
}

/**
 * 中文意图模式
 */
const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: UserIntent.CONTINUE,
    patterns: [
      /^继续$/,
      /^接着$/,
      /^然后呢/,
      /^下一步/,
      /^go on/i,
      /^continue/i,
    ],
    keywords: ['继续', '接着', '然后', '下一步', 'continue', 'go on', 'next'],
  },
  {
    intent: UserIntent.MODIFY,
    patterns: [
      /改(成|为|一下)/,
      /换(成|为)/,
      /修改/,
      /调整/,
      /把.*改/,
      /change.*to/i,
      /modify/i,
      /update/i,
    ],
    keywords: ['改成', '改为', '换成', '修改', '调整', '更新', 'change', 'modify', 'update'],
  },
  {
    intent: UserIntent.UNDO,
    patterns: [
      /^撤销(?:\s*\d+\s*步)?/,
      /^回退(?:\s*\d+\s*步)?/,
      /^回滚(?:\s*\d+\s*步)?/,
      /^还原(?:\s*(?:一下|\d+\s*步|到|回|上一步|上次|之前|检查点))/,
      /^恢复(?:\s*(?:到|上一步|上次|之前|检查点))/,
      /^undo/i,
      /^rollback/i,
      /^revert/i,
    ],
    keywords: ['撤销', '回退', '回滚', '撤销到', '回滚到', '恢复到', 'undo', 'rollback', 'revert'],
  },
  {
    intent: UserIntent.QUERY,
    patterns: [
      /^(现在|目前|当前).*(状态|进度|情况)/,
      /^(什么|哪些|多少)/,
      /^(做完|完成)了(吗|没)/,
      /^status/i,
      /^what('s| is)/i,
      /^how (many|much)/i,
    ],
    keywords: ['状态', '进度', '情况', '做了什么', 'status', 'progress', 'what'],
  },
];

// =============================================================================
// IntentAnalyzer 类
// =============================================================================

/**
 * 意图分析器
 */
export class IntentAnalyzer {
  /**
   * 分析用户消息意图
   */
  analyze(message: string, session?: SessionState): IntentAnalysisResult {
    const trimmedMessage = message.trim();

    const isAsciiKeyword = (s: string): boolean => {
      // ASCII keyword: apply word-boundary-like checks to avoid matching inside identifiers (e.g. SkipNext)
      return /^[\x00-\x7F]+$/.test(s) && /[a-z0-9]/i.test(s);
    };
    const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. 如果 Agent 在等待用户回答问题，这是一个 CLARIFY
    if (session?.waitingForUser && session.pendingQuestion) {
      return {
        intent: UserIntent.CLARIFY,
        confidence: 0.9,
        entities: { answer: trimmedMessage },
        originalMessage: message,
      };
    }

    // 2. 尝试模式匹配
    for (const pattern of INTENT_PATTERNS) {
      // 正则匹配
      for (const regex of pattern.patterns) {
        if (regex.test(trimmedMessage)) {
          return {
            intent: pattern.intent,
            confidence: 0.85,
            entities: this.extractEntities(trimmedMessage, pattern.intent),
            originalMessage: message,
          };
        }
      }

      // 关键词匹配：
      // - 对于英文关键词：使用“非标识符边界”避免 SkipNext 误匹配 next
      // - 对于中文关键词：保持 includes 行为（中文没有 ASCII 词边界概念）
      for (const keyword of pattern.keywords) {
        const haystack = trimmedMessage.toLowerCase();
        const needle = keyword.toLowerCase();
        // 对于 UNDO，检查开头；对于其他意图，英文用边界正则，中文用 includes
        let matched: boolean;
        if (pattern.intent === UserIntent.UNDO) {
          matched = haystack.startsWith(needle);
        } else if (isAsciiKeyword(needle)) {
          // 非标识符边界：避免 "SkipNext" 触发 next，但允许 "next step" / "go on" 等自然语言
          const boundaryRegex = new RegExp(
            `(?:^|[^A-Za-z0-9_])${escapeRegex(needle)}(?:$|[^A-Za-z0-9_])`,
            'i'
          );
          matched = boundaryRegex.test(trimmedMessage);
        } else {
          matched = haystack.includes(needle);
        }
        if (matched) {
          return {
            intent: pattern.intent,
            confidence: 0.7,
            entities: this.extractEntities(trimmedMessage, pattern.intent),
            originalMessage: message,
          };
        }
      }
    }

    // 3. 如果有当前计划且消息较短，可能是继续
    if (session?.currentPlan && session.pendingSubtasks.length > 0) {
      if (trimmedMessage.length < 10 && /^(好|ok|是|对|嗯)/i.test(trimmedMessage)) {
        return {
          intent: UserIntent.CONTINUE,
          confidence: 0.6,
          entities: {},
          originalMessage: message,
        };
      }
    }

    // 4. 默认为新任务
    return {
      intent: UserIntent.NEW_TASK,
      confidence: 0.8,
      entities: { task: trimmedMessage },
      originalMessage: message,
    };
  }

  /**
   * 提取实体
   */
  private extractEntities(
    message: string,
    intent: UserIntent
  ): Record<string, unknown> {
    const entities: Record<string, unknown> = {};

    switch (intent) {
      case UserIntent.MODIFY: {
        // 尝试提取 "把 X 改成 Y" 模式
        const modifyMatch = message.match(/把(.+?)(改|换)(成|为)(.+)/);
        if (modifyMatch) {
          entities.target = modifyMatch[1]?.trim();
          entities.newValue = modifyMatch[4]?.trim();
        }
        break;
      }

      case UserIntent.UNDO: {
        // 尝试提取要撤销的步数
        const undoMatch = message.match(/(?:撤销|回退|回滚|还原)\s*(\d+)\s*步/);
        if (undoMatch) {
          entities.steps = parseInt(undoMatch[1] ?? '1', 10);
        } else {
          entities.steps = 1;
        }
        break;
      }

      default:
        break;
    }

    return entities;
  }

  /**
   * 判断是否需要更多上下文来确定意图
   */
  needsMoreContext(result: IntentAnalysisResult): boolean {
    return result.confidence < 0.6;
  }
}

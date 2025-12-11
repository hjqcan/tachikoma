/**
 * Feedback Loop
 *
 * 分析执行结果，决定下一步动作
 */

import {
  FeedbackAction,
  type FeedbackAnalysisResult,
  type ExecutionSummary,
  type SessionState,
} from './types';

// =============================================================================
// 错误分类
// =============================================================================

/**
 * 可重试的错误模式
 */
const RETRYABLE_ERRORS = [
  /timeout/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /network/i,
  /rate.?limit/i,
  /429/,
  /503/,
  /temporarily unavailable/i,
];

/**
 * 需要用户澄清的错误模式
 */
const CLARIFICATION_ERRORS = [
  /permission denied/i,
  /access denied/i,
  /not found/i,
  /ambiguous/i,
  /unclear/i,
  /which one/i,
  /multiple options/i,
];

/**
 * 需要重新规划的错误模式
 */
const REPLAN_ERRORS = [
  /dependency.*(missing|not found)/i,
  /module.*(not found|missing)/i,
  /cannot resolve/i,
  /incompatible/i,
  /conflict/i,
  /prerequisite/i,
];

// =============================================================================
// FeedbackLoop 类
// =============================================================================

/**
 * 反馈循环分析器
 */
export class FeedbackLoop {
  private readonly maxRetries: number;
  private retryCountMap = new Map<string, number>();

  constructor(options: { maxRetries?: number } = {}) {
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * 分析执行结果，决定下一步动作
   */
  analyze(
    execution: ExecutionSummary,
    session: SessionState
  ): FeedbackAnalysisResult {
    // 1. 完全成功
    if (execution.success && execution.subtasksFailed === 0) {
      // 检查是否还有待执行的子任务
      if (session.pendingSubtasks.length > 0) {
        return {
          action: FeedbackAction.PARTIAL_COMPLETE,
          reason: `已完成 ${execution.subtasksCompleted} 个子任务，还有 ${session.pendingSubtasks.length} 个待执行`,
        };
      }

      return {
        action: FeedbackAction.COMPLETE,
        reason: '所有任务已成功完成',
      };
    }

    // 2. 有错误，分析错误类型
    if (execution.error) {
      return this.analyzeError(execution.error, session);
    }

    // 3. 部分失败
    if (execution.subtasksFailed > 0) {
      // 如果大部分成功，可能是可接受的
      const successRate =
        execution.subtasksCompleted /
        (execution.subtasksCompleted + execution.subtasksFailed);

      if (successRate > 0.7) {
        return {
          action: FeedbackAction.ASK_USER,
          reason: `${execution.subtasksFailed} 个子任务失败，成功率 ${Math.round(successRate * 100)}%`,
          question: `有 ${execution.subtasksFailed} 个子任务执行失败。要重试失败的任务，还是继续其他工作？`,
        };
      }

      return {
        action: FeedbackAction.REPLAN,
        reason: '多个子任务失败，需要重新规划',
        replanSuggestion: '考虑简化任务或分解为更小的步骤',
      };
    }

    // 4. 默认：完成
    return {
      action: FeedbackAction.COMPLETE,
      reason: '执行已完成',
    };
  }

  /**
   * 分析错误并决定动作
   */
  private analyzeError(
    error: string,
    session: SessionState
  ): FeedbackAnalysisResult {
    // 检查是否可重试
    if (this.isRetryable(error)) {
      const retryKey = `${session.sessionId}:${error.substring(0, 50)}`;
      const currentRetries = this.retryCountMap.get(retryKey) ?? 0;

      if (currentRetries < this.maxRetries) {
        this.retryCountMap.set(retryKey, currentRetries + 1);
        return {
          action: FeedbackAction.AUTO_RETRY,
          reason: `可重试错误: ${error}`,
          retryCount: currentRetries + 1,
        };
      }
    }

    // 检查是否需要用户澄清
    if (this.needsClarification(error)) {
      return {
        action: FeedbackAction.ASK_USER,
        reason: `需要澄清: ${error}`,
        question: this.generateClarificationQuestion(error),
      };
    }

    // 检查是否需要重新规划
    if (this.needsReplan(error)) {
      return {
        action: FeedbackAction.REPLAN,
        reason: `需要调整计划: ${error}`,
        replanSuggestion: this.generateReplanSuggestion(error),
      };
    }

    // 默认：询问用户
    return {
      action: FeedbackAction.ASK_USER,
      reason: `未知错误: ${error}`,
      question: `执行遇到问题: ${error}\n\n要如何处理？`,
    };
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryable(error: string): boolean {
    return RETRYABLE_ERRORS.some((pattern) => pattern.test(error));
  }

  /**
   * 判断是否需要用户澄清
   */
  private needsClarification(error: string): boolean {
    return CLARIFICATION_ERRORS.some((pattern) => pattern.test(error));
  }

  /**
   * 判断是否需要重新规划
   */
  private needsReplan(error: string): boolean {
    return REPLAN_ERRORS.some((pattern) => pattern.test(error));
  }

  /**
   * 生成澄清问题
   */
  private generateClarificationQuestion(error: string): string {
    if (/permission denied/i.test(error)) {
      return '没有执行权限。是否需要使用管理员权限，或者选择其他操作？';
    }
    if (/not found/i.test(error)) {
      return '找不到指定的资源。请确认名称/路径是否正确？';
    }
    if (/ambiguous/i.test(error) || /multiple options/i.test(error)) {
      return '有多个匹配项。请指定具体要操作哪一个？';
    }
    return `遇到问题: ${error}\n请提供更多信息帮助解决。`;
  }

  /**
   * 生成重新规划建议
   */
  private generateReplanSuggestion(error: string): string {
    if (/dependency/i.test(error) || /module/i.test(error)) {
      return '先安装必要的依赖，然后再执行主任务';
    }
    if (/conflict/i.test(error)) {
      return '解决冲突后再继续，可能需要更新版本或调整配置';
    }
    return '简化任务目标，分步骤完成';
  }

  /**
   * 重置重试计数
   */
  resetRetryCount(sessionId: string): void {
    for (const key of this.retryCountMap.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.retryCountMap.delete(key);
      }
    }
  }
}

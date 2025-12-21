/**
 * Progress Tracker
 *
 * 追踪 Agent 执行进度，检测死循环和无进展状态。
 * 当连续多轮没有实质进展时，触发策略降级。
 *
 * 检测能力：
 * 1. 工具名称频率检测 - 连续调用同一工具
 * 2. 失败模式检测 - 相同的工具输出模式重复
 * 3. 相似轮次检测 - 多轮调用相同类型的工具组合
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 单轮执行进度
 */
export interface RoundProgress {
  round: number;
  stopReason: string;
  toolCallsAttempted: number;     // 解析出的工具调用数
  toolCallsSucceeded: number;     // 成功执行的工具调用数
  toolCallsParseFailed: boolean;  // 工具调用 XML 被截断
  outputHash: string;             // 输出内容 hash（检测重复）
  toolCallHash?: string;          // 工具调用内容 hash（检测重复调用）
  toolNames?: string[];           // 本轮调用的工具名称列表
  toolResultPatterns?: string[];  // 工具输出的模式指纹（前50字符 hash）
}

/**
 * 降级策略级别
 * 0 = 正常, 1 = 第一次降级（约束输出）, 2 = 第二次降级（终止任务）, 3+ = 强制终止
 */
export type DegradationLevel = 0 | 1 | 2 | 3;

/**
 * 进度追踪配置
 */
export interface ProgressTrackerConfig {
  /** 连续调用同一工具的最大次数 */
  maxConsecutiveSameTool: number;
  /** 同一失败模式的最大重复次数 */
  maxSameResultPattern: number;
  /** 工具历史窗口大小 */
  toolHistoryWindow: number;
  /** 触发降级的相似轮次阈值 */
  similarRoundThreshold: number;
  /** 允许重复调用的工具白名单 */
  repeatAllowedTools: string[];
}

/**
 * 诊断信息
 */
export interface ProgressDiagnostics {
  noProgressCount: number;
  consecutiveSameToolCount: number;
  lastPrimaryTool: string;
  toolNameHistory: string[];
  repeatPatternCount: number;
}

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 默认进度追踪配置
 */
export const DEFAULT_PROGRESS_TRACKER_CONFIG: ProgressTrackerConfig = {
  maxConsecutiveSameTool: 8,
  maxSameResultPattern: 5,
  toolHistoryWindow: 15,
  similarRoundThreshold: 6,
  repeatAllowedTools: [
    'file_read',      // 批量读取文件
    'file_list',      // 遍历目录
    'apply_patch',    // 连续应用多个补丁
    'file_write',     // 批量写入文件
    'shell_run',      // 连续执行 shell 命令
    'run_command',
    'execute_command',
  ],
};

// ============================================================================
// ProgressTracker 实现
// ============================================================================

/**
 * 进度追踪器
 */
export class ProgressTracker {
  private readonly config: ProgressTrackerConfig;
  private history: RoundProgress[] = [];
  private noProgressCount = 0;
  private lastOutputHash = '';
  private lastInjectedLevel: DegradationLevel = 0;
  private toolCallHashHistory: string[] = [];
  private repeatToolCallCount = 0;
  
  // 增强检测状态
  private toolNameHistory: string[] = [];
  private consecutiveSameToolCount = 0;
  private lastPrimaryTool = '';
  private resultPatternHistory = new Map<string, number>();
  
  constructor(config?: Partial<ProgressTrackerConfig>) {
    this.config = { ...DEFAULT_PROGRESS_TRACKER_CONFIG, ...config };
  }

  /**
   * 记录一轮执行的进度
   */
  recordRound(progress: RoundProgress): void {
    this.history.push(progress);
    
    // 更新工具名称历史
    if (progress.toolNames && progress.toolNames.length > 0) {
      const primaryTool = progress.toolNames[0] as string;
      this.toolNameHistory.push(primaryTool);
      
      // 保持窗口大小
      if (this.toolNameHistory.length > this.config.toolHistoryWindow) {
        this.toolNameHistory.shift();
      }
      
      // 检测连续相同工具
      if (primaryTool === this.lastPrimaryTool) {
        this.consecutiveSameToolCount++;
      } else {
        this.consecutiveSameToolCount = 1;
        this.lastPrimaryTool = primaryTool;
      }
    }
    
    // 更新结果模式历史
    if (progress.toolResultPatterns) {
      for (const pattern of progress.toolResultPatterns) {
        const count = this.resultPatternHistory.get(pattern) || 0;
        this.resultPatternHistory.set(pattern, count + 1);
      }
    }
    
    if (this.hasProgress(progress)) {
      this.noProgressCount = 0;
      this.lastInjectedLevel = 0;
    } else {
      this.noProgressCount++;
      console.warn(
        `[ProgressTracker] No progress detected. Count: ${this.noProgressCount}. ` +
        `stopReason=${progress.stopReason}, toolCallsSucceeded=${progress.toolCallsSucceeded}, ` +
        `toolCallsParseFailed=${progress.toolCallsParseFailed}, ` +
        `consecutiveSameTool=${this.consecutiveSameToolCount}`
      );
    }
    
    this.lastOutputHash = progress.outputHash;
  }
  
  /**
   * 判断本轮是否有实质进展
   */
  private hasProgress(progress: RoundProgress): boolean {
    // 正常完成（没有工具调用请求且 stop reason 是 stop）
    if (progress.stopReason === 'stop' && progress.toolCallsAttempted === 0) {
      return true;
    }
    
    // 检测重复的工具调用（完全相同的调用）
    if (progress.toolCallHash) {
      const lastHash = this.toolCallHashHistory[this.toolCallHashHistory.length - 1];
      if (lastHash === progress.toolCallHash) {
        this.repeatToolCallCount++;
        console.warn(
          `[ProgressTracker] Repeated tool call detected. RepeatCount: ${this.repeatToolCallCount}`
        );
        if (this.repeatToolCallCount >= 3) {
          return false;
        }
      } else {
        this.repeatToolCallCount = 0;
      }
      this.toolCallHashHistory.push(progress.toolCallHash);
      if (this.toolCallHashHistory.length > 10) {
        this.toolCallHashHistory.shift();
      }
    }
    
    // 工具频率限制
    const isWhitelistedTool = this.config.repeatAllowedTools.includes(this.lastPrimaryTool);
    if (!isWhitelistedTool && 
        this.consecutiveSameToolCount >= this.config.maxConsecutiveSameTool) {
      console.warn(
        `[ProgressTracker] Tool frequency limit reached. ` +
        `Tool "${this.lastPrimaryTool}" called ${this.consecutiveSameToolCount} times consecutively.`
      );
      return false;
    }
    
    // 结果模式重复
    if (progress.toolResultPatterns) {
      for (const pattern of progress.toolResultPatterns) {
        const count = this.resultPatternHistory.get(pattern) || 0;
        if (count >= this.config.maxSameResultPattern) {
          console.warn(
            `[ProgressTracker] Result pattern repeated ${count} times. ` +
            `Pattern: ${pattern.slice(0, 20)}...`
          );
          return false;
        }
      }
    }
    
    // 相似轮次检测
    if (this.toolNameHistory.length >= this.config.similarRoundThreshold) {
      const recentTools = this.toolNameHistory.slice(-this.config.similarRoundThreshold);
      const uniqueTools = new Set(recentTools);
      if (uniqueTools.size === 1) {
        const singleTool = recentTools[0];
        if (singleTool && !this.config.repeatAllowedTools.includes(singleTool)) {
          console.warn(
            `[ProgressTracker] Similar rounds detected. ` +
            `Last ${this.config.similarRoundThreshold} rounds all used tool: ${singleTool}`
          );
          return false;
        }
      }
    }
    
    // 有成功的工具调用
    if (progress.toolCallsSucceeded > 0) {
      return true;
    }
    
    // 被截断且无工具调用成功 = 无进展
    if (progress.stopReason === 'length' || progress.toolCallsParseFailed) {
      return false;
    }
    
    // 输出与上轮相同 = 无进展
    if (progress.outputHash === this.lastOutputHash && this.lastOutputHash !== '') {
      return false;
    }
    
    return true;
  }
  
  getNoProgressCount(): number {
    return this.noProgressCount;
  }
  
  shouldDegradeStrategy(): boolean {
    return this.noProgressCount >= 3;
  }
  
  getDegradationLevel(): DegradationLevel {
    if (this.noProgressCount < 3) return 0;
    if (this.noProgressCount < 6) return 1;
    if (this.noProgressCount < 9) return 2;
    return 3;
  }
  
  /**
   * 获取降级提示消息（仅当级别提升时返回消息）
   */
  getDegradationMessage(): string | null {
    const level = this.getDegradationLevel();
    
    if (level === 0 || level <= this.lastInjectedLevel) return null;
    
    this.lastInjectedLevel = level;
    
    if (level === 1) {
      const isToolLoop = this.consecutiveSameToolCount >= this.config.maxConsecutiveSameTool / 2;
      
      if (isToolLoop) {
        return `⚠️ Potential loop detected (${this.consecutiveSameToolCount} consecutive calls to "${this.lastPrimaryTool}").

Adjust your strategy:
1. Verify whether the previous tool calls actually succeeded
2. If a command failed, try a different approach instead of repeating the same command
3. If you hit permissions or environment limitations, report them and propose alternatives
4. Consider whether user intervention is required

If you cannot complete the task, clearly explain why.`;
      }
      
      return `⚠️ Your output appears to be getting truncated (${this.noProgressCount} consecutive no-progress rounds).

Adjust your strategy:
1. Do not generate an entire large file in one response
2. Produce one function or one small code block at a time (e.g., ≤100 lines)
3. Use a clear continuation marker when needed
4. Prefer incremental edits (e.g., \`apply_patch\`) over full rewrites

If the file is large, write it in multiple steps.

Important: Do not switch the user-facing response language due to this warning. Keep responding in the user's language.`;
    }
    
    if (level === 2) {
      return `⚠️ No progress for ${this.noProgressCount} consecutive rounds. Finish the current step or report the blocker immediately.

Suggestions:
- Simplify and deliver the minimum viable change
- If the task is too large, propose a concrete breakdown
- If you cannot proceed, clearly report the issue and why

Important: Keep responding in the user's language.`;
    }
    
    return null;
  }
  
  getHistory(): RoundProgress[] {
    return [...this.history];
  }
  
  getDiagnostics(): ProgressDiagnostics {
    let maxPatternCount = 0;
    for (const count of this.resultPatternHistory.values()) {
      maxPatternCount = Math.max(maxPatternCount, count);
    }
    
    return {
      noProgressCount: this.noProgressCount,
      consecutiveSameToolCount: this.consecutiveSameToolCount,
      lastPrimaryTool: this.lastPrimaryTool,
      toolNameHistory: [...this.toolNameHistory],
      repeatPatternCount: maxPatternCount,
    };
  }
  
  reset(): void {
    this.history = [];
    this.noProgressCount = 0;
    this.lastOutputHash = '';
    this.toolCallHashHistory = [];
    this.repeatToolCallCount = 0;
    this.toolNameHistory = [];
    this.consecutiveSameToolCount = 0;
    this.lastPrimaryTool = '';
    this.resultPatternHistory.clear();
    this.lastInjectedLevel = 0;
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 简单 hash 函数（用于检测重复输出）
 */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * 偏离检测器实现
 *
 * 负责检测 Worker 执行是否偏离目标，并在必要时发送干预指令
 * 从 Orchestrator 类中提取
 */

import type { ThinkingRecord, ISessionFileManager, InterventionFile } from '../session';
import type { IEventService } from '../interfaces';
import { createLLMClient } from '../../planner';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 偏离类型
 */
export type DeviationType =
  | 'off_task'
  | 'inefficient'
  | 'stuck'
  | 'repetitive'
  | 'resource_abuse';

/**
 * 严重程度
 */
export type DeviationSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * 偏离检测结果
 */
export interface DeviationResult {
  type: DeviationType;
  score: number;
  description: string;
  severity: DeviationSeverity;
  suggestedSteps: string[];
}

/**
 * 偏离检测配置
 */
export interface DeviationDetectorConfig {
  enabled: boolean;
  checkInterval: number;
  thinkingLogLimit: number;
  deviationThreshold: number;
  enableRuleBasedDetection: boolean;
  enableModelEvaluation: boolean;
  autoInterventionSeverity: DeviationSeverity;
  interventionCooldown: number;
  // 规则阈值
  repetitiveThreshold: number;
  stuckThreshold: number;
  offTaskThreshold: number;
  inefficientThreshold: number;
  // LLM 配置（可选）
  evaluationLLMConfig?: {
    provider: string;
    model: string;
    apiKey?: string;
    maxTokens?: number;
  };
}

/**
 * 默认偏离检测配置
 */
export const DEFAULT_DEVIATION_DETECTOR_CONFIG: DeviationDetectorConfig = {
  enabled: true,
  checkInterval: 30000,
  thinkingLogLimit: 10,
  deviationThreshold: 0.7,
  enableRuleBasedDetection: true,
  enableModelEvaluation: false,
  autoInterventionSeverity: 'medium',
  interventionCooldown: 60000,
  repetitiveThreshold: 0.8,
  stuckThreshold: 0.7,
  offTaskThreshold: 0.75,
  inefficientThreshold: 0.6,
};

/**
 * Worker 信息接口（用于检测）
 */
export interface WorkerInfo {
  id: string;
  status: 'idle' | 'busy' | 'error';
  currentTaskId?: string;
}

/**
 * Worker 池接口（仅用于获取 Worker 列表）
 */
export interface IWorkerPoolForDetection {
  getAllWorkers(): WorkerInfo[];
}

// ============================================================================
// DeviationDetector 实现
// ============================================================================

/**
 * 偏离检测器
 *
 * @example
 * ```ts
 * const detector = new DeviationDetector({
 *   config: { enabled: true, checkInterval: 30000 },
 *   sessionManager,
 *   workerPool,
 *   eventService,
 * });
 *
 * detector.start();
 * // ... worker 执行中 ...
 * detector.stop();
 * ```
 */
export class DeviationDetector {
  private readonly config: DeviationDetectorConfig;
  private readonly sessionManager: ISessionFileManager;
  private readonly workerPool: IWorkerPoolForDetection;
  private readonly eventService: IEventService;

  private detectionTimer: ReturnType<typeof setInterval> | null = null;
  private workerInterventionCooldowns = new Map<string, number>();

  constructor(options: {
    config?: Partial<DeviationDetectorConfig>;
    sessionManager: ISessionFileManager;
    workerPool: IWorkerPoolForDetection;
    eventService: IEventService;
  }) {
    this.config = { ...DEFAULT_DEVIATION_DETECTOR_CONFIG, ...options.config };
    this.sessionManager = options.sessionManager;
    this.workerPool = options.workerPool;
    this.eventService = options.eventService;
  }

  /**
   * 启动偏离检测
   */
  start(): void {
    if (!this.config.enabled) {
      return;
    }

    // 清除已有定时器
    this.stop();

    // 启动周期性检测
    this.detectionTimer = setInterval(() => {
      this.checkWorkersForDeviation().catch((error) => {
        console.error('[DeviationDetector] Detection error:', error);
      });
    }, this.config.checkInterval);
  }

  /**
   * 停止偏离检测
   */
  stop(): void {
    if (this.detectionTimer) {
      clearInterval(this.detectionTimer);
      this.detectionTimer = null;
    }
    // 清除冷却缓存
    this.workerInterventionCooldowns.clear();
  }

  /**
   * 检查所有 Worker 的偏离情况
   */
  async checkWorkersForDeviation(): Promise<void> {
    const workers = this.workerPool.getAllWorkers();

    for (const worker of workers) {
      // 跳过空闲状态的 Worker
      if (worker.status === 'idle') continue;

      // 检查冷却时间
      const lastIntervention = this.workerInterventionCooldowns.get(worker.id);
      if (
        lastIntervention &&
        Date.now() - lastIntervention < this.config.interventionCooldown
      ) {
        continue; // 仍在冷却中
      }

      try {
        // 读取最新思考日志
        const thinkingLogs = await this.sessionManager.readThinkingLogs(
          worker.id,
          this.config.thinkingLogLimit
        );

        if (thinkingLogs.length === 0) continue;

        // 使用规则检测评估偏离
        if (this.config.enableRuleBasedDetection) {
          const deviationResult = this.evaluateLogs(
            thinkingLogs,
            worker.currentTaskId
          );

          if (
            deviationResult &&
            deviationResult.score >= this.config.deviationThreshold
          ) {
            // 如果启用模型评估，用 LLM 二次确认
            let confirmedDeviation = true;
            if (
              this.config.enableModelEvaluation &&
              this.config.evaluationLLMConfig
            ) {
              confirmedDeviation = await this.evaluateWithModel(
                thinkingLogs,
                deviationResult
              );
            }

            if (confirmedDeviation) {
              // 发出偏离检测事件
              this.eventService.emit(
                'deviation:detected',
                worker.currentTaskId || '',
                {
                  workerId: worker.id,
                  deviationType: deviationResult.type,
                  score: deviationResult.score,
                  description: deviationResult.description,
                  modelConfirmed: this.config.enableModelEvaluation
                    ? confirmedDeviation
                    : undefined,
                }
              );

              // 判断是否需要自动干预
              if (
                this.shouldAutoIntervene(
                  deviationResult.severity,
                  this.config.autoInterventionSeverity
                )
              ) {
                await this.issueIntervention(worker.id, deviationResult);
              }
            }
          }
        }
      } catch (error) {
        console.error(
          `[DeviationDetector] Error checking worker ${worker.id}:`,
          error
        );
      }
    }
  }

  /**
   * 评估思考日志，检测偏离
   */
  evaluateLogs(
    logs: ThinkingRecord[],
    currentTaskId?: string
  ): DeviationResult | null {
    if (logs.length < 3) return null;

    // 规则1: 检测重复模式
    const recentLogs = logs.slice(-5);
    const contents = recentLogs.map((l) => l.content.toLowerCase().trim());
    const uniqueContents = new Set(contents);

    if (uniqueContents.size <= 2 && recentLogs.length >= 5) {
      return {
        type: 'repetitive',
        score: this.config.repetitiveThreshold,
        description:
          'Worker is producing repetitive thinking patterns, possibly stuck in a loop',
        severity: 'medium',
        suggestedSteps: [
          'Consider a different approach to the current problem',
          'Review the original task requirements',
          'If stuck, break down the problem into smaller steps',
        ],
      };
    }

    // 规则2: 检测置信度持续走低
    const confidences = logs
      .filter((l) => l.confidence !== undefined)
      .map((l) => l.confidence!);
    if (confidences.length >= 5) {
      const recentConfidences = confidences.slice(-5);
      const avgRecent =
        recentConfidences.reduce((a, b) => a + b, 0) / recentConfidences.length;
      const olderConfidences = confidences.slice(0, -5);
      const avgOlder =
        olderConfidences.length > 0
          ? olderConfidences.reduce((a, b) => a + b, 0) / olderConfidences.length
          : 0.7;

      if (avgRecent < 0.3 && avgOlder - avgRecent > 0.3) {
        return {
          type: 'stuck',
          score: this.config.stuckThreshold,
          description:
            'Worker confidence has dropped significantly, may be struggling with the current task',
          severity: 'low',
          suggestedSteps: [
            'Take a step back and reassess the problem',
            'Consider asking for additional context or clarification',
            'Try a simpler approach first',
          ],
        };
      }
    }

    // 规则3: 检测是否偏离任务
    if (currentTaskId) {
      const mismatchedLogs = recentLogs.filter(
        (l) => l.subtaskId !== currentTaskId
      );
      if (mismatchedLogs.length >= 3) {
        return {
          type: 'off_task',
          score: this.config.offTaskThreshold,
          description:
            'Worker thinking logs suggest deviation from the assigned task',
          severity: 'medium',
          suggestedSteps: [
            'Refocus on the current assigned task',
            'Check if the current work is aligned with task objectives',
          ],
        };
      }
    }

    // 规则4: 检测效率低下
    const reflectionLogs = recentLogs.filter((l) => l.stage === 'reflection');
    if (reflectionLogs.length >= 4 && recentLogs.length >= 5) {
      return {
        type: 'inefficient',
        score: this.config.inefficientThreshold,
        description:
          'Worker is spending too much time in reflection without making progress',
        severity: 'low',
        suggestedSteps: [
          'Move from reflection to action',
          'Make a decision and proceed with implementation',
        ],
      };
    }

    return null;
  }

  /**
   * 使用 LLM 评估偏离
   */
  private async evaluateWithModel(
    logs: ThinkingRecord[],
    ruleResult: DeviationResult
  ): Promise<boolean> {
    if (!this.config.evaluationLLMConfig) return true;

    try {
      const llmClient = createLLMClient({
        provider: this.config.evaluationLLMConfig.provider,
        apiKey: this.config.evaluationLLMConfig.apiKey || '',
        model: this.config.evaluationLLMConfig.model,
        maxTokens: this.config.evaluationLLMConfig.maxTokens || 500,
      });

      const logsText = logs
        .slice(-5)
        .map(
          (l) =>
            `[${l.stage}] ${l.content}${
              l.confidence !== undefined ? ` (confidence: ${l.confidence})` : ''
            }`
        )
        .join('\n');

      const response = await llmClient.complete({
        systemPrompt: `You are an AI assistant evaluating whether a worker agent is deviating from its assigned task.
Analyze the thinking logs and determine if the detected deviation is genuine.
Respond with only "YES" if you confirm the deviation, or "NO" if it seems to be a false positive.`,
        messages: [
          {
            role: 'user',
            content: `Rule-based detection found: ${ruleResult.type}
Description: ${ruleResult.description}
Confidence: ${ruleResult.score}

Recent thinking logs:
${logsText}

Is this a genuine deviation? Answer YES or NO only.`,
          },
        ],
        maxTokens: 10,
        temperature: 0.1,
      });

      return response.content.trim().toUpperCase().includes('YES');
    } catch (error) {
      console.error(
        '[DeviationDetector] Model evaluation failed:',
        error
      );
      return true; // 失败时默认信任规则检测结果
    }
  }

  /**
   * 判断是否应该自动干预
   */
  private shouldAutoIntervene(
    detectedSeverity: DeviationSeverity,
    thresholdSeverity: DeviationSeverity
  ): boolean {
    const severityOrder = { low: 0, medium: 1, high: 2, critical: 3 };
    return severityOrder[detectedSeverity] >= severityOrder[thresholdSeverity];
  }

  /**
   * 向 Worker 发送干预指令
   */
  async issueIntervention(
    workerId: string,
    deviation: DeviationResult
  ): Promise<void> {
    // 记录冷却时间
    this.workerInterventionCooldowns.set(workerId, Date.now());

    // 根据偏离类型决定干预类型
    const interventionType: InterventionFile['type'] =
      deviation.type === 'off_task'
        ? 'redirect'
        : deviation.severity === 'critical'
        ? 'pause'
        : 'guidance';

    // 构建干预指令
    const intervention: Omit<
      InterventionFile,
      'interventionId' | 'createdAt' | 'acknowledged'
    > = {
      type: interventionType,
      reason: `Deviation detected: ${deviation.type}`,
      detectedIssue: {
        type:
          deviation.type === 'off_task'
            ? 'deviation'
            : deviation.type === 'inefficient'
            ? 'inefficiency'
            : deviation.type === 'stuck' || deviation.type === 'repetitive'
            ? 'stuck'
            : 'error',
        description: deviation.description,
        severity: deviation.severity,
      },
      instructions: this.generateInterventionInstructions(
        deviation.type,
        deviation.description
      ),
      suggestedNextSteps: deviation.suggestedSteps,
    };

    // 写入干预指令
    await this.sessionManager.writeIntervention(workerId, intervention);

    // 发送干预事件
    this.eventService.emit('deviation:intervention', '', {
      workerId,
      deviationType: deviation.type,
      interventionType,
      severity: deviation.severity,
    });
  }

  /**
   * 生成干预指令内容
   */
  private generateInterventionInstructions(
    deviationType: string,
    description: string
  ): string {
    const instructions: Record<string, string> = {
      off_task:
        'Please refocus on your assigned task. The detected behavior suggests you may have strayed from the main objective. Review your task requirements and realign your approach.',
      inefficient:
        'Your current approach appears to be inefficient. Consider simplifying your strategy and making more direct progress toward the goal.',
      stuck:
        'You appear to be stuck. Try a different approach or break down the problem into smaller, more manageable steps.',
      repetitive:
        'You are repeating similar actions without progress. Step back, analyze what is not working, and try an alternative method.',
      resource_abuse:
        'Resource usage patterns are concerning. Please optimize your approach to use resources more efficiently.',
    };

    return instructions[deviationType] || `Attention required: ${description}`;
  }
}

/**
 * 创建偏离检测器实例
 */
export function createDeviationDetector(options: {
  config?: Partial<DeviationDetectorConfig>;
  sessionManager: ISessionFileManager;
  workerPool: IWorkerPoolForDetection;
  eventService: IEventService;
}): DeviationDetector {
  return new DeviationDetector(options);
}

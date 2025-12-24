/**
 * Trajectory Reflection Module
 *
 * 分析任务执行轨迹，提取可学习模式
 * 参考 Letta 的 Skill Learning 两阶段设计（Reflection + Creation）
 *
 * @module skills/learning/reflection
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 执行轨迹记录（统一格式，兼容 ThinkingRecord 和 ActionRecord）
 */
export interface TrajectoryRecord {
  /** 记录 ID */
  id: string;
  /** 时间戳 */
  timestamp: number;
  /** 子任务 ID（用于多任务轨迹分析） */
  subtaskId?: string | undefined;
  /** 记录类型 */
  type: 'thinking' | 'action' | 'tool_call' | 'error';
  /** 内容描述 */
  content: string;
  /** 阶段（如 analysis, planning, decision, reflection） */
  stage?: string | undefined;
  /** 置信度 (0-1) */
  confidence?: number | undefined;
  /** 工具名称（如果是工具调用） */
  toolName?: string | undefined;
  /** 相关工具列表（保留完整数组） */
  relatedTools?: string[] | undefined;
  /** 工具参数 */
  toolParams?: Record<string, unknown> | undefined;
  /** 结果 */
  result?: {
    success: boolean;
    output?: unknown;
    error?: string;
    duration?: number;
  } | undefined;
}

/**
 * 执行反馈（来自测试结果或用户）
 */
export interface ExecutionFeedback {
  /** 任务是否成功完成 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
  /** 测试结果 */
  testResults?: {
    passed: number;
    failed: number;
    errors: string[];
  };
  /** 用户反馈 */
  userFeedback?: string;
  /** 性能指标 */
  metrics?: {
    duration?: number;
    tokenCount?: number;
    toolCalls?: number;
  };
}

/**
 * 识别的模式
 */
export interface IdentifiedPattern {
  /** 模式名称 */
  name: string;
  /** 模式描述 */
  description: string;
  /** 模式类型 */
  type: 'solution' | 'pitfall' | 'optimization' | 'edge_case';
  /** 置信度 (0-1) */
  confidence: number;
  /** 支持证据（来自轨迹的记录 ID） */
  evidence: string[];
}

/**
 * 失败模式
 */
export interface FailureMode {
  /** 失败类型 */
  type: 'error' | 'timeout' | 'wrong_approach' | 'missing_context' | 'edge_case';
  /** 描述 */
  description: string;
  /** 根因分析 */
  rootCause?: string;
  /** 建议的缓解措施 */
  mitigation?: string;
}

/**
 * 反思结果
 */
export interface ReflectionResult {
  /** 任务是否成功 */
  success: boolean;
  /** 推理链是否合理 */
  reasoningValid: boolean;
  /** 推理摘要 */
  reasoningSummary: string;
  /** 识别的模式 */
  patterns: IdentifiedPattern[];
  /** 失败模式（如果有） */
  failureModes: FailureMode[];
  /** 可抽象的知识点 */
  abstractableKnowledge: string[];
  /** 建议的技能名称 */
  suggestedSkillName?: string | undefined;
  /** 建议的技能描述 */
  suggestedSkillDescription?: string | undefined;
  /** 建议的技能标签 */
  suggestedTags?: string[] | undefined;
  /** 原始 LLM 响应（用于调试） */
  rawResponse?: string | undefined;
}

/**
 * 反思配置
 */
export interface ReflectionConfig {
  /** LLM 调用函数 */
  llmCall: (prompt: string) => Promise<string>;
  /** 是否包含详细分析 */
  detailed?: boolean;
  /** 最大轨迹记录数 */
  maxRecords?: number;
  /** 是否生成技能建议 */
  suggestSkill?: boolean;
}

// ============================================================================
// 反思器实现
// ============================================================================

/**
 * 轨迹反思器
 *
 * 分析执行轨迹，提取可学习模式，为技能创建提供输入
 */
export class TrajectoryReflector {
  private readonly config: ReflectionConfig;

  constructor(config: ReflectionConfig) {
    this.config = {
      detailed: true,
      maxRecords: 50,
      suggestSkill: true,
      ...config,
    };
  }

  /**
   * 分析执行轨迹
   *
   * @param trajectory - 执行轨迹记录列表
   * @param taskDescription - 原始任务描述
   * @param feedback - 可选的执行反馈
   * @returns 反思结果
   */
  async reflect(
    trajectory: TrajectoryRecord[],
    taskDescription: string,
    feedback?: ExecutionFeedback,
  ): Promise<ReflectionResult> {
    // 1. 预处理轨迹
    const processedTrajectory = this.preprocessTrajectory(trajectory);

    // 2. 构建反思 Prompt
    const prompt = this.buildReflectionPrompt(
      processedTrajectory,
      taskDescription,
      feedback,
    );

    // 3. 调用 LLM
    const rawResponse = await this.config.llmCall(prompt);

    // 4. 解析响应
    const result = this.parseReflectionResponse(rawResponse, feedback?.success ?? false);

    return result;
  }

  /**
   * 预处理轨迹记录
   */
  private preprocessTrajectory(trajectory: TrajectoryRecord[]): TrajectoryRecord[] {
    const maxRecords = this.config.maxRecords ?? 50;

    // 按时间排序
    const sorted = [...trajectory].sort((a, b) => a.timestamp - b.timestamp);

    // 如果超过限制，保留开头和结尾的记录
    if (sorted.length > maxRecords) {
      const headCount = Math.floor(maxRecords * 0.3);
      const tailCount = maxRecords - headCount;
      return [
        ...sorted.slice(0, headCount),
        ...sorted.slice(-tailCount),
      ];
    }

    return sorted;
  }

  /**
   * 构建反思 Prompt
   */
  private buildReflectionPrompt(
    trajectory: TrajectoryRecord[],
    taskDescription: string,
    feedback?: ExecutionFeedback,
  ): string {
    const trajectoryText = this.formatTrajectory(trajectory);
    const feedbackText = feedback ? this.formatFeedback(feedback) : 'No feedback available.';

    return `# Task Execution Reflection

## Original Task
${taskDescription}

## Execution Trajectory
${trajectoryText}

## Execution Feedback
${feedbackText}

## Analysis Instructions

Analyze the above execution trajectory and provide a structured reflection. Your response MUST be a valid JSON object with the following structure:

\`\`\`json
{
  "success": boolean,
  "reasoningValid": boolean,
  "reasoningSummary": "Brief summary of the reasoning chain",
  "patterns": [
    {
      "name": "Pattern name",
      "description": "What this pattern represents",
      "type": "solution" | "pitfall" | "optimization" | "edge_case",
      "confidence": 0.0-1.0,
      "evidence": ["record_id_1", "record_id_2"]
    }
  ],
  "failureModes": [
    {
      "type": "error" | "timeout" | "wrong_approach" | "missing_context" | "edge_case",
      "description": "What went wrong",
      "rootCause": "Why it happened",
      "mitigation": "How to prevent it"
    }
  ],
  "abstractableKnowledge": [
    "Key insight 1 that can be applied to similar tasks",
    "Key insight 2"
  ]${this.config.suggestSkill ? `,
  "suggestedSkillName": "kebab-case-skill-name",
  "suggestedSkillDescription": "One sentence description",
  "suggestedTags": ["tag1", "tag2"]` : ''}
}
\`\`\`

Focus on:
1. Was the task completed successfully?
2. Was the reasoning chain logical and efficient?
3. What patterns emerged that could be reused?
4. What failures or edge cases were encountered?
5. What knowledge can be abstracted for future similar tasks?

Respond ONLY with the JSON object, no additional text.`;
  }

  /**
   * 格式化轨迹记录
   */
  private formatTrajectory(trajectory: TrajectoryRecord[]): string {
    if (trajectory.length === 0) {
      return 'No trajectory records available.';
    }

    return trajectory.map((record, index) => {
      const time = new Date(record.timestamp).toISOString();
      let line = `[${index + 1}] ${time} | ${record.type.toUpperCase()}`;

      if (record.stage) {
        line += ` (${record.stage})`;
      }

      if (record.toolName) {
        line += ` | Tool: ${record.toolName}`;
      }

      line += `\n    ${record.content}`;

      if (record.result) {
        const status = record.result.success ? '✓' : '✗';
        line += `\n    Result: ${status}`;
        if (record.result.error) {
          line += ` - ${record.result.error}`;
        }
        if (record.result.duration) {
          line += ` (${record.result.duration}ms)`;
        }
      }

      line += `\n    [ID: ${record.id}]`;

      return line;
    }).join('\n\n');
  }

  /**
   * 格式化反馈
   */
  private formatFeedback(feedback: ExecutionFeedback): string {
    const lines: string[] = [];

    lines.push(`Success: ${feedback.success ? 'Yes' : 'No'}`);

    if (feedback.error) {
      lines.push(`Error: ${feedback.error}`);
    }

    if (feedback.testResults) {
      lines.push(`Tests: ${feedback.testResults.passed} passed, ${feedback.testResults.failed} failed`);
      if (feedback.testResults.errors.length > 0) {
        lines.push(`Test Errors:\n  - ${feedback.testResults.errors.slice(0, 5).join('\n  - ')}`);
      }
    }

    if (feedback.userFeedback) {
      lines.push(`User Feedback: ${feedback.userFeedback}`);
    }

    if (feedback.metrics) {
      const m = feedback.metrics;
      const parts: string[] = [];
      if (m.duration) parts.push(`Duration: ${m.duration}ms`);
      if (m.tokenCount) parts.push(`Tokens: ${m.tokenCount}`);
      if (m.toolCalls) parts.push(`Tool Calls: ${m.toolCalls}`);
      if (parts.length > 0) {
        lines.push(`Metrics: ${parts.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 解析 LLM 响应
   */
  private parseReflectionResponse(
    rawResponse: string,
    feedbackSuccess: boolean,
  ): ReflectionResult {
    try {
      // 尝试提取 JSON
      const jsonMatch = rawResponse.match(/```json\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : rawResponse;

      // 清理可能的非 JSON 内容
      const cleanedJson = jsonStr?.trim()
        .replace(/^[^{]*/, '')
        .replace(/[^}]*$/, '');

      if (!cleanedJson) {
        return this.createDefaultResult(feedbackSuccess, rawResponse);
      }

      const parsed = JSON.parse(cleanedJson) as Partial<ReflectionResult>;

      // 验证和填充默认值
      return {
        success: parsed.success ?? feedbackSuccess,
        reasoningValid: parsed.reasoningValid ?? true,
        reasoningSummary: parsed.reasoningSummary ?? 'Unable to extract reasoning summary.',
        patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
        failureModes: Array.isArray(parsed.failureModes) ? parsed.failureModes : [],
        abstractableKnowledge: Array.isArray(parsed.abstractableKnowledge)
          ? parsed.abstractableKnowledge
          : [],
        suggestedSkillName: parsed.suggestedSkillName,
        suggestedSkillDescription: parsed.suggestedSkillDescription,
        suggestedTags: Array.isArray(parsed.suggestedTags) ? parsed.suggestedTags : undefined,
        rawResponse,
      };
    } catch {
      return this.createDefaultResult(feedbackSuccess, rawResponse);
    }
  }

  /**
   * 创建默认结果
   */
  private createDefaultResult(
    success: boolean,
    rawResponse: string,
  ): ReflectionResult {
    return {
      success,
      reasoningValid: true,
      reasoningSummary: 'Unable to parse LLM response. Raw response preserved.',
      patterns: [],
      failureModes: [],
      abstractableKnowledge: [],
      rawResponse,
    };
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建轨迹反思器
 */
export function createTrajectoryReflector(
  config: ReflectionConfig,
): TrajectoryReflector {
  return new TrajectoryReflector(config);
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 ThinkingRecord 转换为 TrajectoryRecord
 */
export function thinkingRecordToTrajectory(
  record: {
    id: string;
    timestamp: number;
    subtaskId?: string;
    content: string;
    stage?: string;
    confidence?: number;
    relatedTools?: string[];
  },
): TrajectoryRecord {
  const result: TrajectoryRecord = {
    id: record.id,
    timestamp: record.timestamp,
    type: 'thinking',
    content: record.content,
  };
  
  if (record.subtaskId !== undefined) {
    result.subtaskId = record.subtaskId;
  }
  
  if (record.stage !== undefined) {
    result.stage = record.stage;
  }
  
  if (record.confidence !== undefined) {
    result.confidence = record.confidence;
  }
  
  if (record.relatedTools !== undefined && record.relatedTools.length > 0) {
    result.relatedTools = record.relatedTools;
    result.toolName = record.relatedTools[0];
  }
  
  return result;
}

/**
 * 从 ActionRecord 转换为 TrajectoryRecord
 */
export function actionRecordToTrajectory(
  record: {
    id: string;
    timestamp: number;
    subtaskId?: string;
    type: string;
    description: string;
    params?: Record<string, unknown>;
    result?: {
      success: boolean;
      output?: unknown;
      error?: string;
      duration: number;
    };
  },
): TrajectoryRecord {
  const result: TrajectoryRecord = {
    id: record.id,
    timestamp: record.timestamp,
    type: record.type === 'tool_call' ? 'tool_call' : 'action',
    content: record.description,
  };
  
  if (record.subtaskId !== undefined) {
    result.subtaskId = record.subtaskId;
  }
  
  if (record.type === 'tool_call' && record.params?.tool !== undefined) {
    result.toolName = record.params.tool as string;
  }
  
  if (record.params !== undefined) {
    result.toolParams = record.params;
  }
  
  if (record.result !== undefined) {
    result.result = record.result;
  }
  
  return result;
}

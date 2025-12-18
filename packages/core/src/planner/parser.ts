/**
 * 规划输出解析器
 *
 * 负责解析 LLM 响应、验证格式、处理重试逻辑
 */

import type { ParseResult, ParseRetryConfig, LLMClient, LLMRequest } from './types';
import {
  type PlanningOutputFormat,
  extractJsonFromResponse,
  generateErrorFeedbackPrompt,
  PLANNING_SYSTEM_PROMPT,
} from './prompts';
import { LLMClientError } from './llm-client';

// ============================================================================
// 解析错误
// ============================================================================

/**
 * 解析错误
 */
export class ParseError extends Error {
  constructor(
    message: string,
    public field?: string,
    public rawContent?: string
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

// ============================================================================
// 验证函数
// ============================================================================

/**
 * 验证子任务格式
 */
function validateSubtask(
  subtask: unknown,
  index: number
): asserts subtask is PlanningOutputFormat['subtasks'][0] {
  if (typeof subtask !== 'object' || subtask === null) {
    throw new ParseError(`subtasks[${index}] must be an object`, `subtasks[${index}]`);
  }

  const st = subtask as Record<string, unknown>;

  if (typeof st.id !== 'string' || !st.id) {
    throw new ParseError(`subtasks[${index}].id must be a non-empty string`, `subtasks[${index}].id`);
  }

  if (typeof st.objective !== 'string' || !st.objective) {
    throw new ParseError(
      `subtasks[${index}].objective must be a non-empty string`,
      `subtasks[${index}].objective`
    );
  }

  if (st.roleId !== undefined && typeof st.roleId !== 'string') {
    throw new ParseError(
      `subtasks[${index}].roleId must be a string when provided`,
      `subtasks[${index}].roleId`
    );
  }

  if (st.requiredCapabilities !== undefined) {
    if (!Array.isArray(st.requiredCapabilities)) {
      throw new ParseError(
        `subtasks[${index}].requiredCapabilities must be an array when provided`,
        `subtasks[${index}].requiredCapabilities`
      );
    }
    for (const cap of st.requiredCapabilities) {
      if (typeof cap !== 'string' || !cap) {
        throw new ParseError(
          `subtasks[${index}].requiredCapabilities must contain non-empty strings`,
          `subtasks[${index}].requiredCapabilities`
        );
      }
    }
  }

  if (!Array.isArray(st.constraints)) {
    throw new ParseError(
      `subtasks[${index}].constraints must be an array`,
      `subtasks[${index}].constraints`
    );
  }

  if (typeof st.estimatedMinutes !== 'number' || st.estimatedMinutes < 0) {
    throw new ParseError(
      `subtasks[${index}].estimatedMinutes must be a non-negative number`,
      `subtasks[${index}].estimatedMinutes`
    );
  }

  if (!Array.isArray(st.dependencies)) {
    throw new ParseError(
      `subtasks[${index}].dependencies must be an array`,
      `subtasks[${index}].dependencies`
    );
  }
}

/**
 * 验证执行步骤格式
 */
function validateExecutionStep(
  step: unknown,
  index: number
): asserts step is PlanningOutputFormat['executionPlan']['steps'][0] {
  if (typeof step !== 'object' || step === null) {
    throw new ParseError(`executionPlan.steps[${index}] must be an object`, `executionPlan.steps[${index}]`);
  }

  const s = step as Record<string, unknown>;

  if (typeof s.order !== 'number' || s.order < 1) {
    throw new ParseError(
      `executionPlan.steps[${index}].order must be a positive number`,
      `executionPlan.steps[${index}].order`
    );
  }

  if (!Array.isArray(s.subtaskIds) || s.subtaskIds.length === 0) {
    throw new ParseError(
      `executionPlan.steps[${index}].subtaskIds must be a non-empty array`,
      `executionPlan.steps[${index}].subtaskIds`
    );
  }

  if (typeof s.parallel !== 'boolean') {
    throw new ParseError(
      `executionPlan.steps[${index}].parallel must be a boolean`,
      `executionPlan.steps[${index}].parallel`
    );
  }
}

/**
 * 验证执行计划格式
 */
function validateExecutionPlan(
  plan: unknown
): asserts plan is PlanningOutputFormat['executionPlan'] {
  if (typeof plan !== 'object' || plan === null) {
    throw new ParseError('executionPlan must be an object', 'executionPlan');
  }

  const p = plan as Record<string, unknown>;

  if (typeof p.isParallel !== 'boolean') {
    throw new ParseError('executionPlan.isParallel must be a boolean', 'executionPlan.isParallel');
  }

  if (!Array.isArray(p.steps)) {
    throw new ParseError('executionPlan.steps must be an array', 'executionPlan.steps');
  }

  // 空步骤数组在没有子任务时是允许的
  p.steps.forEach((step, index) => validateExecutionStep(step, index));
}

/**
 * 验证完整的规划输出格式
 */
function validatePlanningOutput(data: unknown): asserts data is PlanningOutputFormat {
  if (typeof data !== 'object' || data === null) {
    throw new ParseError('Response must be a JSON object');
  }

  const obj = data as Record<string, unknown>;

  // intake（可选）
  if (obj.intake !== undefined) {
    if (typeof obj.intake !== 'object' || obj.intake === null) {
      throw new ParseError('intake must be an object when provided', 'intake');
    }
    const intake = obj.intake as Record<string, unknown>;
    if (typeof intake.ready !== 'boolean') {
      throw new ParseError('intake.ready must be a boolean', 'intake.ready');
    }
    if (intake.userIntent !== undefined && typeof intake.userIntent !== 'string') {
      throw new ParseError('intake.userIntent must be a string when provided', 'intake.userIntent');
    }
    if (intake.sentiment !== undefined && typeof intake.sentiment !== 'string') {
      throw new ParseError('intake.sentiment must be a string when provided', 'intake.sentiment');
    }
    if (intake.missingInfo !== undefined) {
      if (!Array.isArray(intake.missingInfo)) {
        throw new ParseError('intake.missingInfo must be an array when provided', 'intake.missingInfo');
      }
      for (const item of intake.missingInfo) {
        if (typeof item !== 'string') {
          throw new ParseError('intake.missingInfo must contain strings', 'intake.missingInfo');
        }
      }
    }
    if (intake.questions !== undefined) {
      if (!Array.isArray(intake.questions)) {
        throw new ParseError('intake.questions must be an array when provided', 'intake.questions');
      }
      for (const q of intake.questions) {
        if (typeof q !== 'string') {
          throw new ParseError('intake.questions must contain strings', 'intake.questions');
        }
      }
    }
  }

  // roles（可选）
  if (obj.roles !== undefined) {
    if (!Array.isArray(obj.roles)) {
      throw new ParseError('roles must be an array when provided', 'roles');
    }
    for (let i = 0; i < obj.roles.length; i++) {
      const role = obj.roles[i];
      if (typeof role !== 'object' || role === null) {
        throw new ParseError(`roles[${i}] must be an object`, `roles[${i}]`);
      }
      const r = role as Record<string, unknown>;
      if (typeof r.id !== 'string' || !r.id) {
        throw new ParseError(`roles[${i}].id must be a non-empty string`, `roles[${i}].id`);
      }
      if (typeof r.name !== 'string' || !r.name) {
        throw new ParseError(`roles[${i}].name must be a non-empty string`, `roles[${i}].name`);
      }
      if (typeof r.responsibilities !== 'string') {
        throw new ParseError(`roles[${i}].responsibilities must be a string`, `roles[${i}].responsibilities`);
      }
      if (!Array.isArray(r.capabilities)) {
        throw new ParseError(`roles[${i}].capabilities must be an array`, `roles[${i}].capabilities`);
      }
      for (const cap of r.capabilities) {
        if (typeof cap !== 'string' || !cap) {
          throw new ParseError(`roles[${i}].capabilities must contain non-empty strings`, `roles[${i}].capabilities`);
        }
      }
    }
  }

  // 验证 reasoning
  // 允许缺省（用于提升鲁棒性），缺省时填充为空字符串
  if (obj.reasoning === undefined) {
    obj.reasoning = '';
  } else if (typeof obj.reasoning !== 'string') {
    throw new ParseError('reasoning must be a string', 'reasoning');
  }

  // 验证 subtasks
  if (!Array.isArray(obj.subtasks)) {
    throw new ParseError('subtasks must be an array', 'subtasks');
  }
  obj.subtasks.forEach((st, i) => validateSubtask(st, i));

  // 验证 executionPlan
  validateExecutionPlan(obj.executionPlan);

  // 验证 estimatedTotalMinutes
  if (typeof obj.estimatedTotalMinutes !== 'number' || obj.estimatedTotalMinutes < 0) {
    throw new ParseError(
      'estimatedTotalMinutes must be a non-negative number',
      'estimatedTotalMinutes'
    );
  }

  // 验证 complexityScore
  if (
    typeof obj.complexityScore !== 'number' ||
    obj.complexityScore < 1 ||
    obj.complexityScore > 10
  ) {
    throw new ParseError('complexityScore must be a number between 1 and 10', 'complexityScore');
  }

  // 验证子任务 ID 的一致性
  const subtaskIds = new Set(obj.subtasks.map((st) => (st as { id: string }).id));
  const roleIds = new Set(
    Array.isArray(obj.roles) ? (obj.roles as Array<{ id: string }>).map((r) => r.id) : []
  );
  const stepsSubtaskIds = (obj.executionPlan as { steps: { subtaskIds: string[] }[] }).steps.flatMap(
    (s) => s.subtaskIds
  );

  for (const id of stepsSubtaskIds) {
    if (!subtaskIds.has(id)) {
      throw new ParseError(
        `executionPlan references unknown subtask ID: ${id}`,
        'executionPlan.steps'
      );
    }
  }

  // 验证并修复依赖关系的一致性（自动移除无效依赖）
  for (const st of obj.subtasks as { id: string; dependencies: string[] }[]) {
    // 过滤掉无效的依赖
    const originalDeps = [...st.dependencies];
    st.dependencies = st.dependencies.filter(depId => {
      if (!subtaskIds.has(depId)) {
        console.warn(`[Parser] Auto-fix: removed invalid dependency ${depId} from ${st.id}`);
        return false;
      }
      if (depId === st.id) {
        console.warn(`[Parser] Auto-fix: removed self-dependency from ${st.id}`);
        return false;
      }
      return true;
    });
    if (st.dependencies.length !== originalDeps.length) {
      console.warn(`[Parser] Dependencies fixed for ${st.id}: ${JSON.stringify(originalDeps)} -> ${JSON.stringify(st.dependencies)}`);
    }
  }

  // 如果提供了 roles，验证 roleId 引用的一致性
  if (roleIds.size > 0) {
    for (const st of obj.subtasks as Array<{ roleId?: unknown }>) {
      if (st.roleId === undefined) continue;
      if (typeof st.roleId !== 'string') continue;
      if (!roleIds.has(st.roleId)) {
        throw new ParseError(
          `subtask references unknown roleId: ${st.roleId}`,
          'subtasks.roleId'
        );
      }
    }
  }

  // P0 修复：DAG 环检测 - 防止循环依赖导致调度死锁
  const subtasks = obj.subtasks as { id: string; dependencies: string[] }[];
  const hasCycle = detectDependencyCycle(subtasks);
  if (hasCycle) {
    throw new ParseError(
      'Circular dependency detected in subtasks. This would cause scheduling deadlock.',
      'subtasks.dependencies'
    );
  }

  // P1 修复：检查执行步骤中的 subtaskIds 是否重复
  const seenInSteps = new Set<string>();
  for (const step of (obj.executionPlan as { steps: { subtaskIds: string[]; order: number }[] }).steps) {
    for (const id of step.subtaskIds) {
      if (seenInSteps.has(id)) {
        throw new ParseError(
          `subtask ${id} appears in multiple execution steps (step ${step.order})`,
          'executionPlan.steps'
        );
      }
      seenInSteps.add(id);
    }
  }

  // P2 修复：estimatedTotalMinutes 一致性校验（警告但不阻塞）
  const sumMinutes = subtasks.reduce((sum, st) => sum + ((st as { estimatedMinutes?: number }).estimatedMinutes ?? 0), 0);
  const totalMinutes = obj.estimatedTotalMinutes as number;
  if (totalMinutes > 0 && Math.abs(sumMinutes - totalMinutes) > totalMinutes * 0.5) {
    // 差异超过 50%，可能是 LLM 估算错误，但不阻塞
    console.warn(
      `[Parser Warning] estimatedTotalMinutes (${totalMinutes}) differs significantly from sum of subtask estimates (${sumMinutes})`
    );
  }
}

// ============================================================================
// DAG 环检测辅助函数
// ============================================================================

/**
 * 检测子任务依赖是否存在环（使用 DFS 拓扑排序）
 */
function detectDependencyCycle(
  subtasks: { id: string; dependencies: string[] }[]
): boolean {
  const visited = new Set<string>();
  const stack = new Set<string>();

  // 构建邻接表
  const graph = new Map<string, string[]>();
  for (const st of subtasks) {
    graph.set(st.id, st.dependencies);
  }

  function dfs(id: string): boolean {
    if (stack.has(id)) {
      return true; // 发现环
    }
    if (visited.has(id)) {
      return false; // 已处理，无环
    }

    visited.add(id);
    stack.add(id);

    const deps = graph.get(id) ?? [];
    for (const dep of deps) {
      if (dfs(dep)) {
        return true;
      }
    }

    stack.delete(id);
    return false;
  }

  // 检查所有节点
  for (const st of subtasks) {
    if (dfs(st.id)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// 解析器
// ============================================================================

/**
 * 解析 LLM 响应为规划输出
 *
 * @param content - LLM 响应内容
 * @returns 解析结果
 */
export function parsePlanningOutput(content: string): ParseResult<PlanningOutputFormat> {
  const rawContent = content;

  try {
    // 提取 JSON
    const jsonStr = extractJsonFromResponse(content);

    // 解析 JSON
    let data: unknown;
    try {
      data = JSON.parse(jsonStr);
    } catch (e) {
      return {
        success: false,
        error: `Invalid JSON: ${(e as Error).message}`,
        rawContent,
      };
    }

    // 验证格式
    validatePlanningOutput(data);

    return {
      success: true,
      data,
      rawContent,
    };
  } catch (error) {
    if (error instanceof ParseError) {
      return {
        success: false,
        error: error.field ? `${error.message} (field: ${error.field})` : error.message,
        rawContent,
      };
    }

    return {
      success: false,
      error: `Unexpected error: ${(error as Error).message}`,
      rawContent,
    };
  }
}

// ============================================================================
// 带重试的解析
// ============================================================================

/**
 * 默认重试配置
 */
export const DEFAULT_PARSE_RETRY_CONFIG: ParseRetryConfig = {
  maxRetries: 3,
  includeErrorFeedback: true,
};

/**
 * 带重试的规划解析器
 *
 * 在解析失败时，会向 LLM 发送错误反馈并请求修正
 */
export class PlanningParser {
  private readonly client: LLMClient;
  private readonly config: ParseRetryConfig;

  constructor(client: LLMClient, config: Partial<ParseRetryConfig> = {}) {
    this.client = client;
    this.config = { ...DEFAULT_PARSE_RETRY_CONFIG, ...config };
  }

  /**
   * 解析 LLM 响应，支持重试
   *
   * @param initialResponse - 初始 LLM 响应
   * @param originalRequest - 原始请求（用于重试时保持上下文）
   * @returns 解析结果和重试统计
   */
  async parseWithRetry(
    initialResponse: string,
    originalRequest?: LLMRequest
  ): Promise<{
    result: ParseResult<PlanningOutputFormat>;
    retryCount: number;
    totalTokens: { input: number; output: number };
  }> {
    let currentResponse = initialResponse;
    let retryCount = 0;
    const totalTokens = { input: 0, output: 0 };

    // 首次解析
    let result = parsePlanningOutput(currentResponse);

    // 重试循环
    while (!result.success && retryCount < this.config.maxRetries) {
      // 如果不包含错误反馈或客户端不可用，直接返回失败
      if (!this.config.includeErrorFeedback || !this.client.isAvailable()) {
        break;
      }

      retryCount++;

      try {
        // 生成错误反馈 prompt
        const feedbackPrompt = generateErrorFeedbackPrompt({
          originalResponse: currentResponse,
          parseError: result.error || 'Unknown error',
          retryCount,
        });

        // 发送重试请求
        const retryResponse = await this.client.complete({
          // 保持与原始请求一致的 system prompt（支持 patch planning 等不同模式）
          systemPrompt: originalRequest?.systemPrompt ?? PLANNING_SYSTEM_PROMPT,
          messages: [
            // 包含原始请求上下文（如果有）
            ...(originalRequest?.messages || []),
            // 添加错误反馈
            { role: 'user', content: feedbackPrompt },
          ],
          maxTokens: originalRequest?.maxTokens,
          temperature: 0.1, // 重试时使用更低的温度以提高稳定性
        });

        // 更新 token 统计
        totalTokens.input += retryResponse.usage.inputTokens;
        totalTokens.output += retryResponse.usage.outputTokens;

        // 解析新响应
        currentResponse = retryResponse.content;
        result = parsePlanningOutput(currentResponse);
      } catch (error) {
        // LLM 调用失败，停止重试
        if (error instanceof LLMClientError && !error.retryable) {
          break;
        }
        // 其他错误继续重试
        continue;
      }
    }

    return {
      result,
      retryCount,
      totalTokens,
    };
  }
}

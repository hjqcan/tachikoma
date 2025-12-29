/**
 * Planner 实现
 *
 * 负责将高层任务分解为子任务，并生成委托配置
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { DelegationConfig, DelegationMode, RetryPolicy } from '../types';
import type {
  OrchestratorTask,
  SubTask,
  PlannerInput,
  PlannerOutput,
  PlannerConfig,
  ExecutionPlan,
  PlannerRole,
  ProjectStructure,
} from '../orchestrator';
import type { LLMClient, LLMRequest, ParseRetryConfig, ParseResult } from './types';
import {
  createLLMClient,
  LLMClientError,
  PlanningParser,
  PLANNING_SYSTEM_PROMPT,
  PATCH_PLANNING_SYSTEM_PROMPT,
  SUBTASK_REFINE_SYSTEM_PROMPT,
  generatePlanningUserPrompt,
  generatePatchPlanningUserPrompt,
  generateSubtaskRefineUserPrompt,
  generateSubtaskRefineErrorFeedbackPrompt,
  convertToSubTasks,
  convertToExecutionPlan,
  extractJsonFromResponse,
  type PlanningOutputFormat,
  type SubtaskRefineOutputFormat,
} from './index';
import {
  DEFAULT_PLANNER_CONFIG,
  DEFAULT_DELEGATION_DEFAULTS,
  DEFAULT_RETRY_POLICY,
} from '../orchestrator/config';
import { injectToolRecommendations } from './subtask-validator';
import { MemoryService } from '../memory';
import { z } from 'zod';

// Skills imports
import { loadSkillsByScope } from '../skills/loader';
import { activateSkillsAsync, renderActivatedSkills } from '../skills/activator';
import type { SkillMetadata, SkillDiscoveryConfig } from '../skills/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Planner 选项
 */
export interface PlannerOptions {
  /** 规划器配置 */
  config?: Partial<PlannerConfig>;
  /** LLM 客户端（可选，用于注入测试） */
  llmClient?: LLMClient;
  /** 解析重试配置 */
  parseRetryConfig?: Partial<ParseRetryConfig>;
  /** Skills 发现配置（用于加载 Orchestrator Skills） */
  skillsConfig?: SkillDiscoveryConfig;
  /** 当前工作目录（用于发现项目级 Skills） */
  cwd?: string;
}

/**
 * 规划结果
 */
export interface PlanResult {
  /** 是否成功 */
  success: boolean;
  /** 规划输出（成功时存在） */
  output?: PlannerOutput;
  /** 错误信息（失败时存在） */
  error?: string;
  /** 使用的 Token 数 */
  tokensUsed: {
    input: number;
    output: number;
  };
  /** 重试次数 */
  retryCount: number;
  /** 是否使用了降级策略 */
  degraded: boolean;
}

/**
 * 降级策略
 */
export interface DegradationStrategy {
  /** 降级后的 Worker 数量 */
  workerCount?: number;
  /** 降级后的委托模式 */
  mode?: DelegationMode;
  /** 降级后的超时时间 */
  timeout?: number;
  /** 降级后的重试策略 */
  retryPolicy?: RetryPolicy;
}

/**
 * Subtask refinement input
 */
export interface SubtaskRefineInput {
  /** Subtask objective */
  objective: string;
  /** Subtask constraints */
  constraints: string[];
  /** Available tools (optional) */
  availableTools?: string[];
  /** Max refined subtasks (optional) */
  maxSubtasks?: number;
  /** Max thinking/tool turns per subtask (optional) */
  maxThinkingRounds?: number;
  /** Estimated duration (minutes, optional) */
  estimatedMinutes?: number;
}

/**
 * Subtask refinement result
 */
export interface SubtaskRefineResult {
  /** Whether refinement succeeded */
  success: boolean;
  /** Whether the subtask should be split */
  shouldSplit: boolean;
  /** Reason for the decision */
  reason?: string;
  /** Proposed refined subtasks */
  subtasks?: Array<{
    objective: string;
    constraints: string[];
    estimatedMinutes?: number;
  }>;
  /** Error message (when failed) */
  error?: string;
  /** Token usage */
  tokensUsed: {
    input: number;
    output: number;
  };
  /** Retry count */
  retryCount: number;
}

const SUBTASK_REFINER_SCHEMA = z
  .object({
    shouldSplit: z.boolean(),
    reason: z.string().optional().default(''),
    subtasks: z
      .array(
        z.object({
          objective: z.string().min(1),
          constraints: z.array(z.string()).optional(),
          estimatedMinutes: z.number().nonnegative().optional(),
        })
      )
      .optional()
      .default([]),
  })
  .passthrough();

// ============================================================================
// Planner 实现
// ============================================================================

/**
 * Planner 类
 *
 * 负责将高层任务分解为子任务，并生成委托配置
 *
 * @example
 * ```ts
 * const planner = new Planner({
 *   config: { defaultMaxSubtasks: 10 }
 * });
 *
 * const result = await planner.plan({
 *   task: {
 *     id: 'task-1',
 *     type: 'composite',
 *     objective: '实现用户认证系统',
 *     constraints: ['使用 JWT', '支持 OAuth'],
 *     priority: 'high',
 *     complexity: 'complex',
 *   }
 * });
 * ```
 */
export class Planner {
  private readonly config: PlannerConfig;
  private readonly llmClient: LLMClient;
  private readonly parser: PlanningParser;
  private readonly parseRetryConfig: ParseRetryConfig;
  private memoryService?: MemoryService;
  private memoryMetrics = {
    retrievalCount: 0,
    hitCount: 0,
    tokensSaved: 0,
    totalLatencyMs: 0,
  };
  
  // Orchestrator Skills
  private readonly skillsConfig: SkillDiscoveryConfig | undefined;
  private readonly cwd: string | undefined;
  private orchestratorSkills: SkillMetadata[] = [];

  constructor(options: PlannerOptions = {}) {
    // 合并配置
    this.config = {
      ...DEFAULT_PLANNER_CONFIG,
      ...options.config,
      agent: {
        ...DEFAULT_PLANNER_CONFIG.agent,
        ...options.config?.agent,
      },
    };

    // 创建或使用注入的 LLM 客户端
    this.llmClient = options.llmClient || createLLMClient(this.config.agent);

    // 解析重试配置
    this.parseRetryConfig = {
      maxRetries: this.config.maxParseRetries,
      includeErrorFeedback: true,
      ...options.parseRetryConfig,
    };

    // 创建解析器
    this.parser = new PlanningParser(this.llmClient, this.parseRetryConfig);
    
    // 初始化 MemoryService (如果配置启用)
    if (this.config.memoryConfig?.enabled) {
      this.memoryService = new MemoryService(this.config.memoryConfig);
      console.debug('[Planner] MemoryService initialized');
    }
    
    // 加载 Orchestrator Skills
    this.skillsConfig = options.skillsConfig;
    this.cwd = options.cwd;
    if (this.skillsConfig?.enabled !== false) {
      try {
        const outcome = loadSkillsByScope('orchestrator', this.skillsConfig, this.cwd);
        this.orchestratorSkills = outcome.skills;
        if (this.orchestratorSkills.length > 0) {
          console.debug(`[Planner] Loaded ${this.orchestratorSkills.length} orchestrator skills`);
        }
        if (outcome.errors.length > 0) {
          console.warn(`[Planner] Skills loading had ${outcome.errors.length} errors`);
        }
      } catch (error) {
        console.warn('[Planner] Failed to load orchestrator skills:', error);
      }
    }
  }

  /**
   * 为“已有 subtasks（来自 tasks.json）”推理角色与分配（roles + roleAssignments）
   *
   * 约束：
   * - 不改变 subtasks 的内容与依赖（仅做角色设计与分配）
   * - 输出必须是严格 JSON
   */
  async inferRolesForSubtasks(input: {
    task: OrchestratorTask;
    subtasks: Array<{ id: string; objective: string; constraints?: string[] }>;
    /**
     * 已有的显式 role 分配（不会被覆盖；用于提示模型减少不必要的改动）
     * key: subtaskId
     */
    fixedAssignments?: Record<string, { roleId: string }>;
    /** 建议的最大角色数（模型可少于该值） */
    maxRoles?: number;
  }): Promise<{
    success: boolean;
    roles?: NonNullable<PlannerOutput['roles']>;
    roleAssignments?: Record<string, { roleId: string; requiredCapabilities?: string[] }>;
    tokensUsed: { input: number; output: number };
    retryCount: number;
    degraded: boolean;
    error?: string;
  }> {
    const { task, subtasks, fixedAssignments, maxRoles } = input;

    const totalTokens = { input: 0, output: 0 };
    let totalRetries = 0;
    const degraded = false;

    const ROLE_INFERENCE_SYSTEM_PROMPT = `You are an orchestration lead. Your job is to design an optimal minimal set of roles (each role ≈ one worker) and assign each given subtask to exactly one role.

## Constraints (Very Important)
- You MUST NOT modify the subtasks themselves. Only assign roles.
- Output MUST be valid JSON only. No extra text, no code fences.
- Each role must have a stable id (lowercase, use letters/numbers with '-' or '_').
- Each role.capabilities MUST include "role:<roleId>".
- For every subtask assignment, requiredCapabilities MUST include at least "role:<roleId>".
- You MUST return an assignment for every provided subtask id. Do not invent new ids.

## Output JSON Schema
{
  "reasoning": "1-2 sentences",
  "roles": [
    { "id": "frontend", "name": "Frontend Engineer", "responsibilities": "...", "capabilities": ["role:frontend", "..."] }
  ],
  "assignments": {
    "1.1": { "roleId": "frontend", "requiredCapabilities": ["role:frontend"] }
  }
}`;

    const ROLE_INFERENCE_SCHEMA = z
      .object({
        reasoning: z.string().optional(),
        roles: z
          .array(
            z.object({
              id: z.string().min(1),
              name: z.string().min(1),
              responsibilities: z.string().optional().default(''),
              capabilities: z.array(z.string().min(1)).optional().default([]),
            })
          )
          .min(1),
        assignments: z.record(
          z.string(),
          z.object({
            roleId: z.string().min(1),
            requiredCapabilities: z.array(z.string().min(1)).optional(),
          })
        ),
      })
      .passthrough();

    const normalizeRoleId = (raw: string): string => {
      const s = raw.trim().toLowerCase();
      const normalized = s
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
      return normalized || 'generalist';
    };

    const subtaskIds = subtasks.map((s) => s.id).filter((s): s is string => typeof s === 'string' && s.length > 0);
    const idSet = new Set(subtaskIds);

    const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
    const summarizeSubtasks = (): string => {
      const maxItems = 120;
      const items = subtasks.slice(0, maxItems).map((st) => {
        const constraints = Array.isArray(st.constraints) ? st.constraints : [];
        const smallConstraints = constraints.slice(0, 4).map((c) => clip(String(c), 200));
        return {
          id: st.id,
          objective: clip(String(st.objective ?? ''), 240),
          ...(smallConstraints.length > 0 ? { constraints: smallConstraints } : {}),
        };
      });
      return JSON.stringify(items, null, 2);
    };

    const fixed = (() => {
      if (!fixedAssignments) return null;
      const entries = Object.entries(fixedAssignments)
        .filter(([id, v]) => idSet.has(id) && v && typeof v.roleId === 'string' && v.roleId.trim())
        .map(([id, v]) => [id, { roleId: normalizeRoleId(v.roleId) }] as const);
      if (entries.length === 0) return null;
      return JSON.stringify(Object.fromEntries(entries), null, 2);
    })();

    const userPromptParts: string[] = [];
    userPromptParts.push(`Project objective:\n${clip(String(task.objective ?? ''), 800)}`);
    userPromptParts.push('');
    userPromptParts.push(`Subtasks (do NOT modify):\n${summarizeSubtasks()}`);
    if (fixed) {
      userPromptParts.push('');
      userPromptParts.push(
        `Fixed role assignments (MUST NOT change these roleIds; still return assignments for all ids):\n${fixed}`
      );
    }
    if (typeof maxRoles === 'number' && Number.isFinite(maxRoles) && maxRoles > 0) {
      userPromptParts.push('');
      userPromptParts.push(`Max roles (soft constraint): ${Math.max(1, Math.floor(maxRoles))}`);
    }
    const userPrompt = userPromptParts.join('\n');

    const makeRequest = (content: string): LLMRequest => ({
      systemPrompt: ROLE_INFERENCE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
      // token 预算：避免过长输出
      maxTokens: Math.min(2048, this.config.agent.maxTokens),
      temperature: 0.2,
    });

    const parse = (raw: string): ParseResult<z.infer<typeof ROLE_INFERENCE_SCHEMA>> => {
      try {
        const extracted = extractJsonFromResponse(raw);
        const obj = JSON.parse(extracted) as unknown;
        const data = ROLE_INFERENCE_SCHEMA.parse(obj);
        return { success: true, data, rawContent: raw };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, error: msg, rawContent: raw };
      }
    };

    const validate = (data: z.infer<typeof ROLE_INFERENCE_SCHEMA>): string | null => {
      const roleIds = new Set(data.roles.map((r) => normalizeRoleId(r.id)));
      // 1) assignments 覆盖所有 id
      for (const id of idSet) {
        if (!(id in data.assignments)) return `Missing assignment for subtask id: ${id}`;
      }
      // 2) 不允许输出多余 id（避免 hallucination）
      for (const id of Object.keys(data.assignments)) {
        if (!idSet.has(id)) return `Assignment contains unknown subtask id: ${id}`;
      }
      // 3) roleId 必须存在于 roles
      for (const [id, a] of Object.entries(data.assignments)) {
        const rid = normalizeRoleId(a.roleId);
        if (!roleIds.has(rid)) {
          return `Assignment for ${id} references unknown roleId: ${a.roleId}`;
        }
      }
      return null;
    };

    // 调用 + 解析重试
    let lastError: string | undefined;
    for (let attempt = 0; attempt <= this.parseRetryConfig.maxRetries; attempt++) {
      const request = makeRequest(attempt === 0 ? userPrompt : `Fix your JSON output.\n\n${userPrompt}\n\nError: ${lastError ?? 'unknown'}`);
      try {
        const resp = await this.llmClient.complete(request);
        totalTokens.input += resp.usage.inputTokens;
        totalTokens.output += resp.usage.outputTokens;

        const parsed = parse(resp.content);
        if (!parsed.success || !parsed.data) {
          lastError = parsed.error ?? 'parse failed';
        } else {
          const vErr = validate(parsed.data);
          if (vErr) {
            lastError = vErr;
          } else {
            // 规范化输出：roleId/capabilities/requiredCapabilities
            const normalizedRoles = parsed.data.roles.map((r) => {
              const id = normalizeRoleId(r.id);
              const caps = Array.isArray(r.capabilities) ? r.capabilities.filter((c) => typeof c === 'string' && c.trim()) : [];
              const stableCap = `role:${id}`;
              const mergedCaps = Array.from(new Set([stableCap, ...caps]));
              return {
                id,
                name: r.name,
                responsibilities: r.responsibilities ?? '',
                capabilities: mergedCaps,
              };
            });

            const roleAssignments: Record<string, { roleId: string; requiredCapabilities?: string[] }> = {};
            for (const id of idSet) {
              const a = parsed.data.assignments[id];
              if (!a) {
                throw new Error(`Missing assignment for subtask id: ${id}`);
              }
              const rid = normalizeRoleId(a.roleId);
              const capsRaw = Array.isArray(a.requiredCapabilities) ? a.requiredCapabilities : [];
              const caps = capsRaw.filter((c) => typeof c === 'string' && c.trim());
              const stableCap = `role:${rid}`;
              roleAssignments[id] = {
                roleId: rid,
                requiredCapabilities: Array.from(new Set([stableCap, ...caps])),
              };
            }

            // 固定分配：最终覆盖（不让模型改）
            if (fixedAssignments) {
              for (const [id, v] of Object.entries(fixedAssignments)) {
                if (!idSet.has(id)) continue;
                if (!v?.roleId) continue;
                const rid = normalizeRoleId(v.roleId);
                roleAssignments[id] = {
                  roleId: rid,
                  requiredCapabilities: Array.from(new Set([`role:${rid}`, ...(roleAssignments[id]?.requiredCapabilities ?? [])])),
                };
              }
            }

            return {
              success: true,
              roles: normalizedRoles,
              roleAssignments,
              tokensUsed: totalTokens,
              retryCount: totalRetries,
              degraded,
            };
          }
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }

      if (attempt < this.parseRetryConfig.maxRetries) {
        totalRetries++;
        continue;
      }
    }

    return {
      success: false,
      error: lastError ?? 'role inference failed',
      tokensUsed: totalTokens,
      retryCount: totalRetries,
      degraded,
    };
  }

  /**
   * 执行任务规划
   *
   * @param input - 规划器输入
   * @returns 规划结果
   */
  async plan(input: PlannerInput): Promise<PlanResult> {
    const { task, availableTools, contextConstraints, maxSubtasks, preferences } = input;

    const totalTokens = { input: 0, output: 0 };
    let totalRetries = 0;
    const degraded = false;

    try {
      // 生成用户 Prompt (包含异步获取的记忆上下文)
      const additionalContext = await this.buildAdditionalContext(task, preferences);
      const userPrompt = generatePlanningUserPrompt({
        objective: task.objective,
        constraints: task.constraints,
        availableTools,
        maxSubtasks: maxSubtasks ?? this.config.defaultMaxSubtasks,
        additionalContext,
      });

      // 构建 LLM 请求
      const request: LLMRequest = {
        systemPrompt: PLANNING_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: this.config.agent.maxTokens,
        temperature: this.config.agent.temperature,
      };

      // 调用 LLM
      const response = await this.llmClient.complete(request);
      totalTokens.input += response.usage.inputTokens;
      totalTokens.output += response.usage.outputTokens;

      // 解析响应（带重试）
      const { result: parseResult, retryCount, totalTokens: retryTokens } =
        await this.parser.parseWithRetry(response.content, request);

      totalTokens.input += retryTokens.input;
      totalTokens.output += retryTokens.output;
      totalRetries = retryCount;

      if (!parseResult.success || !parseResult.data) {
        return {
          success: false,
          error: parseResult.error || 'Failed to parse planning output',
          tokensUsed: totalTokens,
          retryCount: totalRetries,
          degraded,
        };
      }

      // 转换为内部格式并生成委托配置
      const plannerOutput = this.buildPlannerOutput(
        task,
        parseResult.data,
        contextConstraints,
        preferences
      );

      return {
        success: true,
        output: plannerOutput,
        tokensUsed: totalTokens,
        retryCount: totalRetries,
        degraded,
      };
    } catch (error) {
      // 处理可重试的错误，尝试降级
      if (error instanceof LLMClientError && error.retryable) {
        const degradationResult = await this.tryDegradation(
          { mode: 'full' },
          input,
          totalTokens,
          totalRetries
        );
        if (degradationResult) {
          return { ...degradationResult, degraded: true };
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        tokensUsed: totalTokens,
        retryCount: totalRetries,
        degraded,
      };
    }
  }

  /**
   * 执行 Patch 规划（增量修改）
   *
   * @param input - 规划器输入
   * @param previousContext - 之前计划/产出上下文摘要（可选）
   * @returns 规划结果
   */
  async planPatch(input: PlannerInput, previousContext?: string): Promise<PlanResult> {
    const { task, availableTools, contextConstraints, maxSubtasks, preferences } = input;

    const totalTokens = { input: 0, output: 0 };
    let totalRetries = 0;
    const degraded = false;

    try {
      const additionalContext = await this.buildAdditionalContext(task, preferences);
      const userPrompt = generatePatchPlanningUserPrompt({
        objective: task.objective,
        constraints: task.constraints,
        availableTools,
        maxSubtasks: maxSubtasks ?? this.config.defaultMaxSubtasks,
        additionalContext,
        previousContext,
      });

      const request: LLMRequest = {
        systemPrompt: PATCH_PLANNING_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: this.config.agent.maxTokens,
        temperature: this.config.agent.temperature,
      };

      const response = await this.llmClient.complete(request);
      totalTokens.input += response.usage.inputTokens;
      totalTokens.output += response.usage.outputTokens;

      const { result: parseResult, retryCount, totalTokens: retryTokens } =
        await this.parser.parseWithRetry(response.content, request);

      totalTokens.input += retryTokens.input;
      totalTokens.output += retryTokens.output;
      totalRetries = retryCount;

      if (!parseResult.success || !parseResult.data) {
        return {
          success: false,
          error: parseResult.error || 'Failed to parse planning output',
          tokensUsed: totalTokens,
          retryCount: totalRetries,
          degraded,
        };
      }

      const plannerOutput = this.buildPlannerOutput(
        task,
        parseResult.data,
        contextConstraints,
        preferences
      );

      return {
        success: true,
        output: plannerOutput,
        tokensUsed: totalTokens,
        retryCount: totalRetries,
        degraded,
      };
    } catch (error) {
      if (error instanceof LLMClientError && error.retryable) {
        const degradationResult = await this.tryDegradation(
          { mode: 'patch', ...(previousContext ? { previousContext } : {}) },
          input,
          totalTokens,
          totalRetries
        );
        if (degradationResult) {
          return { ...degradationResult, degraded: true };
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        tokensUsed: totalTokens,
        retryCount: totalRetries,
        degraded,
      };
    }
  }

  /**
   * 执行子任务复审（执行前拆分）
   *
   * @param input - 子任务复审输入
   * @returns 复审结果
   */
  async refineSubtask(input: SubtaskRefineInput): Promise<SubtaskRefineResult> {
    const {
      objective,
      constraints,
      availableTools,
      maxSubtasks,
      maxThinkingRounds,
      estimatedMinutes,
    } = input;

    const totalTokens = { input: 0, output: 0 };
    let totalRetries = 0;

    try {
      const userPrompt = generateSubtaskRefineUserPrompt({
        objective,
        constraints,
        availableTools,
        maxSubtasks,
        maxThinkingRounds,
        estimatedMinutes,
      });

      const request: LLMRequest = {
        systemPrompt: SUBTASK_REFINE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: this.config.agent.maxTokens,
        temperature: this.config.agent.temperature,
      };

      const response = await this.llmClient.complete(request);
      totalTokens.input += response.usage.inputTokens;
      totalTokens.output += response.usage.outputTokens;

      const { result: parseResult, retryCount, totalTokens: retryTokens } =
        await this.parseSubtaskRefineWithRetry(response.content, request);

      totalTokens.input += retryTokens.input;
      totalTokens.output += retryTokens.output;
      totalRetries = retryCount;

      if (!parseResult.success || !parseResult.data) {
        return {
          success: false,
          shouldSplit: false,
          error: parseResult.error || 'Failed to parse subtask refinement output',
          tokensUsed: totalTokens,
          retryCount: totalRetries,
        };
      }

      const normalizedSubtasks = parseResult.data.subtasks
        .map((st) => ({
          objective: st.objective.trim(),
          constraints: Array.isArray(st.constraints)
            ? st.constraints.filter((c) => typeof c === 'string' && c.trim())
            : [],
          ...(Number.isFinite(st.estimatedMinutes)
            ? { estimatedMinutes: st.estimatedMinutes }
            : {}),
        }))
        .filter((st) => st.objective.length > 0);

      const shouldSplit = parseResult.data.shouldSplit && normalizedSubtasks.length >= 2;

      return {
        success: true,
        shouldSplit,
        reason: parseResult.data.reason,
        subtasks: shouldSplit ? normalizedSubtasks : [],
        tokensUsed: totalTokens,
        retryCount: totalRetries,
      };
    } catch (error) {
      return {
        success: false,
        shouldSplit: false,
        error: error instanceof Error ? error.message : String(error),
        tokensUsed: totalTokens,
        retryCount: totalRetries,
      };
    }
  }

  /**
   * 构建额外上下文
   * 
   * 包含任务元数据和相关历史记忆
   */
  private async buildAdditionalContext(
    task: OrchestratorTask,
    preferences?: PlannerInput['preferences']
  ): Promise<string | undefined> {
    const parts: string[] = [];

    // 添加优先级和复杂度信息
    parts.push(`任务优先级：${task.priority}`);
    parts.push(`任务复杂度：${task.complexity}`);

    // 添加偏好信息
    if (preferences?.preferParallel) {
      parts.push('偏好：尽可能并行执行子任务');
    }
    if (preferences?.conservativeMode) {
      parts.push('模式：保守模式，生成较少的子任务');
    }

    // Skills: 激活匹配的 Orchestrator Skills (best-effort)
    if (this.orchestratorSkills.length > 0) {
      try {
        const activated = await activateSkillsAsync(
          this.orchestratorSkills,
          task.objective,
          { autoActivate: true, maxAutoActivated: 3 }
        );
        
        if (activated.length > 0) {
          const skillsPrompt = renderActivatedSkills(activated);
          if (skillsPrompt) {
            console.debug(`[Planner] Activated ${activated.length} orchestrator skills for planning`);
            parts.push('');
            parts.push('[规划指导技能]');
            parts.push(skillsPrompt);
          }
        }
      } catch (error) {
        console.warn('[Planner] Skills activation failed (continuing):', error);
      }
    }

    // Memory: 检索相关历史记忆 (best-effort)
    if (this.memoryService) {
      try {
        console.debug('[Planner] Retrieving relevant memories for planning...');
        const topK = this.config.memoryConfig?.topK ?? 5;
        
        // Track metrics
        this.memoryMetrics.retrievalCount++;
        const retrievalStart = Date.now();
        
        // 检索 declarative (事实/知识) 和 procedural (过去任务/决策) 记忆
        const [declarativeResult, proceduralResult] = await Promise.all([
          this.memoryService.retrieve(task.objective, topK, 'declarative'),
          this.memoryService.retrieve(task.objective, topK, 'procedural'),
        ]);
        
        // Track latency
        this.memoryMetrics.totalLatencyMs += Date.now() - retrievalStart;
        
        // 合并并按 relevanceScore 排序（高分优先）
        const allMemories = [...declarativeResult.memories, ...proceduralResult.memories]
          .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
        
        // 取全局 topK（最多10条，防止 context 过长）
        const maxMemories = Math.min(topK * 2, 10);
        const memories = allMemories.slice(0, maxMemories);
        
        if (memories.length > 0) {
          // Track hit and estimate tokens saved (rough: ~4 chars per token)
          this.memoryMetrics.hitCount++;
          const totalContent = memories.reduce((acc, m) => acc + m.content.length, 0);
          this.memoryMetrics.tokensSaved += Math.floor(totalContent / 4);
          
          console.debug(`[Planner] Found ${memories.length} relevant memories (from ${allMemories.length} total)`);
          parts.push('');
          parts.push('[历史记忆参考]');
          parts.push('以下是与当前任务相关的历史记忆，仅作为规划参考，不是新的任务要求：');
          for (const m of memories) {
            const score = m.relevanceScore ? ` [score: ${m.relevanceScore.toFixed(2)}]` : '';
            parts.push(`- ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}${score}`);
          }
        }
      } catch (error) {
        console.warn('[Planner] Memory retrieval failed (continuing):', error);
      }
    }

    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  private parseSubtaskRefineOutput(content: string): ParseResult<SubtaskRefineOutputFormat> {
    const jsonStr = extractJsonFromResponse(content);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(jsonStr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Invalid JSON: ${message}`,
        rawContent: content,
      };
    }

    const parsed = SUBTASK_REFINER_SCHEMA.safeParse(parsedJson);
    if (!parsed.success) {
      const issueText = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ');
      return {
        success: false,
        error: issueText || 'Invalid subtask refinement output',
        rawContent: content,
      };
    }

    const subtasks: SubtaskRefineOutputFormat['subtasks'] = Array.isArray(parsed.data.subtasks)
      ? parsed.data.subtasks.map((st) => ({
          objective: st.objective,
          ...(Array.isArray(st.constraints) ? { constraints: st.constraints } : {}),
          ...(typeof st.estimatedMinutes === 'number' ? { estimatedMinutes: st.estimatedMinutes } : {}),
        }))
      : [];

    const data: SubtaskRefineOutputFormat = {
      shouldSplit: parsed.data.shouldSplit,
      reason: parsed.data.reason ?? '',
      subtasks,
    };

    return {
      success: true,
      data,
      rawContent: content,
    };
  }

  private async parseSubtaskRefineWithRetry(
    content: string,
    request: LLMRequest
  ): Promise<{
    result: ParseResult<SubtaskRefineOutputFormat>;
    retryCount: number;
    totalTokens: { input: number; output: number };
  }> {
    const totalTokens = { input: 0, output: 0 };
    let retryCount = 0;
    let currentContent = content;

    while (true) {
      const result = this.parseSubtaskRefineOutput(currentContent);
      if (result.success) {
        return { result, retryCount, totalTokens };
      }

      if (
        retryCount >= this.parseRetryConfig.maxRetries ||
        !this.parseRetryConfig.includeErrorFeedback
      ) {
        return { result, retryCount, totalTokens };
      }

      const feedback = generateSubtaskRefineErrorFeedbackPrompt({
        originalResponse: currentContent,
        parseError: result.error || 'Unknown parse error',
        retryCount: retryCount + 1,
      });

      const retryRequest: LLMRequest = {
        ...request,
        messages: [{ role: 'user', content: feedback }],
      };

      const retryResponse = await this.llmClient.complete(retryRequest);
      totalTokens.input += retryResponse.usage.inputTokens;
      totalTokens.output += retryResponse.usage.outputTokens;
      currentContent = retryResponse.content;
      retryCount += 1;
    }
  }

  /**
   * 构建 PlannerOutput
   */
  private buildPlannerOutput(
    task: OrchestratorTask,
    planningOutput: PlanningOutputFormat,
    contextConstraints?: PlannerInput['contextConstraints'],
    _preferences?: PlannerInput['preferences'] // 保留用于将来扩展
  ): PlannerOutput {
    const intake = planningOutput.intake
      ? {
          ready: planningOutput.intake.ready,
          ...(planningOutput.intake.userIntent !== undefined && { userIntent: planningOutput.intake.userIntent }),
          ...(planningOutput.intake.sentiment !== undefined && { sentiment: planningOutput.intake.sentiment }),
          ...(Array.isArray(planningOutput.intake.missingInfo) && { missingInfo: planningOutput.intake.missingInfo }),
          ...(Array.isArray(planningOutput.intake.questions) && { questions: planningOutput.intake.questions }),
        }
      : undefined;

    const roles = Array.isArray(planningOutput.roles)
      ? planningOutput.roles.map((r) => ({
          id: r.id,
          name: r.name,
          responsibilities: r.responsibilities,
          capabilities: r.capabilities,
        }))
      : undefined;

    // 转换子任务（注入父任务目标以支持技能匹配上下文传递）
    let subtasks = convertToSubTasks(planningOutput, task.id, task.objective);

    // 验证并优化子任务（注入工具推荐）
    const subtasksForValidation = subtasks.map(st => ({
      objective: st.objective,
      constraints: st.constraints ?? [],
    }));
    const enhancedSubtasks = injectToolRecommendations(subtasksForValidation);
    
    // 合并增强后的约束条件
    subtasks = subtasks.map((st, i) => {
      const enhanced = enhancedSubtasks[i];
      const stConstraints = st.constraints ?? [];
      const enhancedConstraints = enhanced?.constraints ?? [];
      if (enhancedConstraints.length > stConstraints.length) {
        return { ...st, constraints: enhancedConstraints };
      }
      return st;
    });

    // 转换执行计划
    const executionPlan = convertToExecutionPlan(planningOutput);

    // 计算委托配置
    const delegation = this.calculateDelegationConfig(
      subtasks,
      executionPlan,
      task.complexity,
      contextConstraints
    );

    // 角色化规划：worker 数量由 roles 决定（每个角色≈一个 worker）
    if (intake?.ready !== false && roles && roles.length > 0) {
      delegation.workerCount = Math.max(1, roles.length);
    }

    // P4: 生成项目目录结构约束，防止多 Worker 创建重复目录
    const projectStructure = this.inferProjectStructure(task, subtasks, roles);
    
    // 注入目录约束到所有子任务
    if (projectStructure) {
      subtasks = subtasks.map(st => ({
        ...st,
        constraints: [
          ...(st.constraints ?? []),
          ...this.generateDirectoryConstraints(projectStructure),
        ],
      }));
    }

    return {
      taskId: task.id,
      subtasks,
      delegation,
      executionPlan,
      ...(intake && { intake: { ...intake, ...(roles && { roles }) } }),
      ...(roles && { roles }),
      ...(projectStructure && { projectStructure }),
      reasoning: this.config.enableReasoning ? (planningOutput.reasoning || '') : undefined,
      estimatedTotalDuration: planningOutput.estimatedTotalMinutes * 60 * 1000,
      estimatedTokens: this.estimateTokenUsage(subtasks),
    };
  }

  /**
   * P4: 推断项目目录结构
   * 根据任务目标和角色推断标准目录名称
   */
  private inferProjectStructure(
    task: OrchestratorTask,
    _subtasks: SubTask[],
    roles?: PlannerRole[]
  ): PlannerOutput['projectStructure'] | undefined {
    const projectConfig = this.config.projectStructure;
    if (!projectConfig?.enabled) {
      return undefined;
    }

    const preferExisting = projectConfig.preferExisting !== false;
    const existing = preferExisting ? this.detectExistingStructure() : undefined;
    if (existing) {
      return existing;
    }

    const defaults = this.normalizeProjectStructure(projectConfig.defaults);
    if (defaults) {
      return defaults;
    }

    const objective = task.objective.toLowerCase();
    const hasRoles = roles && roles.length > 0;
    
    // 检测是否是全栈项目（前端+后端）
    const hasFrontendRole = hasRoles && roles.some(r => 
      r.capabilities?.some((c: string) => /react|vue|angular|frontend|ui/i.test(c))
    );
    const hasBackendRole = hasRoles && roles.some(r =>
      r.capabilities?.some((c: string) => /python|fastapi|node|express|backend|api/i.test(c))
    );
    
    // 检测任务描述中的技术栈
    const mentionsFrontend = /react|vue|angular|前端|frontend/i.test(objective);
    const mentionsBackend = /python|fastapi|django|flask|node|express|后端|backend|api/i.test(objective);
    
    // 只有多角色或明确的前后端分离项目才需要目录约束
    if ((hasFrontendRole && hasBackendRole) || (mentionsFrontend && mentionsBackend)) {
      return {
        frontend: 'frontend',
        backend: 'backend',
        shared: 'shared',
        tests: 'tests',
      };
    }
    
    // 单纯前端项目
    if (hasFrontendRole || mentionsFrontend) {
      return {
        frontend: 'src',
        tests: 'tests',
      };
    }
    
    // 单纯后端项目
    if (hasBackendRole || mentionsBackend) {
      return {
        backend: 'src',
        tests: 'tests',
      };
    }
    
    return undefined;
  }

  private normalizeProjectStructure(
    structure: ProjectStructure | undefined
  ): PlannerOutput['projectStructure'] | undefined {
    if (!structure) return undefined;
    const normalized: ProjectStructure = {};
    const normalizeValue = (value?: string): string | undefined => {
      if (!value) return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const frontend = normalizeValue(structure.frontend);
    if (frontend) normalized.frontend = frontend;
    const backend = normalizeValue(structure.backend);
    if (backend) normalized.backend = backend;
    const shared = normalizeValue(structure.shared);
    if (shared) normalized.shared = shared;
    const docs = normalizeValue(structure.docs);
    if (docs) normalized.docs = docs;
    const tests = normalizeValue(structure.tests);
    if (tests) normalized.tests = tests;

    if (structure.custom && typeof structure.custom === 'object') {
      const customEntries = Object.entries(structure.custom)
        .map(([key, value]) => [key, normalizeValue(value)] as const)
        .filter(([, value]) => Boolean(value));
      if (customEntries.length > 0) {
        normalized.custom = Object.fromEntries(customEntries) as Record<string, string>;
      }
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private detectExistingStructure(): PlannerOutput['projectStructure'] | undefined {
    const root = this.cwd;
    if (!root) return undefined;

    const isDirectory = (relativePath: string): boolean => {
      const target = join(root, relativePath);
      if (!existsSync(target)) return false;
      try {
        return statSync(target).isDirectory();
      } catch {
        return false;
      }
    };

    const pickFirst = (candidates: string[]): string | undefined =>
      candidates.find((candidate) => isDirectory(candidate));

    const structure: ProjectStructure = {};
    const frontend = pickFirst([
      'frontend',
      'client',
      'web',
      'app',
      'ui',
      'apps/web',
      'apps/frontend',
      'packages/web',
      'packages/frontend',
    ]);
    if (frontend) structure.frontend = frontend;

    const backend = pickFirst([
      'backend',
      'server',
      'api',
      'services/api',
      'services/backend',
      'packages/api',
    ]);
    if (backend) structure.backend = backend;

    const shared = pickFirst(['shared', 'common', 'packages/shared', 'packages/common']);
    if (shared) structure.shared = shared;

    const docs = pickFirst(['docs', 'documentation']);
    if (docs) structure.docs = docs;

    const tests = pickFirst(['tests', 'test']);
    if (tests) structure.tests = tests;

    return Object.keys(structure).length > 0 ? structure : undefined;
  }

  /**
   * P4: 生成目录约束字符串
   */
  private generateDirectoryConstraints(
    structure: NonNullable<PlannerOutput['projectStructure']>
  ): string[] {
    const constraints: string[] = [];
    
    if (structure.frontend && structure.backend) {
      constraints.push(
        `CRITICAL: Use consistent directory names - Frontend code in '${structure.frontend}/', Backend code in '${structure.backend}/'. Do NOT create alternative names like 'fastapi_backend' or 'react_frontend'.`
      );
    } else if (structure.frontend) {
      constraints.push(
        `Use '${structure.frontend}/' as the main source directory.`
      );
    } else if (structure.backend) {
      constraints.push(
        `Use '${structure.backend}/' as the main source directory.`
      );
    }
    
    if (structure.tests) {
      constraints.push(`Place tests in '${structure.tests}/' directory.`);
    }
    
    return constraints;
  }

  /**
   * 计算委托配置
   */
  private calculateDelegationConfig(
    subtasks: SubTask[],
    executionPlan: ExecutionPlan,
    complexity: OrchestratorTask['complexity'],
    contextConstraints?: PlannerInput['contextConstraints']
  ): DelegationConfig {
    // 基于复杂度和子任务数量计算 Worker 数量
    const workerCount = this.calculateWorkerCount(subtasks.length, complexity, executionPlan.isParallel);

    // 基于复杂度和子任务数量计算超时时间
    let timeout = this.calculateTimeout(subtasks, complexity);

    // 应用上下文约束
    if (contextConstraints?.maxExecutionTime) {
      timeout = Math.min(timeout, contextConstraints.maxExecutionTime);
    }

    // 默认使用 communication 模式
    const mode: DelegationMode = 'communication';

    return {
      mode,
      workerCount,
      timeout,
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
  }

  /**
   * 计算 Worker 数量
   */
  private calculateWorkerCount(
    subtaskCount: number,
    complexity: OrchestratorTask['complexity'],
    isParallel: boolean
  ): number {
    if (!isParallel) {
      return 1;
    }

    // 基于复杂度的并行因子
    const parallelFactor =
      complexity === 'complex' ? 0.5 : complexity === 'moderate' ? 0.7 : 1;

    // 计算并行 Worker 数量（最少 1 个，最多与子任务数相同）
    const calculatedCount = Math.max(1, Math.ceil(subtaskCount * parallelFactor));

    // 限制最大 Worker 数量
    return Math.min(calculatedCount, DEFAULT_DELEGATION_DEFAULTS.workerCount * 3);
  }

  /**
   * 计算超时时间
   */
  private calculateTimeout(
    subtasks: SubTask[],
    complexity: OrchestratorTask['complexity']
  ): number {
    // 基于子任务预估时间计算
    const totalEstimatedDuration = subtasks.reduce(
      (sum, st) => sum + (st.estimatedDuration || 0),
      0
    );

    // 如果有预估时间，使用预估时间的 1.5 倍作为超时
    if (totalEstimatedDuration > 0) {
      return Math.max(totalEstimatedDuration * 1.5, DEFAULT_DELEGATION_DEFAULTS.timeout);
    }

    // 否则基于复杂度设置默认超时
    const complexityMultiplier =
      complexity === 'complex' ? 3 : complexity === 'moderate' ? 2 : 1;

    return DEFAULT_DELEGATION_DEFAULTS.timeout * complexityMultiplier;
  }

  /**
   * 估算 Token 使用量
   */
  private estimateTokenUsage(subtasks: SubTask[]): number {
    // 粗略估算：每个子任务约 500-1500 tokens
    const baseTokensPerSubtask = 800;
    return subtasks.length * baseTokensPerSubtask;
  }

  /**
   * 尝试降级策略
   */
  private async tryDegradation(
    opts: { mode: 'full' } | { mode: 'patch'; previousContext?: string },
    input: PlannerInput,
    currentTokens: { input: number; output: number },
    currentRetries: number
  ): Promise<PlanResult | null> {
    // 简单的降级策略：减少最大子任务数量并重试
    const degradedMaxSubtasks = Math.max(
      3,
      Math.floor((input.maxSubtasks ?? this.config.defaultMaxSubtasks) / 2)
    );

    // 如果已经是最小值，放弃降级
    if (degradedMaxSubtasks <= 3 && (input.maxSubtasks ?? this.config.defaultMaxSubtasks) <= 3) {
      return null;
    }

    try {
      const degradedInput: PlannerInput = {
        ...input,
        maxSubtasks: degradedMaxSubtasks,
        preferences: {
          ...input.preferences,
          conservativeMode: true,
        },
      };

      // 保持调用模式一致：full/patch 都按原模式降级重试
      const result =
        opts.mode === 'patch'
          ? await this.planPatch(degradedInput, opts.previousContext)
          : await this.plan(degradedInput);

      // 累加 token 使用量
      result.tokensUsed.input += currentTokens.input;
      result.tokensUsed.output += currentTokens.output;
      result.retryCount += currentRetries;
      result.degraded = true;

      return result;
    } catch {
      return null;
    }
  }

  /**
   * 获取配置
   */
  getConfig(): PlannerConfig {
    return { ...this.config };
  }

  /**
   * 检查 LLM 客户端是否可用
   */
  isAvailable(): boolean {
    return this.llmClient.isAvailable();
  }

  /**
   * 关闭 Planner 资源（释放 MemoryService 连接）
   * 
   * 必须在 Planner 不再使用后调用，以释放 Redis/LevelDB/Vector 连接
   */
  async close(): Promise<void> {
    if (this.memoryService) {
      await this.memoryService.close();
      console.debug('[Planner] MemoryService closed');
    }
  }

  /**
   * 获取内存指标
   * 
   * @returns Memory metrics with hitRate computed
   */
  getMemoryMetrics(): {
    retrievalCount: number;
    hitCount: number;
    hitRate: number;
    tokensSaved: number;
    totalLatencyMs: number;
  } {
    const { retrievalCount, hitCount, tokensSaved, totalLatencyMs } = this.memoryMetrics;
    return {
      retrievalCount,
      hitCount,
      hitRate: retrievalCount > 0 ? hitCount / retrievalCount : 0,
      tokensSaved,
      totalLatencyMs,
    };
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Planner 实例
 *
 * @param options - Planner 选项
 * @returns Planner 实例
 */
export function createPlanner(options?: PlannerOptions): Planner {
  return new Planner(options);
}

/**
 * Planner Prompt 模板
 *
 * 定义任务规划的 System Prompt 和 User Prompt 模板
 */

import type { PromptVariables, PatchPromptVariables, ErrorFeedbackVariables } from './types';
import type { SubTask, ExecutionPlan } from '../orchestrator';

// ============================================================================
// 输出格式定义
// ============================================================================

/**
 * 规划输出格式 - 用于 LLM 结构化输出
 */
export interface PlanningOutputFormat {
  /** 简要说明（不要输出详细逐步推理） */
  reasoning: string;
  /** 子任务列表 */
  subtasks: {
    /** 子任务 ID（格式：subtask-1, subtask-2, ...） */
    id: string;
    /** 子任务目标 */
    objective: string;
    /** 约束条件 */
    constraints: string[];
    /** 预估执行时间（分钟） */
    estimatedMinutes: number;
    /** 依赖的其他子任务 ID */
    dependencies: string[];
  }[];
  /** 执行计划 */
  executionPlan: {
    /** 是否可并行 */
    isParallel: boolean;
    /** 执行步骤 */
    steps: {
      /** 步骤序号 */
      order: number;
      /** 该步骤包含的子任务 ID */
      subtaskIds: string[];
      /** 是否可并行执行 */
      parallel: boolean;
    }[];
  };
  /** 预估总执行时间（分钟） */
  estimatedTotalMinutes: number;
  /** 复杂度评估（1-10） */
  complexityScore: number;
}

// ============================================================================
// System Prompt 模板
// ============================================================================

/**
 * 规划 System Prompt
 */
export const PLANNING_SYSTEM_PROMPT = `你是一个任务规划专家。你的职责是将高层任务分解为可执行的子任务，并制定详细的执行计划。

## 你的任务
1. 分析给定的任务目标和约束条件
2. 将任务分解为多个独立的、可执行的子任务
3. 确定子任务之间的依赖关系
4. 制定执行计划，明确执行顺序和并行可能性
5. 估算每个子任务的执行时间

## 分解原则
- 每个子任务应该是独立的、可测试的单元
- 子任务粒度适中：不要太大（难以执行）也不要太小（过于琐碎）
- 明确标注子任务之间的依赖关系
- 尽可能识别可并行执行的子任务
- 考虑失败场景和回退策略

## 大文件创建策略（重要）
当任务涉及创建大型代码文件（>80行）时，必须采用分阶段方式：

**阶段 1：创建骨架**
- 子任务：创建文件基本结构（导入、类/函数签名、空实现）
- 预估：5分钟

**阶段 2+：逐步填充**
- 每个子任务只负责实现一个函数/方法的完整内容
- 使用 apply_patch 工具进行增量修改
- 避免在单个子任务中输出超过 30 行代码

这种方法可以防止 LLM 输出被截断导致的执行失败。

## 输出要求
你必须以 JSON 格式输出，包含以下字段：
- reasoning: 简要说明你的拆解依据（1-3 句即可，不要输出详细逐步推理）
- subtasks: 子任务列表，每个子任务包含 id、objective、constraints、estimatedMinutes、dependencies
- executionPlan: 执行计划，包含 isParallel、steps
- estimatedTotalMinutes: 预估总执行时间
- complexityScore: 复杂度评估（1-10）

## 注意事项
- 严格遵循 JSON 格式，不要添加额外的文本
- 子任务 ID 格式为 subtask-1, subtask-2, ...
- dependencies 数组包含依赖的子任务 ID
- 执行步骤中，同一步骤的子任务可以并行执行`;

/**
 * Patch 规划 System Prompt
 *
 * 用于在已有产出基础上做“增量修改”，要求生成最小 delta 计划，避免重做已完成工作。
 */
export const PATCH_PLANNING_SYSTEM_PROMPT = `你是一个增量修改（patch）任务规划专家。你的职责是在已有工作成果基础上，生成最小的可执行变更计划。

## 你的任务
1. 理解用户提出的“修改/调整”目标
2. 读取“之前的计划与产出上下文”，判断哪些已完成、哪些需要改
3. 只生成必要的 delta 子任务（避免重做完整实现）
4. 尽可能复用现有文件与结构，优先使用增量修改（apply_patch）而不是重写
5. 输出可执行、可测试、可回滚的步骤

## 分解原则（增量优先）
- 默认不要创建新架构，除非修改目标明确要求
- 优先修改最近受影响的文件/模块
- 子任务数量尽量少：小改动通常 1-3 个子任务即可
- 若需要大改动，仍遵循“大文件分阶段策略”，但只覆盖变更相关部分

## 输出要求
你必须以 JSON 格式输出，包含以下字段：
- reasoning: 简要说明你的拆解依据（1-3 句即可，不要输出详细逐步推理）
- subtasks: 子任务列表，每个子任务包含 id、objective、constraints、estimatedMinutes、dependencies
- executionPlan: 执行计划，包含 isParallel、steps
- estimatedTotalMinutes: 预估总执行时间
- complexityScore: 复杂度评估（1-10）

## 注意事项
- 严格遵循 JSON 格式，不要添加额外的文本
- 子任务 ID 格式为 subtask-1, subtask-2, ...
- 只生成“必要的修改”相关子任务`;

/**
 * 生成规划 User Prompt
 */
export function generatePlanningUserPrompt(variables: PromptVariables): string {
  const { objective, constraints, availableTools, maxSubtasks, additionalContext } = variables;

  let prompt = `请分析并分解以下任务：

## 任务目标
${objective}

## 约束条件
${constraints.length > 0 ? constraints.map((c, i) => `${i + 1}. ${c}`).join('\n') : '无特殊约束'}
`;

  if (availableTools && availableTools.length > 0) {
    prompt += `
## 可用工具
${availableTools.map((t) => `- ${t}`).join('\n')}
`;
  }

  if (maxSubtasks) {
    prompt += `
## 子任务数量限制
最多生成 ${maxSubtasks} 个子任务
`;
  }

  if (additionalContext) {
    prompt += `
## 额外上下文
${additionalContext}
`;
  }

  prompt += `
## 输出格式
请以 JSON 格式输出，不要包含任何其他文本。JSON 应该包含以下结构：
\`\`\`json
{
  "reasoning": "简要说明你的拆解依据（1-3 句）...",
  "subtasks": [
    {
      "id": "subtask-1",
      "objective": "子任务目标",
      "constraints": ["约束1", "约束2"],
      "estimatedMinutes": 10,
      "dependencies": []
    }
  ],
  "executionPlan": {
    "isParallel": false,
    "steps": [
      {
        "order": 1,
        "subtaskIds": ["subtask-1"],
        "parallel": false
      }
    ]
  },
  "estimatedTotalMinutes": 30,
  "complexityScore": 5
}
\`\`\``;

  return prompt;
}

/**
 * 生成 Patch 规划 User Prompt
 */
export function generatePatchPlanningUserPrompt(variables: PatchPromptVariables): string {
  const {
    objective,
    constraints,
    availableTools,
    maxSubtasks,
    additionalContext,
    previousContext,
  } = variables;

  let prompt = `请基于已有工作成果，对以下修改请求生成最小的变更计划：

## 修改目标
${objective}

## 约束条件
${constraints.length > 0 ? constraints.map((c, i) => `${i + 1}. ${c}`).join('\n') : '无特殊约束'}
`;

  if (previousContext) {
    prompt += `
## 之前的计划与产出上下文（供参考）
${previousContext}
`;
  }

  if (availableTools && availableTools.length > 0) {
    prompt += `
## 可用工具
${availableTools.map((t) => `- ${t}`).join('\n')}
`;
  }

  if (maxSubtasks) {
    prompt += `
## 子任务数量限制
最多生成 ${maxSubtasks} 个子任务（请尽量少）
`;
  }

  if (additionalContext) {
    prompt += `
## 额外上下文
${additionalContext}
`;
  }

  prompt += `
## 输出格式
请以 JSON 格式输出，不要包含任何其他文本。JSON 应该包含以下结构：
\`\`\`json
{
  "reasoning": "简要说明你的拆解依据（1-3 句）...",
  "subtasks": [
    {
      "id": "subtask-1",
      "objective": "子任务目标",
      "constraints": ["约束1", "约束2"],
      "estimatedMinutes": 10,
      "dependencies": []
    }
  ],
  "executionPlan": {
    "isParallel": false,
    "steps": [
      {
        "order": 1,
        "subtaskIds": ["subtask-1"],
        "parallel": false
      }
    ]
  },
  "estimatedTotalMinutes": 30,
  "complexityScore": 5
}
\`\`\``;

  return prompt;
}

// ============================================================================
// 错误反馈 Prompt
// ============================================================================

/**
 * 生成解析错误反馈 Prompt
 */
export function generateErrorFeedbackPrompt(variables: ErrorFeedbackVariables): string {
  const { originalResponse, parseError, retryCount } = variables;

  return `你的上一次响应无法正确解析。请修正并重新输出。

## 错误信息
${parseError}

## 你的原始响应
${originalResponse.slice(0, 1000)}${originalResponse.length > 1000 ? '...(已截断)' : ''}

## 重试次数
这是第 ${retryCount} 次重试。

## 要求
1. 请确保输出是有效的 JSON 格式
2. 不要在 JSON 前后添加任何文本或代码块标记
3. 确保所有必需字段都存在
4. 确保数据类型正确（字符串、数组、数字等）

请直接输出正确的 JSON：`;
}

// ============================================================================
// 输出解析辅助函数
// ============================================================================

/**
 * 从 LLM 响应中提取 JSON
 *
 * P1 修复：改进 JSON 边界检测，避免截取不完整的 JSON
 *
 * 支持以下格式：
 * 1. Markdown 代码块包裹的 JSON（优先）
 * 2. 使用括号匹配找到完整的 JSON 对象
 * 3. 带有前后文本的 JSON
 */
export function extractJsonFromResponse(response: string): string {
  // 1. 优先尝试提取 Markdown 代码块中的 JSON
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    const content = codeBlockMatch[1].trim();
    // 确保提取的内容以 { 开头
    if (content.startsWith('{')) {
      return content;
    }
  }

  // 2. 使用括号匹配找到完整的 JSON 对象边界
  const startIdx = response.indexOf('{');
  if (startIdx === -1) {
    return response.trim();
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < response.length; i++) {
    const char = response[i];

    // 处理转义字符
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    // 处理字符串边界
    if (char === '"') {
      inString = !inString;
      continue;
    }

    // 只有在非字符串中才计算括号
    if (!inString) {
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          // 找到完整的 JSON 对象
          return response.slice(startIdx, i + 1);
        }
      }
    }
  }

  // 3. 如果括号匹配失败，回退到贪婪正则
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }

  // 4. 如果都没找到，返回原始响应
  return response.trim();
}

/**
 * 将规划输出转换为 SubTask 数组
 */
export function convertToSubTasks(
  output: PlanningOutputFormat,
  parentId: string
): SubTask[] {
  return output.subtasks.map((st) => ({
    id: st.id,
    parentId,
    objective: st.objective,
    constraints: st.constraints,
    estimatedDuration: st.estimatedMinutes * 60 * 1000, // 转换为毫秒
    dependencies: st.dependencies,
    status: 'pending' as const,
  }));
}

/**
 * 将规划输出转换为 ExecutionPlan
 */
export function convertToExecutionPlan(output: PlanningOutputFormat): ExecutionPlan {
  return {
    isParallel: output.executionPlan.isParallel,
    steps: output.executionPlan.steps.map((step) => ({
      order: step.order,
      subtaskIds: step.subtaskIds,
      parallel: step.parallel,
    })),
  };
}

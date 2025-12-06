/**
 * Planner Prompt 模板
 *
 * 定义任务规划的 System Prompt 和 User Prompt 模板
 */

import type { PromptVariables, ErrorFeedbackVariables } from './types';
import type { SubTask, ExecutionPlan } from '../orchestrator';

// ============================================================================
// 输出格式定义
// ============================================================================

/**
 * 规划输出格式 - 用于 LLM 结构化输出
 */
export interface PlanningOutputFormat {
  /** 推理过程（Chain-of-Thought） */
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

## 输出要求
你必须以 JSON 格式输出，包含以下字段：
- reasoning: 你的推理过程（Chain-of-Thought）
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
  "reasoning": "你的推理过程...",
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

/**
 * Subtask Validator
 *
 * 验证子任务是否可能导致输出截断，并提供优化建议
 */

/**
 * 可能导致大输出的关键词
 */
const LARGE_OUTPUT_KEYWORDS = [
  '创建', 'create', '编写', 'write', '实现', 'implement',
  '完整', 'complete', 'full', 'entire', '所有', 'all',
  '页面', 'page', '组件', 'component', '模块', 'module',
  '样式', 'style', 'css', 'html',
];

/**
 * 表示增量操作的关键词
 */
const INCREMENTAL_KEYWORDS = [
  '修改', 'modify', '更新', 'update', '添加', 'add',
  '删除', 'delete', 'remove', '修复', 'fix', '调整', 'adjust',
  '替换', 'replace', '重命名', 'rename',
];

/**
 * 验证结果
 */
export interface SubtaskValidationResult {
  /** 是否有效（不太可能导致截断） */
  isValid: boolean;
  /** 风险等级 (0-10) */
  riskLevel: number;
  /** 风险原因 */
  riskReasons: string[];
  /** 优化建议 */
  suggestions: string[];
  /** 推荐使用的工具（如果适用） */
  recommendedTools?: string[];
}

/**
 * 分析子任务目标，检测潜在的输出截断风险
 */
export function validateSubtask(
  objective: string,
  constraints: string[] = []
): SubtaskValidationResult {
  const lowerObjective = objective.toLowerCase();
  const lowerConstraints = constraints.map(c => c.toLowerCase()).join(' ');
  const fullText = `${lowerObjective} ${lowerConstraints}`;
  
  const riskReasons: string[] = [];
  const suggestions: string[] = [];
  const recommendedTools: string[] = [];
  let riskLevel = 0;
  
  // 检查是否涉及创建新文件
  const isCreating = LARGE_OUTPUT_KEYWORDS.some(kw => lowerObjective.includes(kw));
  const isIncremental = INCREMENTAL_KEYWORDS.some(kw => lowerObjective.includes(kw));
  
  // 检查是否提及行数或大小
  const mentionsLines = /(\d+)\s*(行|lines?|代码)/i.exec(fullText);
  const mentionsLarge = /(大|large|big|完整|complete|full)/i.test(fullText);
  
  // 检查是否已经约束使用增量工具
  const hasIncrementalConstraint = 
    /apply_patch|replace_between|增量|incremental/i.test(fullText);
  
  // 风险评估
  if (isCreating && !isIncremental) {
    riskLevel += 4;
    riskReasons.push('任务涉及创建内容而非增量修改');
    
    if (!hasIncrementalConstraint) {
      suggestions.push('添加约束：使用 apply_patch 工具进行修改');
      recommendedTools.push('apply_patch');
    }
  }
  
  if (mentionsLines && mentionsLines[1]) {
    const lineCount = parseInt(mentionsLines[1], 10);
    if (lineCount > 30) {
      riskLevel += 3;
      riskReasons.push(`任务提及创建 ${lineCount} 行代码`);
      suggestions.push('考虑拆分为多个更小的子任务');
    }
  }
  
  if (mentionsLarge) {
    riskLevel += 2;
    riskReasons.push('任务描述暗示大量输出');
    suggestions.push('明确限制输出范围');
  }
  
  // 检查是否涉及特定文件类型
  const fileTypeMatch = /\.(html|css|js|ts|tsx|jsx|vue|svelte)/i.exec(fullText);
  if (fileTypeMatch && isCreating) {
    riskLevel += 2;
    riskReasons.push(`创建完整的 ${fileTypeMatch[1]} 文件可能导致输出过长`);
    suggestions.push('先创建骨架，再逐步填充内容');
    recommendedTools.push('file_write', 'apply_patch');
  }
  
  // 如果已有增量约束，降低风险
  if (hasIncrementalConstraint) {
    riskLevel = Math.max(0, riskLevel - 3);
  }
  
  // 限制风险等级范围
  riskLevel = Math.min(10, Math.max(0, riskLevel));
  
  const result: SubtaskValidationResult = {
    isValid: riskLevel <= 4,
    riskLevel,
    riskReasons,
    suggestions,
  };
  
  if (recommendedTools.length > 0) {
    result.recommendedTools = recommendedTools;
  }
  
  return result;
}

/**
 * 批量验证子任务
 */
export function validateSubtasks(
  subtasks: { objective: string; constraints: string[] }[]
): Map<number, SubtaskValidationResult> {
  const results = new Map<number, SubtaskValidationResult>();
  
  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];
    if (subtask) {
      results.set(i, validateSubtask(subtask.objective, subtask.constraints));
    }
  }
  
  return results;
}

/**
 * 为子任务注入推荐工具约束
 */
export function injectToolRecommendations(
  subtasks: { objective: string; constraints: string[] }[]
): { objective: string; constraints: string[] }[] {
  return subtasks.map(subtask => {
    const validation = validateSubtask(subtask.objective, subtask.constraints);
    
    if (!validation.isValid && validation.recommendedTools) {
      // 只有在风险高且有推荐工具时才注入
      const existingConstraints = subtask.constraints || [];
      const toolConstraint = `推荐工具：${validation.recommendedTools.join(', ')}`;
      
      // 避免重复添加
      if (!existingConstraints.some(c => c.includes('推荐工具'))) {
        return {
          ...subtask,
          constraints: [...existingConstraints, toolConstraint],
        };
      }
    }
    
    return subtask;
  });
}

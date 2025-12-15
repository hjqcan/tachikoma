/**
 * Task Generator
 *
 * 使用 LLM 将实现计划分解为可执行任务
 */

import type { TaskInput, TaskBreakdown, SpecTask } from '../types';
import type { LLMClient } from '../../planner/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Task Generator 配置
 */
export interface TaskGeneratorConfig {
  /** LLM 客户端 */
  llmClient: LLMClient;
}

/**
 * 任务验证结果
 */
export interface TaskValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// 常量
// ============================================================================

const SYSTEM_PROMPT = `You are a project manager breaking down implementation plans into actionable tasks.

Create a detailed task breakdown that developers can execute. Each task should be specific, actionable, and have clear deliverables.

Output your response in valid JSON format:
{
  "tasks": [
    {
      "id": "task-001",
      "userStoryId": "US-001",
      "title": "Create project structure",
      "description": "Initialize the project with required configuration files",
      "filePaths": ["package.json", "tsconfig.json", "src/index.ts"],
      "dependencies": [],
      "isParallel": false,
      "testFirst": false,
      "estimatedHours": 1
    }
  ],
  "parallelGroups": [["task-002", "task-003"]]
}

Guidelines:
- Order tasks by dependencies (foundational tasks first)
- Mark tasks that can run in parallel with "isParallel": true
- Group related parallel tasks in "parallelGroups"
- If TDD is requested, set "testFirst": true for implementation tasks
- Include specific file paths where work will happen
- Keep task granularity reasonable (1-4 hours each)`;

// ============================================================================
// TaskGenerator
// ============================================================================

/**
 * Task Generator
 *
 * 将实现计划分解为可执行任务
 */
export class TaskGenerator {
  private readonly llmClient: LLMClient;

  constructor(config: TaskGeneratorConfig) {
    this.llmClient = config.llmClient;
  }

  /**
   * 生成任务分解
   */
  async generate(input: TaskInput): Promise<TaskBreakdown> {
    const userPrompt = this.buildUserPrompt(input);

    const response = await this.llmClient.complete({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 4000,
    });

    const parsed = this.parseResponse(response.content);
    const tasks = this.normalizeTasks(parsed.tasks || []);
    const rawContent = this.renderTasks(tasks, parsed.parallelGroups || []);

    return {
      planId: input.plan.specId,
      tasks,
      dependencies: tasks.map((t) => ({ taskId: t.id, dependsOn: t.dependencies })),
      parallelGroups: parsed.parallelGroups || [],
      rawContent,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * 验证任务分解
   */
  validate(breakdown: TaskBreakdown): TaskValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for duplicate IDs
    const ids = new Set<string>();
    for (const task of breakdown.tasks) {
      if (ids.has(task.id)) {
        errors.push(`Duplicate task ID: ${task.id}`);
      }
      ids.add(task.id);
    }

    // Check dependencies exist
    for (const task of breakdown.tasks) {
      for (const depId of task.dependencies) {
        if (!ids.has(depId)) {
          errors.push(`Task ${task.id} depends on non-existent task: ${depId}`);
        }
      }
    }

    // Check for circular dependencies
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (taskId: string): boolean => {
      if (recursionStack.has(taskId)) return true;
      if (visited.has(taskId)) return false;

      visited.add(taskId);
      recursionStack.add(taskId);

      const task = breakdown.tasks.find((t) => t.id === taskId);
      if (task) {
        for (const depId of task.dependencies) {
          if (hasCycle(depId)) return true;
        }
      }

      recursionStack.delete(taskId);
      return false;
    };

    for (const task of breakdown.tasks) {
      visited.clear();
      recursionStack.clear();
      if (hasCycle(task.id)) {
        errors.push(`Circular dependency detected involving task: ${task.id}`);
        break;
      }
    }

    // Warnings
    for (const task of breakdown.tasks) {
      if (!task.filePaths.length) {
        warnings.push(`Task ${task.id} has no file paths specified`);
      }
      if (!task.description) {
        warnings.push(`Task ${task.id} has no description`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  private buildUserPrompt(input: TaskInput): string {
    let prompt = `Please break down the following implementation plan into actionable tasks:\n\n`;
    prompt += input.plan.rawContent;

    if (input.useTDD) {
      prompt += `\n\n**IMPORTANT:** Use Test-Driven Development (TDD) approach. For each feature implementation task, create a corresponding test task that should be completed first.`;
    }

    return prompt;
  }

  private parseResponse(content: string): TaskData {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { tasks: [] };
    }

    try {
      return JSON.parse(jsonMatch[0]) as TaskData;
    } catch {
      return { tasks: [] };
    }
  }

  private normalizeTasks(rawTasks: RawTask[]): SpecTask[] {
    return rawTasks.map((task, index) => {
      const result: SpecTask = {
        id: task.id || `task-${String(index + 1).padStart(3, '0')}`,
        title: task.title || `Task ${index + 1}`,
        description: task.description || '',
        filePaths: task.filePaths || [],
        dependencies: task.dependencies || [],
        isParallel: task.isParallel || false,
        testFirst: task.testFirst || false,
        status: 'pending',
      };
      if (task.userStoryId) result.userStoryId = task.userStoryId;
      if (task.estimatedHours) result.estimatedHours = task.estimatedHours;
      return result;
    });
  }

  private renderTasks(tasks: SpecTask[], parallelGroups: string[][]): string {
    let md = `# Task Breakdown\n\n`;

    // Summary
    md += `**Total Tasks:** ${tasks.length}\n`;
    const parallelCount = tasks.filter((t) => t.isParallel).length;
    if (parallelCount > 0) {
      md += `**Parallelizable:** ${parallelCount}\n`;
    }
    md += '\n';

    // Group by user story if available
    const byUserStory = new Map<string, SpecTask[]>();
    const noStory: SpecTask[] = [];

    for (const task of tasks) {
      if (task.userStoryId) {
        const existing = byUserStory.get(task.userStoryId) || [];
        existing.push(task);
        byUserStory.set(task.userStoryId, existing);
      } else {
        noStory.push(task);
      }
    }

    // Render grouped tasks
    if (byUserStory.size > 0) {
      for (const [storyId, storyTasks] of byUserStory) {
        md += `## ${storyId}\n\n`;
        md += this.renderTaskList(storyTasks);
      }
    }

    // Render ungrouped tasks
    if (noStory.length > 0) {
      if (byUserStory.size > 0) {
        md += `## Other Tasks\n\n`;
      }
      md += this.renderTaskList(noStory);
    }

    // Parallel groups
    if (parallelGroups.length > 0) {
      md += `## Parallel Execution Groups\n\n`;
      for (let i = 0; i < parallelGroups.length; i++) {
        const group = parallelGroups[i];
        if (group) {
          md += `**Group ${i + 1}:** ${group.join(', ')}\n`;
        }
      }
      md += '\n';
    }

    return md;
  }

  private renderTaskList(tasks: SpecTask[]): string {
    let md = '';
    for (const task of tasks) {
      const markers: string[] = [];
      if (task.isParallel) markers.push('[P]');
      if (task.testFirst) markers.push('[TDD]');
      const markerStr = markers.length > 0 ? ` ${markers.join(' ')}` : '';

      md += `- [ ] **${task.id}**: ${task.title}${markerStr}\n`;
      if (task.description) {
        md += `  ${task.description}\n`;
      }
      if (task.filePaths.length > 0) {
        md += `  Files: \`${task.filePaths.join('`, `')}\`\n`;
      }
      if (task.dependencies.length > 0) {
        md += `  Depends on: ${task.dependencies.join(', ')}\n`;
      }
      if (task.estimatedHours) {
        md += `  Estimated: ${task.estimatedHours}h\n`;
      }
      md += '\n';
    }
    return md;
  }
}

// ============================================================================
// 内部类型
// ============================================================================

interface TaskData {
  tasks?: RawTask[];
  parallelGroups?: string[][];
}

interface RawTask {
  id?: string;
  userStoryId?: string;
  title?: string;
  description?: string;
  filePaths?: string[];
  dependencies?: string[];
  isParallel?: boolean;
  testFirst?: boolean;
  estimatedHours?: number;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Task Generator
 */
export function createTaskGenerator(config: TaskGeneratorConfig): TaskGenerator {
  return new TaskGenerator(config);
}

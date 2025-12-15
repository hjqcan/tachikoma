/**
 * SpecKit Workflow Engine
 *
 * 封装完整的 Spec-Driven Development 工作流
 */

import type {
  Constitution,
  Specification,
  ImplementationPlan,
  TaskBreakdown,
  ConstitutionInput,
  SpecificationInput,
  PlanInput,
  TaskInput,
} from './types';
import type { SpecKitFileManager } from './file-manager';
import type { LLMClient } from '../planner/types';
import {
  ConstitutionGenerator,
  SpecificationGenerator,
  PlanGenerator,
  TaskGenerator,
} from './generators';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * SpecKit 工作流配置
 */
export interface SpecKitWorkflowConfig {
  /** LLM 客户端 */
  llmClient: LLMClient;
  /** 文件管理器 */
  fileManager: SpecKitFileManager;
}

/**
 * 工作流执行结果
 */
export interface WorkflowResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  filePath?: string;
}

// ============================================================================
// SpecKitWorkflow
// ============================================================================

/**
 * SpecKit 工作流引擎
 *
 * 提供完整的 Spec-Driven Development 工作流操作
 */
export class SpecKitWorkflow {
  private readonly fileManager: SpecKitFileManager;
  private readonly constitutionGenerator: ConstitutionGenerator;
  private readonly specificationGenerator: SpecificationGenerator;
  private readonly planGenerator: PlanGenerator;
  private readonly taskGenerator: TaskGenerator;

  constructor(config: SpecKitWorkflowConfig) {
    this.fileManager = config.fileManager;
    this.constitutionGenerator = new ConstitutionGenerator({ llmClient: config.llmClient });
    this.specificationGenerator = new SpecificationGenerator({ llmClient: config.llmClient });
    this.planGenerator = new PlanGenerator({ llmClient: config.llmClient });
    this.taskGenerator = new TaskGenerator({ llmClient: config.llmClient });
  }

  // ==========================================================================
  // Constitution 工作流
  // ==========================================================================

  /**
   * 创建或更新项目宪法
   */
  async constitution(prompt: string): Promise<WorkflowResult<Constitution>> {
    try {
      // 检查是否已存在宪法
      const existing = await this.fileManager.readConstitution();

      let constitution: Constitution;
      if (existing) {
        // 根据反馈细化现有宪法
        constitution = await this.constitutionGenerator.refine(existing, prompt);
      } else {
        // 创建新宪法
        const input: ConstitutionInput = { prompt };
        constitution = await this.constitutionGenerator.generate(input);
      }

      // 写入文件
      await this.fileManager.writeConstitution(constitution);

      return {
        success: true,
        data: constitution,
        filePath: this.fileManager.getConstitutionPath(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==========================================================================
  // Specification 工作流
  // ==========================================================================

  /**
   * 创建功能规范
   */
  async specify(prompt: string, specId?: string): Promise<WorkflowResult<Specification>> {
    try {
      // 读取项目宪法
      const constitution = await this.fileManager.readConstitution();

      const input: SpecificationInput = { prompt };
      if (specId) input.specId = specId;
      if (constitution) input.constitution = constitution;

      const specification = await this.specificationGenerator.generate(input);

      // 写入文件
      await this.fileManager.writeSpec(specification);

      return {
        success: true,
        data: specification,
        filePath: this.fileManager.getSpecFilePath(specification.id),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==========================================================================
  // Plan 工作流
  // ==========================================================================

  /**
   * 为规范生成实现计划
   */
  async plan(specId: string, techStackPrompt: string): Promise<WorkflowResult<ImplementationPlan>> {
    try {
      // 读取规范
      const specification = await this.fileManager.readSpec(specId);
      if (!specification) {
        return {
          success: false,
          error: `Specification not found: ${specId}`,
        };
      }

      // 读取宪法
      const constitution = await this.fileManager.readConstitution();

      const input: PlanInput = { specification, techStackPrompt };
      if (constitution) input.constitution = constitution;

      const plan = await this.planGenerator.generate(input);

      // 写入文件
      await this.fileManager.writePlan(plan);

      return {
        success: true,
        data: plan,
        filePath: this.fileManager.getPlanFilePath(specId),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==========================================================================
  // Tasks 工作流
  // ==========================================================================

  /**
   * 为计划生成任务分解
   */
  async tasks(specId: string, useTDD = false): Promise<WorkflowResult<TaskBreakdown>> {
    try {
      // 读取计划
      const plan = await this.fileManager.readPlan(specId);
      if (!plan) {
        return {
          success: false,
          error: `Plan not found for spec: ${specId}`,
        };
      }

      const input: TaskInput = {
        plan,
        useTDD,
      };

      const breakdown = await this.taskGenerator.generate(input);

      // 验证任务分解
      const validation = this.taskGenerator.validate(breakdown);
      if (!validation.valid) {
        return {
          success: false,
          error: `Task validation failed: ${validation.errors.join(', ')}`,
        };
      }

      // 写入文件
      await this.fileManager.writeTasks(breakdown);

      return {
        success: true,
        data: breakdown,
        filePath: this.fileManager.getTasksFilePath(specId),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==========================================================================
  // 辅助方法
  // ==========================================================================

  /**
   * 获取工作流状态
   */
  async getStatus(specId: string): Promise<{
    hasConstitution: boolean;
    hasSpec: boolean;
    hasPlan: boolean;
    hasTasks: boolean;
  }> {
    const constitution = await this.fileManager.readConstitution();
    const spec = await this.fileManager.readSpec(specId);
    const plan = await this.fileManager.readPlan(specId);
    const tasks = await this.fileManager.readTasks(specId);

    return {
      hasConstitution: constitution !== null,
      hasSpec: spec !== null,
      hasPlan: plan !== null,
      hasTasks: tasks !== null,
    };
  }

  /**
   * 列出所有规范
   */
  async listSpecs() {
    return this.fileManager.listSpecs();
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 SpecKit 工作流引擎
 */
export function createSpecKitWorkflow(config: SpecKitWorkflowConfig): SpecKitWorkflow {
  return new SpecKitWorkflow(config);
}

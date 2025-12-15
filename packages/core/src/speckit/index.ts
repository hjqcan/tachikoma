/**
 * SpecKit 模块
 *
 * Spec-Driven Development 工具包
 *
 * 提供结构化的开发流程：
 * 1. Constitution - 建立项目治理原则
 * 2. Specify - 定义功能规范（What & Why）
 * 3. Plan - 生成技术实现计划
 * 4. Tasks - 分解为可执行任务
 * 5. Implement - 系统化执行任务
 *
 * @packageDocumentation
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // Config
  SpecKitConfig,
  SpecKitInitOptions,
  SpecKitPhase,
  // Constitution
  Constitution,
  ConstitutionInput,
  CodeQualityGuidelines,
  TestingStandards,
  UXGuidelines,
  PerformanceRequirements,
  // Specification
  Specification,
  SpecificationInput,
  UserStory,
  DataModel,
  DataModelEntity,
  DataModelField,
  // Plan
  ImplementationPlan,
  PlanInput,
  TechStackConfig,
  ArchitectureDecisions,
  ImplementationPhase,
  APIContract,
  APIEndpoint,
  ResearchNotes,
  // Tasks
  TaskBreakdown,
  TaskInput,
  SpecTask,
  SpecTaskStatus,
  TaskDependency,
  // Execution
  SpecEvent,
  SpecEventType,
  SpecValidationCheck,
} from './types';

// ============================================================================
// 常量
// ============================================================================

/** 默认 SpecKit 根目录 */
export const DEFAULT_SPECKIT_ROOT = '.tachikoma/speckit';

/** SpecKit 目录结构 */
export const SPECKIT_DIRS = {
  memory: 'memory',
  specs: 'specs',
  templates: 'templates',
} as const;

/** SpecKit 文件名 */
export const SPECKIT_FILES = {
  constitution: 'constitution.md',
  spec: 'spec.md',
  dataModel: 'data-model.md',
  plan: 'plan.md',
  research: 'research.md',
  tasks: 'tasks.md',
} as const;

// ============================================================================
// File Manager
// ============================================================================

export {
  SpecKitFileManager,
  createSpecKitFileManager,
  type SpecKitFileManagerConfig,
  type SpecDirInfo,
} from './file-manager';

// ============================================================================
// Generators
// ============================================================================

export {
  ConstitutionGenerator,
  createConstitutionGenerator,
  type ConstitutionGeneratorConfig,
  SpecificationGenerator,
  createSpecificationGenerator,
  type SpecificationGeneratorConfig,
  PlanGenerator,
  createPlanGenerator,
  type PlanGeneratorConfig,
  TaskGenerator,
  createTaskGenerator,
  type TaskGeneratorConfig,
  type TaskValidationResult,
} from './generators';

// ============================================================================
// Orchestrator（后续实现）
// ============================================================================

// export { SpecOrchestrator, createSpecOrchestrator } from './spec-orchestrator';

// ============================================================================
// Templates
// ============================================================================

export {
  loadTemplate,
  renderTemplate,
  loadAndRenderTemplate,
  getAvailableTemplates,
  hasTemplate,
  type TemplateName,
  type TemplateVariables,
} from './templates';

// ============================================================================
// Workflow
// ============================================================================

export {
  SpecKitWorkflow,
  createSpecKitWorkflow,
  type SpecKitWorkflowConfig,
  type WorkflowResult,
} from './workflow';

// ============================================================================
// Adapters
// ============================================================================

export {
  PlannerAdapter,
  createPlannerAdapter,
  type PlannerAdapterConfig,
  type ConversionOptions,
  SpecKitOrchestratorHelper,
  createSpecKitOrchestratorHelper,
  type SpecOrchestratorConfig,
  type SpecExecutionOptions,
  type SpecExecutionProgress,
  type SpecValidationResult,
  type SpecConversionOutput,
} from './adapters';

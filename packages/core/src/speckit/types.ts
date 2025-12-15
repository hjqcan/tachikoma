/**
 * SpecKit 类型定义
 *
 * Spec-Driven Development 核心类型
 */

// ============================================================================
// 基础类型
// ============================================================================

/**
 * SpecKit 配置
 */
export interface SpecKitConfig {
  /** 工作目录 */
  workDir: string;
  /** SpecKit 根目录（默认 .tachikoma/speckit） */
  rootDir?: string;
  /** 是否启用 */
  enabled?: boolean;
}

/**
 * 代码质量规范
 */
export interface CodeQualityGuidelines {
  /** 代码风格 */
  codeStyle?: string;
  /** 命名约定 */
  namingConventions?: string;
  /** 文档要求 */
  documentationRequirements?: string;
  /** 错误处理策略 */
  errorHandling?: string;
}

/**
 * 测试标准
 */
export interface TestingStandards {
  /** 覆盖率要求 */
  coverageRequirements?: string;
  /** 测试类型要求 */
  testTypes?: string[];
  /** TDD 策略 */
  tddApproach?: string;
}

/**
 * UX 一致性规范
 */
export interface UXGuidelines {
  /** 设计原则 */
  designPrinciples?: string[];
  /** 可访问性要求 */
  accessibility?: string;
  /** 响应式设计要求 */
  responsiveness?: string;
}

/**
 * 性能要求
 */
export interface PerformanceRequirements {
  /** 加载时间目标 */
  loadTimeTargets?: string;
  /** 内存限制 */
  memoryLimits?: string;
  /** 优化策略 */
  optimizationStrategies?: string[];
}

// ============================================================================
// Constitution（项目宪法）
// ============================================================================

/**
 * 项目宪法/治理原则
 */
export interface Constitution {
  /** 版本号 */
  version: string;
  /** 核心原则列表 */
  principles: string[];
  /** 代码质量规范 */
  codeQuality?: CodeQualityGuidelines;
  /** 测试标准 */
  testingStandards?: TestingStandards;
  /** UX 一致性规范 */
  uxConsistency?: UXGuidelines;
  /** 性能要求 */
  performance?: PerformanceRequirements;
  /** 完整 Markdown 内容 */
  rawContent: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/**
 * Constitution 生成输入
 */
export interface ConstitutionInput {
  /** 用户提供的原则描述 */
  prompt: string;
  /** 项目名称 */
  projectName?: string;
  /** 现有宪法（用于细化） */
  existing?: Constitution;
}

// ============================================================================
// Specification（功能规范）
// ============================================================================

/**
 * 用户故事
 */
export interface UserStory {
  /** 故事 ID */
  id: string;
  /** 作为...我希望...以便... */
  description: string;
  /** 验收标准 */
  acceptanceCriteria: string[];
  /** 优先级 */
  priority?: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * 数据模型字段
 */
export interface DataModelField {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}

/**
 * 数据模型实体
 */
export interface DataModelEntity {
  name: string;
  description?: string;
  fields: DataModelField[];
  relationships?: string[];
}

/**
 * 数据模型
 */
export interface DataModel {
  entities: DataModelEntity[];
  diagram?: string; // Mermaid 格式
}

/**
 * 功能规范
 */
export interface Specification {
  /** 规范 ID（如 001-photo-albums） */
  id: string;
  /** 规范名称 */
  name: string;
  /** 简短描述 */
  description: string;
  /** 用户故事列表 */
  userStories: UserStory[];
  /** 验收标准 */
  acceptanceCriteria: string[];
  /** 超出范围的内容 */
  outOfScope: string[];
  /** 数据模型 */
  dataModel?: DataModel;
  /** 完整 Markdown 内容 */
  rawContent: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/**
 * Specification 生成输入
 */
export interface SpecificationInput {
  /** 自然语言需求描述 */
  prompt: string;
  /** 规范 ID */
  specId?: string;
  /** 项目宪法（用于约束） */
  constitution?: Constitution;
}

// ============================================================================
// Implementation Plan（实现计划）
// ============================================================================

/**
 * 技术栈配置
 */
export interface TechStackConfig {
  /** 运行时/框架 */
  runtime?: string;
  /** 前端技术 */
  frontend?: string;
  /** 后端技术 */
  backend?: string;
  /** 数据库 */
  database?: string;
  /** 其他依赖 */
  dependencies?: string[];
  /** 完整描述 */
  description?: string;
}

/**
 * 架构决策
 */
export interface ArchitectureDecisions {
  /** 架构模式 */
  pattern?: string;
  /** 关键决策 */
  decisions: string[];
  /** 约束 */
  constraints?: string[];
}

/**
 * 实现阶段
 */
export interface ImplementationPhase {
  /** 阶段 ID */
  id: string;
  /** 阶段名称 */
  name: string;
  /** 阶段描述 */
  description: string;
  /** 包含的步骤 */
  steps: string[];
  /** 预估工时 */
  estimatedHours?: number;
}

/**
 * API 端点定义
 */
export interface APIEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  description?: string;
  requestBody?: string;
  responseBody?: string;
}

/**
 * API 契约
 */
export interface APIContract {
  name: string;
  baseUrl?: string;
  endpoints: APIEndpoint[];
  /** OpenAPI JSON（如有） */
  openApiSpec?: string;
}

/**
 * 研究笔记
 */
export interface ResearchNotes {
  /** 技术栈研究 */
  techStackResearch?: string;
  /** 最佳实践 */
  bestPractices?: string[];
  /** 潜在风险 */
  risks?: string[];
  /** 完整内容 */
  rawContent?: string;
}

/**
 * 技术实现计划
 */
export interface ImplementationPlan {
  /** 关联的规范 ID */
  specId: string;
  /** 技术栈配置 */
  techStack: TechStackConfig;
  /** 架构决策 */
  architecture?: ArchitectureDecisions;
  /** 实现阶段 */
  phases: ImplementationPhase[];
  /** API 契约 */
  contracts?: APIContract[];
  /** 研究笔记 */
  research?: ResearchNotes;
  /** 完整 Markdown 内容 */
  rawContent: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/**
 * Plan 生成输入
 */
export interface PlanInput {
  /** 规范 */
  specification: Specification;
  /** 技术栈描述 */
  techStackPrompt: string;
  /** 项目宪法 */
  constitution?: Constitution;
}

// ============================================================================
// Task Breakdown（任务分解）
// ============================================================================

/**
 * 规范任务状态
 */
export type SpecTaskStatus = 'pending' | 'in-progress' | 'done' | 'failed' | 'skipped';

/**
 * 规范任务
 */
export interface SpecTask {
  /** 任务 ID */
  id: string;
  /** 关联的用户故事 ID */
  userStoryId?: string;
  /** 任务标题 */
  title: string;
  /** 任务描述 */
  description: string;
  /** 涉及的文件路径 */
  filePaths: string[];
  /** 依赖的任务 ID 列表 */
  dependencies: string[];
  /** 是否可与其他任务并行执行 */
  isParallel: boolean;
  /** 是否采用 TDD（测试先行） */
  testFirst: boolean;
  /** 任务状态 */
  status: SpecTaskStatus;
  /** 预估工时（小时） */
  estimatedHours?: number;
  /** 实际工时 */
  actualHours?: number;
}

/**
 * 任务依赖关系
 */
export interface TaskDependency {
  /** 任务 ID */
  taskId: string;
  /** 依赖的任务 ID 列表 */
  dependsOn: string[];
}

/**
 * 任务分解
 */
export interface TaskBreakdown {
  /** 关联的实现计划 ID（specId） */
  planId: string;
  /** 任务列表 */
  tasks: SpecTask[];
  /** 依赖关系 */
  dependencies: TaskDependency[];
  /** 可并行执行的任务 ID 列表 */
  parallelGroups: string[][];
  /** 完整 Markdown 内容 */
  rawContent: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/**
 * Task 生成输入
 */
export interface TaskInput {
  /** 实现计划 */
  plan: ImplementationPlan;
  /** 是否采用 TDD */
  useTDD?: boolean;
}

// ============================================================================
// Execution（执行）
// ============================================================================

/**
 * SpecKit 执行选项
 */
export interface SpecExecutionOptions {
  /** 从指定任务开始 */
  fromTaskId?: string;
  /** 跳过已完成的任务 */
  skipCompleted?: boolean;
  /** 是否并行执行 */
  enableParallel?: boolean;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** AbortSignal */
  signal?: AbortSignal;
}

/**
 * SpecKit 事件类型
 */
export type SpecEventType =
  | 'constitution:created'
  | 'constitution:updated'
  | 'specification:created'
  | 'specification:clarified'
  | 'plan:created'
  | 'plan:researched'
  | 'tasks:generated'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'implementation:started'
  | 'implementation:completed'
  | 'implementation:failed'
  | 'validation:passed'
  | 'validation:failed';

/**
 * SpecKit 事件
 */
export interface SpecEvent {
  type: SpecEventType;
  timestamp: number;
  data?: unknown;
}

/**
 * 规范验证结果
 */
export interface SpecValidationResult {
  /** 是否通过 */
  passed: boolean;
  /** 验证项 */
  checks: SpecValidationCheck[];
  /** 总体评分（0-100） */
  score?: number;
  /** 建议 */
  suggestions?: string[];
}

/**
 * 单项验证检查
 */
export interface SpecValidationCheck {
  /** 检查项名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 描述 */
  description?: string;
  /** 相关的验收标准 ID */
  acceptanceCriteriaId?: string;
}

// ============================================================================
// 工厂函数输入类型
// ============================================================================

/**
 * SpecKit 初始化选项
 */
export interface SpecKitInitOptions {
  /** 工作目录 */
  workDir: string;
  /** 是否强制覆盖现有结构 */
  force?: boolean;
  /** 目标 AI Agent（claude, gemini, copilot 等） */
  targetAgent?: string;
}

/**
 * SpecKit 工作流阶段
 */
export type SpecKitPhase =
  | 'constitution'
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'research'
  | 'tasks'
  | 'implement'
  | 'validate';

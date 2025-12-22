/**
 * 上下文工程模块 - 核心类型定义
 *
 * 基于 Manus、LangChain 和 Anthropic 的最佳实践设计：
 * - 压缩可逆（保留恢复标识符）
 * - 摘要结构化（使用固定 schema）
 * - 文件系统即上下文（大数据卸载到文件）
 * - KV 缓存优先（保持前缀稳定）
 *
 * @module context/types
 */

// ============================================================================
// 上下文消息类型
// ============================================================================

/**
 * 消息角色
 */
export type ContextMessageRole = 'user' | 'assistant' | 'tool' | 'system';

/**
 * 消息格式
 */
export type MessageFormat = 'full' | 'compact';

/**
 * 上下文消息
 *
 * 支持完整/紧凑两种格式，实现可逆压缩
 */
export interface ContextMessage {
  /** 消息 ID */
  id: string;
  /** 角色 */
  role: ContextMessageRole;
  /** 当前内容（可能是压缩后的） */
  content: string;
  /** 时间戳 */
  timestamp: number;

  /** 完整内容（压缩前保存） */
  fullContent?: string;
  /** 当前格式 */
  format: MessageFormat;
  /**
   * 恢复引用
   *
   * 用于从压缩格式恢复完整内容的标识符：
   * - 文件路径（file:///path/to/file）
   * - URL（https://...）
   * - 工具调用 ID（tool:call_123）
   */
  recoveryRef?: string;
  /** Token 估算 */
  tokenEstimate?: number;

  /** 工具调用相关 */
  toolCall?: {
    id: string;
    name: string;
    input: unknown;
  };
  /** 工具结果相关 */
  toolResult?: {
    callId: string;
    success: boolean;
    output: unknown;
  };
}

// ============================================================================
// 上下文状态
// ============================================================================

/**
 * 上下文阈值配置
 */
export interface ContextThresholds {
  /**
   * 软限制（Token 数）
   *
   * 超过此阈值触发压缩
   * 建议值：128K - 200K（取决于模型）
   */
  softLimit: number;

  /**
   * 硬限制（Token 数）
   *
   * 超过此阈值触发摘要（不可逆）
   * 建议值：模型上下文窗口的 80%
   */
  hardLimit: number;

  /**
   * 上下文腐烂阈值
   *
   * 超过此长度模型性能开始下降
   * 来自 Manus 经验：通常在 128K-200K
   */
  rotThreshold: number;
}

/**
 * 上下文状态
 */
export interface ContextState {
  /** 当前消息列表 */
  messages: ContextMessage[];
  /** 总 Token 估算 */
  totalTokens: number;
  /** 阈值配置 */
  thresholds: ContextThresholds;
  /** 已压缩轮数 */
  compactionCount: number;
  /** 已摘要轮数 */
  summarizationCount: number;
  /** 最后压缩时间 */
  lastCompactionAt?: number;
  /** 最后摘要时间 */
  lastSummarizationAt?: number;
}

// ============================================================================
// 压缩策略
// ============================================================================

/**
 * 压缩策略配置
 *
 * 压缩是可逆的：保留恢复标识符，可按需恢复完整内容
 */
export interface CompactionConfig {
  /**
   * 保留最后 N 条完整消息
   *
   * 这些消息保持完整格式，作为少样本示例
   * 来自 Manus：保留几个完整工具调用示例很重要
   */
  keepLastN: number;

  /**
   * 压缩比例
   *
   * 压缩最老的 X% 消息，例如 0.5 = 压缩最老的 50%
   */
  compactRatio: number;

  /**
   * 最小压缩收益比
   *
   * 如果压缩后 Token 减少比例低于此值，说明应该触发摘要
   * 例如 0.3 = 如果压缩减少不到 30%，触发摘要
   */
  minGainRatio: number;

  /**
   * 工具结果压缩规则
   */
  toolResultRules: ToolResultCompactionRule[];
}

/**
 * 工具结果压缩规则
 */
export interface ToolResultCompactionRule {
  /** 工具名称模式（支持通配符） */
  toolPattern: string;
  /** 压缩处理器 */
  handler: 'keep-path' | 'keep-url' | 'keep-query' | 'keep-summary' | 'remove';
}

/**
 * 压缩结果
 */
export interface CompactionResult {
  /** 是否成功 */
  success: boolean;
  /** 压缩前 Token 数 */
  beforeTokens: number;
  /** 压缩后 Token 数 */
  afterTokens: number;
  /** 压缩收益比 */
  gainRatio: number;
  /** 被压缩的消息数 */
  compactedCount: number;
  /** 生成的恢复引用 */
  recoveryRefs: string[];
}

// ============================================================================
// 摘要策略
// ============================================================================

/**
 * 摘要策略配置
 *
 * 摘要是不可逆的：使用 LLM 生成结构化摘要
 */
export interface SummarizationConfig {
  /**
   * 摘要模式
   *
   * - structured: 使用固定 schema（推荐，来自 Manus）
   * - freeform: 自由形式摘要
   */
  mode: 'structured' | 'freeform';

  /**
   * 结构化摘要字段
   *
   * 使用固定字段而非自由形式，确保输出稳定
   */
  fields?: (keyof StructuredSummary)[];

  /**
   * 摘要前卸载到文件
   *
   * 将完整上下文转储到日志文件，以备需要时恢复
   */
  offloadBeforeSummarize: boolean;

  /**
   * 保留最后 N 条完整消息
   *
   * 摘要后仍保留最新消息完整内容
   */
  keepLastN: number;
}

/**
 * 结构化摘要
 *
 * 来自 Manus 最佳实践：使用固定 schema 而非自由形式
 */
export interface StructuredSummary {
  /** 用户目标 */
  userGoal: string;
  /** 关键约束/偏好 */
  constraints: string[];
  /** 已完成的关键步骤 */
  completedSteps: string[];
  /** 关键发现/结果 */
  keyFindings: string[];
  /** 修改的文件列表 */
  modifiedFiles: string[];
  /** 当前进度描述 */
  currentProgress: string;
  /** 下一步计划 */
  nextSteps: string[];
  /** 重要的错误/警告 */
  errors: string[];
  /** 最后停止位置 */
  lastStopPoint: string;
}

/**
 * 摘要结果
 */
export interface SummarizationResult {
  /** 是否成功 */
  success: boolean;
  /** 生成的摘要 */
  summary: StructuredSummary;
  /** 摘要前 Token 数 */
  beforeTokens: number;
  /** 摘要后 Token 数 */
  afterTokens: number;
  /** 卸载的文件路径（如果开启了卸载） */
  offloadedPath?: string;
}

// ============================================================================
// 卸载策略
// ============================================================================

/**
 * 卸载策略配置
 *
 * 将大内容卸载到文件系统，保留引用标识符
 */
export interface OffloadConfig {
  /** 工作目录 */
  workDir: string;
  /** 卸载阈值（单条消息 Token 数） */
  tokenThreshold: number;
  /** 卸载文件格式 */
  fileFormat: 'json' | 'jsonl' | 'txt';
}

/**
 * 卸载结果
 */
export interface OffloadResult {
  /** 是否成功 */
  success: boolean;
  /** 卸载的消息 ID */
  messageIds: string[];
  /** 生成的文件路径 */
  filePaths: string[];
  /** 节省的 Token 数 */
  savedTokens: number;
}

// ============================================================================
// KV 缓存优化
// ============================================================================

/**
 * KV 缓存优化配置
 *
 * 来自 Manus：KV 缓存命中率是生产阶段最重要的单一指标
 */
export interface CacheOptimizationConfig {
  /**
   * 是否启用确定性序列化
   *
   * 确保 JSON 键顺序稳定，避免破坏缓存
   */
  deterministicSerialization: boolean;

  /**
   * 是否添加缓存断点
   *
   * 在系统提示末尾标记断点
   */
  addCacheBreakpoints: boolean;

  /**
   * 禁止在系统提示中包含的动态内容
   *
   * 例如：时间戳、随机 ID
   */
  forbiddenDynamicContent: string[];
}

// ============================================================================
// 笔记系统
// ============================================================================

/**
 * 待办事项状态
 */
export type TodoStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';

/**
 * 待办事项
 */
export interface TodoItem {
  /** 事项 ID */
  id: string;
  /** 描述 */
  description: string;
  /** 状态 */
  status: TodoStatus;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
}

/**
 * 智能体笔记
 *
 * 来自 Manus：创建 todo.md 是一种操控注意力的刻意机制
 * 通过不断重写待办事项，将目标复述到上下文末尾
 */
export interface AgentNotes {
  /** 待办事项列表 */
  todos: TodoItem[];
  /** 关键发现 */
  findings: string[];
  /** 重要决策 */
  decisions: string[];
  /** 最后更新时间 */
  lastUpdatedAt: number;
}

// ============================================================================
// Prompt 上下文工程配置与接口（内部模块）
// ============================================================================

/**
 * Prompt 上下文工程配置
 */
export interface PromptContextConfig {
  /** 阈值配置 */
  thresholds: ContextThresholds;
  /** 压缩配置 */
  compaction: CompactionConfig;
  /** 摘要配置 */
  summarization: SummarizationConfig;
  /** 卸载配置 */
  offload: OffloadConfig;
  /** 缓存优化配置 */
  cacheOptimization: CacheOptimizationConfig;
  /** 
   * Token 估算器（可选）
   * 
   * 如果不提供，使用默认的简单估算器（length / 3）
   */
  tokenEstimator?: (content: string) => number;
}

/**
 * Prompt 上下文工程接口
 */
export interface IPromptContextEngine {
  // ========================================
  // 消息管理
  // ========================================

  /** 添加消息 */
  addMessage(message: ContextMessage): void;

  /** 获取当前上下文（用于 LLM 调用，已优化） */
  getContext(): ContextMessage[];

  /** 获取原始消息（未优化） */
  getRawMessages(): ContextMessage[];

  /** 获取状态 */
  getState(): ContextState;

  // ========================================
  // 缩减操作
  // ========================================

  /** 检查是否需要缩减（超过软限制） */
  needsReduction(): boolean;

  /** 检查是否需要摘要（超过硬限制） */
  needsSummarization(): boolean;

  /** 执行压缩（可逆） */
  compact(): Promise<CompactionResult>;

  /** 执行摘要（不可逆） */
  summarize(): Promise<SummarizationResult>;

  /**
   * 自动缩减上下文
   *
   * 根据当前 Token 数自动选择压缩或摘要
   * 若 LLM 不可用且超硬限制，返回失败结果
   */
  autoReduce(): Promise<CompactionResult | SummarizationResult | null>;

  // ========================================
  // 卸载与恢复
  // ========================================

  /** 卸载消息到文件系统 */
  offload(messageIds: string[]): Promise<OffloadResult>;

  /** 从引用恢复消息 */
  recover(refs: string[]): Promise<ContextMessage[]>;

  // ========================================
  // 笔记功能
  // ========================================

  /** 获取当前笔记 */
  getNotes(): AgentNotes;

  /** 更新笔记 */
  setNotes(notes: AgentNotes): void;

  /** 添加待办事项 */
  addTodo(description: string): void;

  /** 完成待办事项 */
  completeTodo(todoId: string): void;

  /** 添加发现 */
  addFinding(finding: string): void;

  /** 注入状态提醒到上下文末尾 */
  injectStatusReminder(): void;

  // ========================================
  // 工具方法
  // ========================================

  /** 估算 Token 数 */
  estimateTokens(content: string): number;

  /** 清空上下文（包括笔记） */
  clear(): void;

  /** 估算缓存命中率 */
  estimateCacheHitRate(previousMessages: ContextMessage[]): number;
}

/**
 * 默认阈值配置（Manus 推荐值）
 * 
 * - softLimit: 150K - 触发压缩的阈值
 * - hardLimit: 160K - 触发摘要的阈值（默认值，模型感知时会动态计算）
 * - rotThreshold: 128K - 上下文腐烂阈值（模型性能开始下降）
 */
export const DEFAULT_THRESHOLDS: ContextThresholds = {
  softLimit: 150_000, // 150K tokens - 触发压缩
  hardLimit: 160_000, // 160K tokens - 默认值（动态计算会覆盖）
  rotThreshold: 128_000, // 128K tokens - Manus 经验值
};

/**
 * 模型上下文窗口大小映射
 * 
 * 用于动态计算 hardLimit（模型窗口 × 0.8）
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude 3 系列
  'claude-3-opus': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku': 200_000,
  'claude-3-haiku-20240307': 200_000,
  // Claude 3.5 系列
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  // OpenAI GPT-4 系列
  'gpt-4o': 128_000,
  'gpt-4o-2024-05-13': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4-turbo-preview': 128_000,
  // Google Gemini 系列
  'gemini-pro': 1_000_000,
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,

  // Claude 4 / 4.5 系列 (Predicted)
  'claude-4-sonnet': 1_000_000,
  'claude-4.5-sonnet': 1_000_000,
  'claude-4.1-opus': 200_000,
  'claude-4.5-opus': 200_000,

  // GPT-5 系列 (Predicted)
  'gpt-5': 400_000,
  'gpt-5-turbo': 400_000,
  'gpt-5-o': 400_000,
  'gpt-5.1': 400_000,
  'gpt-5.2': 400_000,

  // Gemini 3 系列 (Predicted)
  'gemini-3-pro': 2_000_000,
  'gemini-3': 2_000_000, // Fallback for gemini-3-preview etc.

  // Claude 4 Generic Fallback
  'claude-4': 200_000, // Fallback for unknown Claude 4 variants

  // 默认值（用于未知模型）
  'default': 128_000,
};

/**
 * 默认压缩配置
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  keepLastN: 5,
  compactRatio: 0.5,
  minGainRatio: 0.2,
  toolResultRules: [
    { toolPattern: 'read_file', handler: 'keep-path' },
    { toolPattern: 'write_file', handler: 'keep-path' },
    { toolPattern: 'browser_*', handler: 'keep-url' },
    { toolPattern: 'search_*', handler: 'keep-query' },
    { toolPattern: 'shell_*', handler: 'keep-summary' },
  ],
};

/**
 * 默认摘要配置
 */
export const DEFAULT_SUMMARIZATION_CONFIG: SummarizationConfig = {
  mode: 'structured',
  offloadBeforeSummarize: true,
  keepLastN: 3,
};

/**
 * 获取模型的上下文窗口大小
 * 
 * @param modelId - 模型 ID（支持模糊匹配）
 * @returns 模型的上下文窗口大小
 */
export function getModelContextLimit(modelId: string): number {
  // 精确匹配
  if (MODEL_CONTEXT_LIMITS[modelId]) {
    return MODEL_CONTEXT_LIMITS[modelId];
  }
  
  // 模糊匹配（支持前缀匹配）
  const normalizedId = modelId.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (normalizedId.startsWith(key.toLowerCase())) {
      return value;
    }
  }
  
  // 返回默认值
  return MODEL_CONTEXT_LIMITS['default'] ?? 128_000;
}

/**
 * 计算模型感知的阈值配置
 * 
 * 自动根据模型上下文窗口调整所有阈值，确保：
 * - softLimit < hardLimit
 * - rotThreshold < hardLimit
 * 
 * @param modelId - 模型 ID
 * @param overrides - 可选的阈值覆盖
 * @returns 计算后的阈值配置
 */
export function computeModelAwareThresholds(
  modelId: string,
  overrides?: Partial<ContextThresholds>
): ContextThresholds {
  const contextLimit = getModelContextLimit(modelId);
  const hardLimit = overrides?.hardLimit ?? Math.floor(contextLimit * 0.8); // 模型窗口的 80%
  
  // 确保 softLimit < hardLimit（留 10k 余量）
  const defaultSoftLimit = Math.min(DEFAULT_THRESHOLDS.softLimit, hardLimit - 10_000);
  const softLimit = overrides?.softLimit ?? defaultSoftLimit;
  
  // 确保 rotThreshold < hardLimit（留 10k 余量）
  // 这是关键修复：对于小窗口模型（如 GPT-4o 128k），rotThreshold 需要下调
  const defaultRotThreshold = Math.min(DEFAULT_THRESHOLDS.rotThreshold, hardLimit - 10_000);
  const rotThreshold = overrides?.rotThreshold ?? defaultRotThreshold;
  
  return {
    softLimit,
    hardLimit,
    rotThreshold,
  };
}

/**
 * 验证阈值配置的有效性
 * 
 * @param thresholds - 阈值配置
 * @throws {Error} 配置无效时抛出错误
 */
export function validateThresholds(thresholds: ContextThresholds): void {
  if (thresholds.softLimit <= 0) {
    throw new Error('softLimit must be positive');
  }
  if (thresholds.hardLimit <= 0) {
    throw new Error('hardLimit must be positive');
  }
  if (thresholds.rotThreshold <= 0) {
    throw new Error('rotThreshold must be positive');
  }
  if (thresholds.softLimit >= thresholds.hardLimit) {
    throw new Error('softLimit must be less than hardLimit');
  }
  if (thresholds.rotThreshold >= thresholds.hardLimit) {
    throw new Error('rotThreshold must be less than hardLimit');
  }
}

/**
 * 创建默认 Prompt 上下文工程配置
 * 
 * 注意：返回新创建的配置对象副本，修改不会影响默认值
 */
export function createDefaultPromptConfig(
  workDir: string
): PromptContextConfig {
  return {
    thresholds: { ...DEFAULT_THRESHOLDS },
    compaction: { ...DEFAULT_COMPACTION_CONFIG },
    summarization: { ...DEFAULT_SUMMARIZATION_CONFIG },
    offload: {
      workDir,
      tokenThreshold: 5000,
      fileFormat: 'jsonl',
    },
    cacheOptimization: {
      deterministicSerialization: true,
      addCacheBreakpoints: true,
      forbiddenDynamicContent: ['timestamp', 'random', 'uuid'],
    },
  };
}

/**
 * 创建模型感知的 Prompt 上下文工程配置
 * 
 * 自动根据模型的上下文窗口大小计算 hardLimit
 * 
 * @param modelId - 模型 ID
 * @param workDir - 工作目录
 * @param thresholdOverrides - 可选的阈值覆盖
 * @returns 模型感知的配置
 * 
 * @example
 * ```ts
 * // 创建 Claude 配置（hardLimit = 200K × 0.8 = 160K）
 * const config = createModelAwarePromptConfig('claude-3-sonnet', '/tmp/workspace');
 * 
 * // 创建 GPT-4 配置（hardLimit = 128K × 0.8 = 102K）
 * const config = createModelAwarePromptConfig('gpt-4o', '/tmp/workspace');
 * 
 * // 使用自定义阈值
 * const config = createModelAwarePromptConfig('gemini-1.5-pro', '/tmp/workspace', {
 *   softLimit: 500_000,
 *   hardLimit: 800_000,
 * });
 * ```
 */
export function createModelAwarePromptConfig(
  modelId: string,
  workDir: string,
  thresholdOverrides?: Partial<ContextThresholds>
): PromptContextConfig {
  const thresholds = computeModelAwareThresholds(modelId, thresholdOverrides);
  
  // 验证配置
  validateThresholds(thresholds);
  
  return {
    thresholds,
    compaction: DEFAULT_COMPACTION_CONFIG,
    summarization: DEFAULT_SUMMARIZATION_CONFIG,
    offload: {
      workDir,
      tokenThreshold: 5000,
      fileFormat: 'jsonl',
    },
    cacheOptimization: {
      deterministicSerialization: true,
      addCacheBreakpoints: true,
      forbiddenDynamicContent: ['timestamp', 'random', 'uuid'],
    },
  };
}

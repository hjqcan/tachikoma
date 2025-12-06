/**
 * Planner 模块
 *
 * 提供 LLM 客户端、Prompt 模板、输出解析等功能
 *
 * @packageDocumentation
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // LLM 客户端类型
  LLMProvider,
  LLMMessageRole,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMClientConfig,
  LLMClient,
  // 解析器类型
  ParseResult,
  ParseRetryConfig,
  // Prompt 类型
  PromptVariables,
  ErrorFeedbackVariables,
} from './types';

// ============================================================================
// LLM 客户端导出
// ============================================================================

export {
  // 客户端实现
  BaseLLMClient,
  AnthropicLLMClient,
  OpenAILLMClient,
  MockLLMClient,
  type MockLLMConfig,
  // 错误类型
  LLMClientError,
  // 工厂函数
  createLLMClient,
} from './llm-client';

// ============================================================================
// Prompt 导出
// ============================================================================

export {
  // 输出格式类型
  type PlanningOutputFormat,
  // Prompt 模板
  PLANNING_SYSTEM_PROMPT,
  generatePlanningUserPrompt,
  generateErrorFeedbackPrompt,
  // 工具函数
  extractJsonFromResponse,
  convertToSubTasks,
  convertToExecutionPlan,
} from './prompts';

// ============================================================================
// 解析器导出
// ============================================================================

export {
  // 解析器
  PlanningParser,
  ParseError,
  // 解析函数
  parsePlanningOutput,
  // 默认配置
  DEFAULT_PARSE_RETRY_CONFIG,
} from './parser';

// ============================================================================
// Planner 导出
// ============================================================================

export {
  // Planner 类
  Planner,
  // 工厂函数
  createPlanner,
  // 类型
  type PlannerOptions,
  type PlanResult,
  type DegradationStrategy,
} from './planner';

/**
 * 关键决策检测模块
 *
 * 判断工具调用是否为关键决策点，需要审批
 */

import type { Tool } from '../types';
import type {
  ApprovalCategory,
  KeyDecisionPolicy,
  RiskPolicy,
} from './types';
import {
  DEFAULT_KEY_DECISION_POLICY,
  DEFAULT_RISK_POLICY,
} from './types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 风险级别
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * 关键决策检测结果
 */
export interface KeyDecisionResult {
  /** 是否为关键决策 */
  isKeyDecision: boolean;
  /** 决策类别 */
  category: ApprovalCategory;
  /** 原因说明 */
  reason: string;
  /** 风险级别 */
  riskLevel: RiskLevel;
}

/**
 * 非关键决策结果
 */
const NOT_KEY_DECISION: KeyDecisionResult = {
  isKeyDecision: false,
  category: 'custom',
  reason: 'Not a key decision',
  riskLevel: 'low',
};

// ============================================================================
// 检测函数
// ============================================================================

/**
 * 不可逆操作关键词
 */
const IRREVERSIBLE_KEYWORDS = [
  'delete', 'remove', 'drop', 'truncate', 'destroy',
  'rm', 'rmdir', 'unlink', 'wipe', 'purge', 'clear',
];

/**
 * 外部 API 关键词
 */
const EXTERNAL_API_KEYWORDS = [
  'http://', 'https://', 'api.', 'webhook',
  'fetch', 'request', 'post', 'put', 'patch',
  'upload', 'download', 'send', 'publish',
];

/**
 * 多文件操作相关的输入字段
 */
const MULTI_FILE_FIELDS = ['files', 'paths', 'targets', 'sources'];

/**
 * 判断是否为删除操作
 */
export function isDeleteOperation(
  toolName: string,
  input: Record<string, unknown>
): boolean {
  const lowerName = toolName.toLowerCase();

  // 工具名称包含删除关键词
  if (IRREVERSIBLE_KEYWORDS.some((kw) => lowerName.includes(kw))) {
    return true;
  }

  // 输入中包含删除指令
  const inputStr = JSON.stringify(input).toLowerCase();
  return IRREVERSIBLE_KEYWORDS.some((kw) => inputStr.includes(kw));
}

/**
 * 判断是否为大规模修改
 *
 * 基于以下启发式：
 * - content 字段长度（估算行数）
 * - lines/patch 字段中的行数
 * - diff 字段中的变更行数
 */
export function isLargeModification(
  input: Record<string, unknown>,
  threshold: number
): boolean {
  // 检查 content 字段
  if (typeof input.content === 'string') {
    const lineCount = input.content.split('\n').length;
    if (lineCount > threshold) {
      return true;
    }
  }

  // 检查 lines 字段
  if (typeof input.lines === 'number' && input.lines > threshold) {
    return true;
  }

  // 检查 patch/diff 字段
  if (typeof input.patch === 'string') {
    const patchLines = input.patch.split('\n').length;
    if (patchLines > threshold) {
      return true;
    }
  }

  if (typeof input.diff === 'string') {
    const diffLines = input.diff.split('\n').length;
    if (diffLines > threshold) {
      return true;
    }
  }

  // 检查 changes 数组
  if (Array.isArray(input.changes)) {
    const totalLines = input.changes.reduce((sum, change) => {
      if (typeof change === 'string') {
        return sum + change.split('\n').length;
      }
      if (typeof change === 'object' && change !== null) {
        const content = (change as Record<string, unknown>).content;
        if (typeof content === 'string') {
          return sum + content.split('\n').length;
        }
      }
      return sum;
    }, 0);
    if (totalLines > threshold) {
      return true;
    }
  }

  return false;
}

/**
 * 判断是否为多文件操作
 */
export function isMultiFileOperation(
  input: Record<string, unknown>,
  threshold: number
): boolean {
  // 检查已知的多文件字段
  for (const field of MULTI_FILE_FIELDS) {
    const value = input[field];
    if (Array.isArray(value) && value.length >= threshold) {
      return true;
    }
  }

  // 检查 path 相关字段是否为数组
  for (const [key, value] of Object.entries(input)) {
    if (key.toLowerCase().includes('path') || key.toLowerCase().includes('file')) {
      if (Array.isArray(value) && value.length >= threshold) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 判断是否为外部 API 调用
 */
export function isExternalApiCall(
  toolName: string,
  input: Record<string, unknown>
): boolean {
  const lowerName = toolName.toLowerCase();

  // 工具名称暗示 API 调用
  if (['http', 'api', 'fetch', 'request', 'webhook'].some((kw) => lowerName.includes(kw))) {
    return true;
  }

  // 输入中包含 URL 或 API 关键词
  const inputStr = JSON.stringify(input).toLowerCase();
  return EXTERNAL_API_KEYWORDS.some((kw) => inputStr.includes(kw));
}

/**
 * 检测是否为高风险工具（基于 RiskPolicy）
 */
export function isHighRiskTool(
  toolName: string,
  input: Record<string, unknown>,
  riskPolicy?: RiskPolicy
): boolean {
  const policy = {
    highRiskTools: riskPolicy?.highRiskTools ?? DEFAULT_RISK_POLICY.highRiskTools,
    dangerousPatterns: riskPolicy?.dangerousPatterns ?? DEFAULT_RISK_POLICY.dangerousPatterns,
  };

  // 自定义评估函数优先
  if (riskPolicy?.customEvaluator) {
    return riskPolicy.customEvaluator(toolName, input);
  }

  // 检查高风险工具名称
  if (policy.highRiskTools.some((t) => toolName.toLowerCase().includes(t.toLowerCase()))) {
    return true;
  }

  // 检查输入中的危险模式
  const inputStr = JSON.stringify(input).toLowerCase();
  return policy.dangerousPatterns.some((pattern) => inputStr.includes(pattern.toLowerCase()));
}

/**
 * 检测是否为关键决策
 *
 * 综合评估工具调用是否需要人工审批
 *
 * @param toolName - 工具名称
 * @param input - 工具输入
 * @param tool - 工具定义（可选，用于获取元数据）
 * @param policy - 关键决策策略
 * @param riskPolicy - 风险策略
 * @param unknownToolPolicy - 未知工具策略（当 tool 为 undefined 时）
 * @returns 检测结果
 */
export function isKeyDecision(
  toolName: string,
  input: Record<string, unknown>,
  tool: Tool | undefined,
  policy?: Partial<KeyDecisionPolicy>,
  riskPolicy?: RiskPolicy,
  unknownToolPolicy?: 'approve' | 'reject' | 'require_approval'
): KeyDecisionResult {
  // 合并默认策略
  const fullPolicy = {
    enabled: policy?.enabled ?? DEFAULT_KEY_DECISION_POLICY.enabled,
    approvalTimeout: policy?.approvalTimeout ?? DEFAULT_KEY_DECISION_POLICY.approvalTimeout,
    defaultDecision: policy?.defaultDecision ?? DEFAULT_KEY_DECISION_POLICY.defaultDecision,
    triggers: {
      ...DEFAULT_KEY_DECISION_POLICY.triggers,
      ...policy?.triggers,
    },
  };

  // 策略未启用
  if (!fullPolicy.enabled) {
    return NOT_KEY_DECISION;
  }

  const { triggers } = fullPolicy;

  // 0. 检查未知工具（无元数据）
  if (!tool && unknownToolPolicy === 'require_approval') {
    return {
      isKeyDecision: true,
      category: 'custom',
      reason: `Unknown tool "${toolName}" requires approval (no metadata available)`,
      riskLevel: 'medium',
    };
  }

  if (!tool && unknownToolPolicy === 'reject') {
    return {
      isKeyDecision: true,
      category: 'custom',
      reason: `Unknown tool "${toolName}" is rejected (no metadata available)`,
      riskLevel: 'high',
    };
  }

  // 1. 检查高风险工具
  if (isHighRiskTool(toolName, input, riskPolicy)) {
    return {
      isKeyDecision: true,
      category: 'high_risk_tool',
      reason: `Tool "${toolName}" is classified as high-risk`,
      riskLevel: 'high',
    };
  }

  // 2. 检查删除/不可逆操作
  if (triggers.detectIrreversible && isDeleteOperation(toolName, input)) {
    return {
      isKeyDecision: true,
      category: 'key_decision',
      reason: `Operation involves deletion or irreversible changes`,
      riskLevel: 'critical',
    };
  }

  // 3. 检查外部 API 调用
  if (triggers.detectExternalApi && isExternalApiCall(toolName, input)) {
    return {
      isKeyDecision: true,
      category: 'key_decision',
      reason: `Operation involves external API call`,
      riskLevel: 'medium',
    };
  }

  // 4. 检查大规模修改
  if (isLargeModification(input, triggers.maxLinesThreshold)) {
    return {
      isKeyDecision: true,
      category: 'key_decision',
      reason: `Modification exceeds ${triggers.maxLinesThreshold} lines`,
      riskLevel: 'high',
    };
  }

  // 5. 检查多文件操作
  if (isMultiFileOperation(input, triggers.multiFileThreshold)) {
    return {
      isKeyDecision: true,
      category: 'key_decision',
      reason: `Operation affects ${triggers.multiFileThreshold}+ files`,
      riskLevel: 'high',
    };
  }

  // 6. 检查工具元数据（如果提供）
  if (tool) {
    const metadata = tool.inputSchema as Record<string, unknown>;
    // 检查工具声明的风险标记
    if (metadata?.requiresApproval === true || metadata?.isHighRisk === true) {
      return {
        isKeyDecision: true,
        category: 'custom',
        reason: `Tool "${toolName}" requires approval per metadata`,
        riskLevel: 'medium',
      };
    }
  }

  return NOT_KEY_DECISION;
}

/**
 * 计算风险级别的严重程度分数
 */
export function getRiskScore(level: RiskLevel): number {
  switch (level) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    case 'critical':
      return 4;
    default:
      return 0;
  }
}

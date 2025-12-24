/**
 * 集成上下文服务
 *
 * 负责管理跨子任务的上下文共享，包括：
 * - API 规格提取与共享
 * - 生成文件清单同步
 * - 集成类子任务的上下文注入
 *
 * 从 Orchestrator 类中提取
 */

import type { TaskResult } from '../../types';
import type { SubTask } from '../types';
import type { ISessionFileManager, ActionRecord, DecisionRecord, ApiSpec, ApiEndpoint, SharedKnowledgeData } from '../session';

// ============================================================================
// 类型定义
// ============================================================================

// 移除本地 SharedKnowledgeData 定义，使用 session/types 中的定义
export type { SharedKnowledgeData } from '../session';

/**
 * 集成上下文服务配置
 */
export interface IntegrationContextConfig {
  maxSyncLogEntries: number;
  maxFilesPerWorker: number;
  maxEndpointsToShow: number;
  maxWorkersToShow: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: IntegrationContextConfig = {
  maxSyncLogEntries: 20,
  maxFilesPerWorker: 5,
  maxEndpointsToShow: 10,
  maxWorkersToShow: 5,
};

// ============================================================================
// IntegrationContextService 实现
// ============================================================================

/**
 * 集成上下文服务
 *
 * 负责在子任务之间共享上下文信息，特别是：
 * 1. 从 backend worker 提取 API 规格
 * 2. 跟踪各 worker 生成的文件
 * 3. 为集成类子任务注入上下文
 *
 * @example
 * ```ts
 * const service = new IntegrationContextService({ sessionManager });
 *
 * // 子任务完成后同步上下文
 * await service.syncAfterSubtaskCompletion(workerId, subtask, result);
 *
 * // 分配前增强集成类子任务
 * const enhanced = await service.enhanceSubtaskForIntegration(subtask);
 * ```
 */
export class IntegrationContextService {
  private readonly sessionManager: ISessionFileManager;
  private readonly config: IntegrationContextConfig;
  private memorySyncStrategy: 'selective' | 'nightly_full' = 'selective';

  constructor(options: {
    sessionManager: ISessionFileManager;
    config?: Partial<IntegrationContextConfig>;
  }) {
    this.sessionManager = options.sessionManager;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
  }

  /**
   * 设置内存同步策略
   */
  setMemorySyncStrategy(strategy: 'selective' | 'nightly_full'): void {
    this.memorySyncStrategy = strategy;
  }

  /**
   * 初始化共享上下文
   */
  async initializeSharedContext(
    objective: string,
    constraints: string[],
    workspace?: { rootPath: string; keyFiles?: string[]; gitEnabled?: boolean }
  ): Promise<void> {
    const workspaceInfo = workspace
      ? {
          rootPath: workspace.rootPath,
          keyFiles: workspace.keyFiles ?? [],
          // gitEnabled 不在 SharedContextFile 定义中，忽略
        }
      : undefined;

    await this.sessionManager.writeSharedContext({
      objective,
      constraints,
      sharedKnowledge: {
        data: {},
        updatedAt: Date.now(),
      },
      ...(workspaceInfo ? {
        workspace: workspaceInfo,
      } : {}),
    });
  }

  /**
   * 子任务完成后同步上下文
   */
  async syncAfterSubtaskCompletion(
    workerId: string,
    subtask: SubTask,
    result: TaskResult
  ): Promise<void> {
    if (this.memorySyncStrategy !== 'selective') return;

    const shared = await this.sessionManager.readSharedContext().catch(() => null);
    if (!shared) return;

    // 读取行动日志和决策记录
    const actions = await this.sessionManager.readActionLogs(workerId, 200).catch(() => []);
    const modifiedFiles = this.extractModifiedFilesFromActions(actions, subtask.id);

    const decisions = await this.sessionManager.readDecisions(200).catch(() => []);
    const decisionSummary = this.extractDecisionSummary(decisions, workerId, subtask.id);

    const outputText = this.extractResultText(result);

    // 构建新的共享知识数据
    const nextData: SharedKnowledgeData = {
      ...(shared.sharedKnowledge?.data ?? {}),
    };

    // 更新同步日志
    const syncLog = Array.isArray(nextData.syncLog)
      ? nextData.syncLog.slice(-(this.config.maxSyncLogEntries - 1))
      : [];

    syncLog.push({
      subtaskId: subtask.id,
      workerId,
      objective: subtask.objective,
      updatedAt: Date.now(),
      ...(modifiedFiles.length > 0 ? { modifiedFiles } : {}),
      ...(decisionSummary.length > 0 ? { decisions: decisionSummary } : {}),
      ...(outputText ? { output: outputText } : {}),
    });

    nextData.syncLog = syncLog;

    // 同步生成文件
    if (modifiedFiles.length > 0) {
      const generatedFiles = nextData.generatedFiles ?? {};
      const existingFiles = generatedFiles[workerId] ?? [];
      const merged = Array.from(new Set([...existingFiles, ...modifiedFiles]));
      generatedFiles[workerId] = merged;
      nextData.generatedFiles = generatedFiles;
    }

    // 提取 API 规格
    const extractedApiSpec = this.extractApiSpecFromResult(result, workerId, subtask);
    if (extractedApiSpec) {
      nextData.apiSpec = extractedApiSpec;
    }

    await this.sessionManager.writeSharedContext({
      objective: shared.objective,
      constraints: shared.constraints,
      sharedKnowledge: { data: nextData, updatedAt: Date.now() },
      ...(shared.workspace ? { workspace: shared.workspace } : {}),
    });
  }

  /**
   * 检测是否是集成类子任务
   */
  isIntegrationSubtask(subtask: SubTask): boolean {
    const integrationKeywords = [
      'integration', 'integrate', 'connect', 'wire up', 'wiring',
      'hook up', 'combine', 'merge', 'link', 'bridge',
    ];
    const objectiveLower = subtask.objective.toLowerCase();

    // 检查 objective 中是否包含集成关键词
    if (integrationKeywords.some((k) => objectiveLower.includes(k))) {
      return true;
    }

    // 检查是否有多个依赖
    const deps = subtask.dependencies ?? [];
    if (deps.length >= 2) {
      return true;
    }

    return false;
  }

  /**
   * 为集成类子任务构建上下文
   */
  async buildIntegrationContext(subtask: SubTask): Promise<string> {
    if (!this.isIntegrationSubtask(subtask)) return '';

    const context = await this.sessionManager.readSharedContext().catch(() => null);
    if (!context?.sharedKnowledge?.data) return '';

    const parts: string[] = [];
    const data = context.sharedKnowledge.data as SharedKnowledgeData;

    // 注入 API 接口定义
    if (data.apiSpec && data.apiSpec.endpoints?.length > 0) {
      parts.push('[已有 API 接口]');
      if (data.apiSpec.baseUrl) {
        parts.push(`Base URL: ${data.apiSpec.baseUrl}`);
      }
      parts.push('Endpoints:');
      for (const ep of data.apiSpec.endpoints.slice(0, this.config.maxEndpointsToShow)) {
        parts.push(`  ${ep.method} ${ep.path} - ${ep.description}`);
      }
      if (data.apiSpec.endpoints.length > this.config.maxEndpointsToShow) {
        parts.push(
          `  ... 还有 ${data.apiSpec.endpoints.length - this.config.maxEndpointsToShow} 个端点`
        );
      }
    }

    // 注入生成文件清单
    if (data.generatedFiles) {
      const workerIds = Object.keys(data.generatedFiles);
      if (workerIds.length > 0) {
        parts.push('');
        parts.push('[已生成文件]');
        for (const wid of workerIds.slice(0, this.config.maxWorkersToShow)) {
          const files = data.generatedFiles[wid];
          if (files && files.length > 0) {
            parts.push(`${wid}:`);
            for (const file of files.slice(0, this.config.maxFilesPerWorker)) {
              parts.push(`  - ${file}`);
            }
            if (files.length > this.config.maxFilesPerWorker) {
              parts.push(`  ... 还有 ${files.length - this.config.maxFilesPerWorker} 个文件`);
            }
          }
        }
      }
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  /**
   * 增强集成类子任务的上下文
   */
  async enhanceSubtaskForIntegration(subtask: SubTask): Promise<SubTask> {
    const integrationContext = await this.buildIntegrationContext(subtask);
    if (!integrationContext) return subtask;

    // 将集成上下文附加到 constraints
    const enhancedConstraints = [...(subtask.constraints ?? []), integrationContext];

    return {
      ...subtask,
      constraints: enhancedConstraints,
    };
  }

  /**
   * 从行动日志提取修改的文件
   */
  private extractModifiedFilesFromActions(
    actions: ActionRecord[],
    subtaskId: string
  ): string[] {
    const files = new Set<string>();
    for (const a of actions) {
      if (a.subtaskId !== subtaskId) continue;
      if (!a.params || typeof a.params !== 'object') continue;
      const tool = (a.params as Record<string, unknown>).tool;
      if (tool !== 'apply_patch' && tool !== 'file_write') continue;
      const input = (a.params as Record<string, unknown>).input;
      if (!input || typeof input !== 'object') continue;
      const path = (input as Record<string, unknown>).path;
      if (typeof path === 'string' && path) files.add(path);
    }
    return Array.from(files);
  }

  /**
   * 提取决策摘要
   */
  private extractDecisionSummary(
    decisions: DecisionRecord[],
    workerId: string,
    subtaskId: string
  ): { type: string; reason: string; approved?: boolean }[] {
    return decisions
      .filter((d) => d.workerId === workerId && d.subtaskId === subtaskId)
      .slice(-20)
      .map((d) => ({
        type: d.type,
        reason: d.decision.reason,
        ...(d.decision.approved !== undefined ? { approved: d.decision.approved } : {}),
      }));
  }

  /**
   * 从结果中提取文本
   */
  private extractResultText(result: TaskResult): string | undefined {
    const out = result.output as unknown;
    if (!out || typeof out !== 'object') return undefined;
    const outputObj = out as Record<string, unknown>;

    const text = outputObj.text;
    if (typeof text === 'string' && text.trim()) {
      const sanitized = this.stripToolUseXml(text);
      if (sanitized) return sanitized.slice(0, 800);
    }
    const message = outputObj.message;
    if (typeof message === 'string' && message.trim()) {
      const sanitized = this.stripToolUseXml(message);
      if (sanitized) return sanitized.slice(0, 800);
    }
    return undefined;
  }

  /**
   * 移除 tool_use XML 标签
   */
  private stripToolUseXml(input: string): string | undefined {
    const original = input.trim();
    if (!original) return undefined;

    let cleaned = original.replace(/<tool_use[\s\S]*?<\/tool_use>/g, '').trim();
    cleaned = cleaned.replace(/<tool_use[\s\S]*$/g, '').trim();
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return cleaned || undefined;
  }

  /**
   * 从结果中提取 API 规格
   */
  private extractApiSpecFromResult(
    result: TaskResult,
    workerId: string,
    subtask: SubTask
  ): ApiSpec | null {
    // 检测是否是 backend/API 相关的 worker
    if (!this.isBackendOrApiWorker(workerId, subtask)) return null;

    let output = result.output as unknown;

    // 当 output 为字符串时，尝试解析为 JSON
    if (typeof output === 'string' && output.trim()) {
      const parsed = this.tryParseApiSpecFromText(output);
      if (parsed) {
        return {
          ...parsed,
          updatedAt: Date.now(),
          producedBy: workerId,
        };
      }
      try {
        output = JSON.parse(output);
      } catch {
        // 解析失败
      }
    }

    if (!output || typeof output !== 'object') return null;

    const outputObj = output as Record<string, unknown>;

    // 检查显式的 apiSpec 字段
    if (outputObj.apiSpec && typeof outputObj.apiSpec === 'object') {
      const spec = outputObj.apiSpec as Record<string, unknown>;
      if (Array.isArray(spec.endpoints)) {
        return {
          endpoints: this.normalizeApiEndpoints(spec.endpoints),
          ...(typeof spec.baseUrl === 'string' ? { baseUrl: spec.baseUrl } : {}),
          updatedAt: Date.now(),
          producedBy: workerId,
        };
      }
    }

    // 检查 endpoints 字段
    if (Array.isArray(outputObj.endpoints)) {
      return {
        endpoints: this.normalizeApiEndpoints(outputObj.endpoints),
        ...(typeof outputObj.baseUrl === 'string' ? { baseUrl: outputObj.baseUrl } : {}),
        updatedAt: Date.now(),
        producedBy: workerId,
      };
    }

    // 尝试从 text/message 中解析
    const textContent = outputObj.text || outputObj.message;
    if (typeof textContent === 'string') {
      const parsed = this.tryParseApiSpecFromText(textContent);
      if (parsed) {
        return {
          ...parsed,
          updatedAt: Date.now(),
          producedBy: workerId,
        };
      }
    }

    // 检查 artifacts
    if (result.artifacts && result.artifacts.length > 0) {
      for (const artifact of result.artifacts) {
        if (
          artifact.name?.toLowerCase().includes('api') ||
          artifact.name?.toLowerCase().includes('openapi') ||
          artifact.name?.toLowerCase().includes('swagger')
        ) {
          if (typeof artifact.content === 'string') {
            const parsed = this.tryParseApiSpecFromText(artifact.content);
            if (parsed) {
              return {
                ...parsed,
                updatedAt: Date.now(),
                producedBy: workerId,
              };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * 检测是否是 backend 或 API 相关的 worker
   */
  private isBackendOrApiWorker(workerId: string, subtask: SubTask): boolean {
    const backendKeywords = ['backend', 'api', 'server', 'endpoint'];
    const workerIdLower = workerId.toLowerCase();
    const objectiveLower = subtask.objective.toLowerCase();
    const roleIdLower = (subtask.roleId ?? '').toLowerCase();

    if (backendKeywords.some((k) => workerIdLower.includes(k))) return true;
    if (backendKeywords.some((k) => objectiveLower.includes(k))) return true;
    if (backendKeywords.some((k) => roleIdLower.includes(k))) return true;

    return false;
  }

  /**
   * 规范化 API endpoints
   */
  private normalizeApiEndpoints(endpoints: unknown[]): ApiEndpoint[] {
    return endpoints
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map((e) => ({
        path: typeof e.path === 'string' ? e.path : String(e.path ?? '/unknown'),
        method: typeof e.method === 'string' ? e.method.toUpperCase() : 'GET',
        description: typeof e.description === 'string' ? e.description : '',
        ...(e.requestParams && typeof e.requestParams === 'object'
          ? { requestParams: e.requestParams as Record<string, string> }
          : {}),
        ...(e.responseFormat && typeof e.responseFormat === 'object'
          ? { responseFormat: JSON.stringify(e.responseFormat) }
          : {}),
      }));
  }

  /**
   * 尝试从文本中解析 API 规格
   */
  private tryParseApiSpecFromText(
    text: string
  ): { endpoints: ApiEndpoint[]; baseUrl?: string } | null {
    // 尝试找到 JSON 块
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
      text.match(/(\{[\s\S]*"endpoints"[\s\S]*\})/);

    if (!jsonMatch) return null;

    try {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(jsonStr);

      if (Array.isArray(parsed.endpoints)) {
        return {
          endpoints: this.normalizeApiEndpoints(parsed.endpoints),
          baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
        };
      }

      if (Array.isArray(parsed)) {
        return { endpoints: this.normalizeApiEndpoints(parsed) };
      }
    } catch {
      // JSON 解析失败
    }

    return null;
  }
}

/**
 * 创建集成上下文服务实例
 */
export function createIntegrationContextService(options: {
  sessionManager: ISessionFileManager;
  config?: Partial<IntegrationContextConfig>;
}): IntegrationContextService {
  return new IntegrationContextService(options);
}

/**
 * hybrid_search 工具
 *
 * 结合 RAG 向量搜索和 Agentic 代码搜索的混合搜索工具。
 * 流程：先用 RAG 快速筛选候选文件，再用 code_search 精确验证。
 *
 * @layer Atomic
 * @category Search
 */

import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';
import { KnowledgeBase } from '../../rag';
import { codeSearchTool } from '../core/code-search';
import { resolve } from 'path';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * hybrid_search 输入
 */
interface HybridSearchInput {
  /** 搜索查询 */
  query: string;
  
  /** RAG 阶段返回的候选数量 (默认 10) */
  ragTopK?: number;
  
  /** RAG 最低相似度分数 (0-1, 默认 0.3) */
  ragMinScore?: number;
  
  /** 是否跳过 RAG 阶段直接使用 code_search (默认 false) */
  skipRag?: boolean;
  
  /** code_search 文件类型过滤 */
  fileTypes?: string[];
}

/**
 * 单个候选文件结果
 */
interface CandidateFile {
  /** 文件路径 */
  path: string;
  /** RAG 相似度分数 (如果来自 RAG) */
  ragScore?: number;
  /** 是否通过 code_search 验证 */
  verified: boolean;
  /** 匹配行号 (如果验证成功) */
  matchedLines?: number[];
}

/**
 * hybrid_search 输出
 */
interface HybridSearchOutput {
  /** 验证后的相关文件列表 */
  files: CandidateFile[];
  /** 总文件数 */
  totalFiles: number;
  /** 已验证文件数 */
  verifiedFiles: number;
  /** RAG 阶段耗时 (ms) */
  ragLatencyMs: number;
  /** 验证阶段耗时 (ms) */
  verifyLatencyMs: number;
  /** 是否使用了 RAG (可能因配置或错误跳过) */
  usedRag: boolean;
  /** 降级信息 (如果有) */
  degradationInfo?: string | undefined;
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * hybrid_search 工具定义
 * 
 * 两阶段搜索：
 * 1. RAG 阶段：向量相似度搜索，快速召回候选文件 (<100ms)
 * 2. 验证阶段：并行 code_search，在候选文件中精确匹配
 */
export const hybridSearchTool: Tool = {
  name: 'hybrid_search',
  title: 'Hybrid Search',
  description: `RAG + Agentic 混合搜索工具。

两阶段搜索流程：
1. **RAG 阶段**: 用知识库向量搜索快速筛选候选文件 (top-K)
2. **验证阶段**: 对候选文件并行执行 code_search 确认相关性

适用场景：
- 大型代码库查找相关文件
- 需要平衡速度和准确性的搜索
- RAG 预索引可用时的优化搜索

输入参数：
- query: 搜索查询
- ragTopK: RAG 召回数量 (默认 10)
- skipRag: 跳过 RAG 阶段 (默认 false)`,

  layer: ToolLayer.Atomic,
  category: ToolCategory.Search,
  permissions: [ToolPermission.FileSystemRead],

  annotations: {
    idempotent: true,
    cacheable: true,
    estimatedDuration: 2000, // ~2s 包含 RAG + 验证
    priority: 6,
  },

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询（支持自然语言或关键词）',
      },
      ragTopK: {
        type: 'number',
        description: 'RAG 阶段召回的候选文件数量（默认 10）',
        default: 10,
      },
      ragMinScore: {
        type: 'number',
        description: 'RAG 最低相似度阈值 (0-1，默认 0.3)',
        default: 0.3,
      },
      skipRag: {
        type: 'boolean',
        description: '跳过 RAG 阶段，直接全量 code_search（默认 false）',
        default: false,
      },
      fileTypes: {
        type: 'array',
        items: { type: 'string' },
        description: '文件类型过滤（如 [".ts", ".js"]）',
      },
    },
    required: ['query'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            ragScore: { type: 'number' },
            verified: { type: 'boolean' },
            matchedLines: { type: 'array', items: { type: 'number' } },
          },
        },
      },
      totalFiles: { type: 'number' },
      verifiedFiles: { type: 'number' },
      ragLatencyMs: { type: 'number' },
      verifyLatencyMs: { type: 'number' },
      usedRag: { type: 'boolean' },
      degradationInfo: { type: 'string' },
    },
  },

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<HybridSearchOutput>> {
    const typedInput = input as HybridSearchInput;

    // 验证输入
    if (!typedInput.query || typeof typedInput.query !== 'string') {
      return {
        success: false,
        error: 'query 字段必须为非空字符串',
      };
    }

    const ragTopK = typedInput.ragTopK ?? 10;
    const ragMinScore = typedInput.ragMinScore ?? 0.3;
    const skipRag = typedInput.skipRag ?? false;
    const fileTypes = typedInput.fileTypes;

    const candidates: CandidateFile[] = [];
    let ragLatencyMs = 0;
    let usedRag = false;
    let degradationInfo: string | undefined;

    // =========================================================
    // 阶段 1: RAG 快速召回
    // =========================================================
    if (!skipRag) {
      const ragStart = Date.now();
      try {
        const apiKey = context.env?.OPENAI_API_KEY as string | undefined;
        const workDir = context.workDir || process.cwd();
        const storagePath = resolve(workDir, '.tachikoma', 'knowledge', 'vectors.json');

        const kb = new KnowledgeBase({
          storagePath,
          embeddingConfig: {
            provider: apiKey ? 'openai' : 'mock',
            apiKey: apiKey || '',
          },
        });

        await kb.initialize();

        const ragResults = await kb.search(typedInput.query, ragTopK, ragMinScore);

        for (const result of ragResults) {
          const sourcePath = result.metadata.sourcePath as string | undefined;
          if (sourcePath && !candidates.some(c => c.path === sourcePath)) {
            candidates.push({
              path: sourcePath,
              ragScore: result.score,
              verified: false,
            });
          }
        }

        usedRag = true;
        ragLatencyMs = Date.now() - ragStart;
        console.debug(`[HybridSearch] RAG phase: ${candidates.length} candidates in ${ragLatencyMs}ms`);
      } catch (ragError) {
        degradationInfo = `RAG 阶段失败 (${ragError instanceof Error ? ragError.message : String(ragError)}), 降级为纯 code_search`;
        console.warn(`[HybridSearch] ${degradationInfo}`);
        ragLatencyMs = Date.now() - ragStart;
      }
    } else {
      console.debug('[HybridSearch] RAG phase skipped (skipRag=true)');
    }

    // =========================================================
    // 阶段 2: code_search 验证 / 全量搜索
    // =========================================================
    const verifyStart = Date.now();
    
    // 并发限制器（复用 FAS P0 模式）
    const MAX_VERIFY_CONCURRENCY = 6;
    let runningVerify = 0;
    const verifyQueue: (() => void)[] = [];
    
    const acquireVerify = (): Promise<void> => {
      return new Promise((resolve) => {
        if (runningVerify < MAX_VERIFY_CONCURRENCY) {
          runningVerify++;
          resolve();
        } else {
          verifyQueue.push(resolve);
        }
      });
    };
    
    const releaseVerify = (): void => {
      runningVerify--;
      const next = verifyQueue.shift();
      if (next) {
        runningVerify++;
        next();
      }
    };

    if (candidates.length > 0) {
      // 对候选文件并行验证（带并发限制）
      const verifyResults = await Promise.allSettled(
        candidates.map(async (candidate) => {
          await acquireVerify();
          try {
            const result = await codeSearchTool.execute(
              {
                pattern: typedInput.query, // 使用完整 query，而非首词
                path: candidate.path,
                maxResults: 10,
                fileTypes,
              },
              context
            );

            const typedResult = result as ToolResult<{matches?: {file: string; line: number}[]}>;
            if (typedResult.success && typedResult.data) {
              const matches = typedResult.data.matches || [];
              if (matches.length > 0) {
                candidate.verified = true;
                candidate.matchedLines = matches.map(m => m.line);
              }
            }

            return candidate;
          } finally {
            releaseVerify();
          }
        })
      );

      // 更新验证状态
      for (let i = 0; i < verifyResults.length; i++) {
        const result = verifyResults[i];
        if (result && result.status === 'fulfilled') {
          candidates[i] = result.value;
        }
      }
    } else {
      // RAG 无结果或 skipRag=true，都使用全量 code_search
      console.debug('[HybridSearch] No candidates, using full code_search');
      
      const fallbackResult = (await codeSearchTool.execute(
        {
          pattern: typedInput.query,
          path: '.',
          maxResults: 20,
          fileTypes,
        },
        context
      )) as { success: boolean; data?: unknown };

      if (fallbackResult.success && fallbackResult.data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const matches = (fallbackResult.data as any).matches || [];
        const seenPaths = new Set<string>();
        
        for (const match of matches) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const filePath = (match as any).file;
          if (filePath && !seenPaths.has(filePath)) {
            seenPaths.add(filePath);
            candidates.push({
              path: filePath,
              verified: true,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              matchedLines: matches.filter((m: any) => m.file === filePath).map((m: any) => m.line),
            });
          }
        }
      }
    }

    const verifyLatencyMs = Date.now() - verifyStart;
    const verifiedFiles = candidates.filter(c => c.verified).length;

    console.debug(
      `[HybridSearch] Verify phase: ${verifiedFiles}/${candidates.length} verified in ${verifyLatencyMs}ms`
    );

    return {
      success: true,
      data: {
        files: candidates,
        totalFiles: candidates.length,
        verifiedFiles,
        ragLatencyMs,
        verifyLatencyMs,
        usedRag,
        degradationInfo,
      },
    };
  },
};

export default hybridSearchTool;

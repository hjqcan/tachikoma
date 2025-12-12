/**
 * report_back 工具
 *
 * 搜索子智能体使用此工具汇总搜索结果并返回给主智能体。
 * 调用此工具将终止子任务执行并返回打包好的上下文。
 *
 * @layer Atomic
 * @category Agent
 */

import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 文件行号范围
 * [startLine, endLine] 表示从 startLine 到 endLine（包含）
 */
type LineRange = [number, number];

/**
 * 文件相关性条目
 */
interface FileRelevance {
  /** 文件路径（相对于工作目录） */
  path: string;
  /** 相关行号范围列表（如果整个文件相关，可为空数组） */
  lineRanges: LineRange[];
  /** 相关性说明（可选） */
  reason?: string;
}

/**
 * report_back 输入
 */
interface ReportBackInput {
  /** 搜索结果说明（解释为什么这些文件相关） */
  explanation: string;
  
  /** 
   * 相关文件映射
   * key: 文件路径, value: 行号范围数组
   * 例如: { "src/auth.ts": [[10, 50], [100, 150]] }
   */
  files: Record<string, LineRange[]>;
  
  /** 置信度评分 (0.0-1.0，可选) */
  confidence?: number;
  
  /** 建议的下一步操作（可选） */
  suggestedActions?: string[];
}

/**
 * report_back 输出
 */
interface ReportBackOutput {
  /** 搜索结果说明 */
  explanation: string;
  /** 结构化的文件相关性列表 */
  relevantFiles: FileRelevance[];
  /** 文件总数 */
  fileCount: number;
  /** 总行数范围 */
  totalLineRanges: number;
  /** 置信度评分 */
  confidence: number;
  /** 建议的下一步操作 */
  suggestedActions: string[];
  /** 是否终止子任务 */
  terminateSubtask: boolean;
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * report_back 工具定义
 * 
 * 用于搜索子智能体汇总并报告搜索结果。
 * 调用此工具会标记子任务完成，将结果返回给主智能体。
 */
export const reportBackTool: Tool = {
  name: 'report_back',
  title: 'Report Back',
  description: `汇总搜索结果并返回给主智能体。

**重要**: 搜索子任务必须调用此工具来结束搜索并报告发现。

使用场景:
- 完成代码库搜索后，打包相关文件列表
- 汇总多个搜索工具的结果
- 终止搜索子任务并返回上下文

输入格式:
- explanation: 解释为什么这些文件相关
- files: 文件路径到行号范围的映射
- confidence: 置信度评分 (可选)
- suggestedActions: 建议的下一步操作 (可选)`,

  layer: ToolLayer.Atomic,
  category: ToolCategory.Agent,
  permissions: [ToolPermission.Agent],

  annotations: {
    idempotent: true,
    cacheable: false,
    estimatedDuration: 100,
    priority: 10, // 高优先级，表示任务完成
  },

  inputSchema: {
    type: 'object',
    properties: {
      explanation: {
        type: 'string',
        description: '搜索结果说明（解释为什么这些文件相关）',
      },
      files: {
        type: 'object',
        description: '相关文件映射：路径 -> 行号范围数组（例如 [[10,50], [100,150]]）',
        additionalProperties: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
          },
        },
      },
      confidence: {
        type: 'number',
        description: '置信度评分 (0.0-1.0)',
        minimum: 0,
        maximum: 1,
      },
      suggestedActions: {
        type: 'array',
        items: { type: 'string' },
        description: '建议的下一步操作',
      },
    },
    required: ['explanation', 'files'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      explanation: { type: 'string' },
      relevantFiles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            lineRanges: { type: 'array' },
            reason: { type: 'string' },
          },
        },
      },
      fileCount: { type: 'number' },
      totalLineRanges: { type: 'number' },
      confidence: { type: 'number' },
      suggestedActions: { type: 'array' },
      terminateSubtask: { type: 'boolean' },
    },
  },

  async execute(
    input: unknown,
    _context: ExecutionContext
  ): Promise<ToolResult<ReportBackOutput>> {
    const typedInput = input as ReportBackInput;

    // 验证输入
    if (!typedInput.explanation || typeof typedInput.explanation !== 'string') {
      return {
        success: false,
        error: 'explanation 字段必须为非空字符串',
      };
    }

    if (!typedInput.files || typeof typedInput.files !== 'object') {
      return {
        success: false,
        error: 'files 字段必须为对象',
      };
    }

    // 转换 files 对象为结构化列表
    const relevantFiles: FileRelevance[] = [];
    let totalLineRanges = 0;

    for (const [path, ranges] of Object.entries(typedInput.files)) {
      // 验证行号范围格式
      const validRanges: LineRange[] = [];
      if (Array.isArray(ranges)) {
        for (const range of ranges) {
          if (
            Array.isArray(range) &&
            range.length === 2 &&
            typeof range[0] === 'number' &&
            typeof range[1] === 'number' &&
            range[0] <= range[1]
          ) {
            validRanges.push(range as LineRange);
          }
        }
      }

      relevantFiles.push({
        path,
        lineRanges: validRanges,
      });

      totalLineRanges += validRanges.length;
    }

    const output: ReportBackOutput = {
      explanation: typedInput.explanation,
      relevantFiles,
      fileCount: relevantFiles.length,
      totalLineRanges,
      confidence: typedInput.confidence ?? 0.8,
      suggestedActions: typedInput.suggestedActions ?? [],
      terminateSubtask: true, // 标记子任务完成
    };

    return {
      success: true,
      data: output,
    };
  },
};

export default reportBackTool;

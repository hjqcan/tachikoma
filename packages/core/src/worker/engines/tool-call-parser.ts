/**
 * Tool Call Parser
 *
 * 解析 LLM 响应中的工具调用，支持多种格式：
 * - JSON 格式：{"tool": "name", "input": {...}}
 * - XML 格式：<tool_use><name>...</name><input>...</input></tool_use>
 * - Function Calling 格式（SDK 原生响应）
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 解析后的工具调用
 */
export interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
  callId: string;
}

/**
 * 工具调用分类结果
 */
export interface ClassifiedToolCalls {
  /** 可并行执行的工具调用 */
  parallel: ParsedToolCall[];
  /** 需顺序执行的工具调用 */
  sequential: ParsedToolCall[];
}

/**
 * 工具分类配置
 */
export interface ToolClassificationConfig {
  /** 可并行化的工具列表 */
  parallelizableTools?: string[];
  /** 排除并行化的工具列表 */
  excludeTools?: string[];
}

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 单次响应最大工具调用数
 * 防止 LLM 幻觉生成大量重复调用
 */
export const MAX_CALLS_PER_RESPONSE = 20;

/**
 * 默认可并行工具列表（读取类）
 */
export const DEFAULT_PARALLELIZABLE_TOOLS = [
  'file_read',
  'file_list',
  'file_search',
  'file_stat',
  'grep',
  'web_search',
  'fetch_url',
];

// ============================================================================
// 解析函数
// ============================================================================

/**
 * 解析文本中的工具调用
 *
 * 支持多种格式：
 * - JSON 格式：{"tool": "name", "input": {...}}
 * - XML 格式：<tool_use><name>...</name><input>...</input></tool_use>
 */
export function parseToolCalls(content: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  // 尝试解析 JSON 格式
  try {
    const jsonMatch = content.match(/\{[\s\S]*"tool"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.tool && typeof parsed.tool === 'string') {
        if (calls.length >= MAX_CALLS_PER_RESPONSE) {
          console.warn(
            `[parseToolCalls] Truncated: reached max ${MAX_CALLS_PER_RESPONSE} calls per response.`
          );
          return calls;
        }
        calls.push({
          name: parsed.tool,
          input: parsed.input || parsed.arguments || {},
          callId: `call-${Date.now()}`,
        });
      }
    }
  } catch {
    // 继续尝试其他格式
  }

  // 尝试解析 XML 格式（Claude 风格）
  const xmlRegex = /<tool_use>([\s\S]*?)<\/tool_use>/g;
  let xmlMatch;
  while ((xmlMatch = xmlRegex.exec(content)) !== null) {
    if (calls.length >= MAX_CALLS_PER_RESPONSE) {
      console.warn(
        `[parseToolCalls] Truncated: reached max ${MAX_CALLS_PER_RESPONSE} calls per response.`
      );
      break;
    }

    const toolBlock = xmlMatch[1];
    const nameMatch = toolBlock?.match(/<name>(.*?)<\/name>/);
    const inputMatch = toolBlock?.match(/<input>([\s\S]*?)<\/input>/);

    if (nameMatch && nameMatch[1]) {
      let input = {};
      if (inputMatch && inputMatch[1]) {
        try {
          input = JSON.parse(inputMatch[1]);
        } catch {
          input = { raw: inputMatch[1] };
        }
      }

      calls.push({
        name: nameMatch[1],
        input,
        callId: `call-${Date.now()}-${calls.length}`,
      });
    }
  }

  return calls;
}

/**
 * 解析 Function Calling 格式的工具调用（原生 SDK 响应）
 * 
 * @param toolCalls - LLM 返回的 tool_calls 数组
 */
export function parseFunctionCalls(
  toolCalls: {
    id: string;
    name: string;
    arguments?: string | Record<string, unknown>;
    input?: string | Record<string, unknown>;
  }[]
): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  for (const call of toolCalls) {
    if (calls.length >= MAX_CALLS_PER_RESPONSE) {
      console.warn(
        `[parseFunctionCalls] Truncated: reached max ${MAX_CALLS_PER_RESPONSE} calls.`
      );
      break;
    }

    const rawArgs = call.arguments ?? call.input;
    let input: Record<string, unknown> = {};
    if (typeof rawArgs === 'string') {
      try {
        input = JSON.parse(rawArgs);
      } catch {
        input = { raw: rawArgs };
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      input = rawArgs;
    }

    calls.push({
      name: call.name,
      input,
      callId: call.id,
    });
  }

  return calls;
}

/**
 * 判断响应是否包含工具调用
 */
export function containsToolCall(content: string): boolean {
  return (
    content.includes('"tool"') ||
    content.includes('<tool_use>') ||
    content.includes('tool_call')
  );
}

// ============================================================================
// 分类函数
// ============================================================================

/**
 * 将工具调用分类为可并行和需顺序执行两组
 */
export function classifyToolCalls(
  toolCalls: ParsedToolCall[],
  config: ToolClassificationConfig = {}
): ClassifiedToolCalls {
  const parallel: ParsedToolCall[] = [];
  const sequential: ParsedToolCall[] = [];

  const parallelizableSet = new Set(
    config.parallelizableTools ?? DEFAULT_PARALLELIZABLE_TOOLS
  );
  const excludeSet = new Set(config.excludeTools ?? []);

  for (const call of toolCalls) {
    if (excludeSet.has(call.name)) {
      sequential.push(call);
    } else if (parallelizableSet.has(call.name)) {
      parallel.push(call);
    } else {
      // 未知工具默认顺序执行（安全保守）
      sequential.push(call);
    }
  }

  return { parallel, sequential };
}

// ============================================================================
// 并发控制
// ============================================================================

/**
 * 并发限制器
 */
export interface ConcurrencyLimiter {
  acquire(): Promise<void>;
  release(): void;
}

/**
 * 创建并发限制器
 */
export function createConcurrencyLimiter(maxConcurrency: number): ConcurrencyLimiter {
  let running = 0;
  const queue: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    return new Promise((resolve) => {
      if (running < maxConcurrency) {
        running++;
        resolve();
      } else {
        queue.push(resolve);
      }
    });
  };

  const release = (): void => {
    running--;
    const next = queue.shift();
    if (next) {
      running++;
      next();
    }
  };

  return { acquire, release };
}

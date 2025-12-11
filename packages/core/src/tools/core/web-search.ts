/**
 * web_search - 网络搜索工具
 *
 * 支持多种搜索API提供商：
 * - Brave Search API (推荐，有免费额度)
 * - SerpAPI
 * - Tavily (AI搜索优化)
 *
 * 配置: 在 context.env 中设置：
 * - SEARCH_API_KEY: API密钥
 * - SEARCH_PROVIDER: 提供商 (brave/serp/tavily)，默认 brave
 *
 * @layer Atomic
 * @category Network
 * @permissions NetworkRead
 */

import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';

/**
 * 搜索结果项
 */
interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 搜索输出
 */
interface WebSearchOutput {
  query: string;
  results: SearchResultItem[];
  totalResults: number;
  searchTime: number;
  provider: string;
}

/**
 * 验证输入
 */
function validateInput(input: unknown): {
  valid: boolean;
  error?: string;
  data?: { query: string; maxResults: number };
} {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }
  const obj = input as Record<string, unknown>;
  if (!obj.query || typeof obj.query !== 'string') {
    return { valid: false, error: 'query is required and must be a string' };
  }
  if (obj.query.trim().length === 0) {
    return { valid: false, error: 'query cannot be empty' };
  }
  if (obj.maxResults !== undefined && typeof obj.maxResults !== 'number') {
    return { valid: false, error: 'maxResults must be a number' };
  }
  return {
    valid: true,
    data: {
      query: obj.query.trim(),
      maxResults: Math.min((obj.maxResults as number) ?? 10, 20),
    },
  };
}

/**
 * Brave Search API
 * 文档: https://api.search.brave.com/
 */
async function searchBrave(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<SearchResultItem[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brave Search API error: ${response.status} - ${text}`);
  }

  const data = await response.json() as {
    web?: {
      results?: Array<{
        title: string;
        url: string;
        description: string;
      }>;
    };
  };

  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

/**
 * SerpAPI
 * 文档: https://serpapi.com/
 */
async function searchSerp(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<SearchResultItem[]> {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(maxResults));
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('engine', 'google');

  const response = await fetch(url.toString());

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SerpAPI error: ${response.status} - ${text}`);
  }

  const data = await response.json() as {
    organic_results?: Array<{
      title: string;
      link: string;
      snippet: string;
    }>;
  };

  return (data.organic_results ?? []).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
  }));
}

/**
 * Tavily API (AI搜索优化)
 * 文档: https://tavily.com/
 */
async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<SearchResultItem[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tavily API error: ${response.status} - ${text}`);
  }

  const data = await response.json() as {
    results?: Array<{
      title: string;
      url: string;
      content: string;
    }>;
  };

  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content.substring(0, 200),
  }));
}

/**
 * DuckDuckGo Instant Answer API (无需API Key，但结果有限)
 */
async function searchDuckDuckGo(
  query: string,
  _maxResults: number
): Promise<SearchResultItem[]> {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_redirect', '1');

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`DuckDuckGo API error: ${response.status}`);
  }

  const data = await response.json() as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{
      Text?: string;
      FirstURL?: string;
    }>;
  };

  const results: SearchResultItem[] = [];

  // 主结果
  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading ?? query,
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }

  // 相关主题
  for (const topic of data.RelatedTopics ?? []) {
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.split(' - ')[0] ?? topic.Text,
        url: topic.FirstURL,
        snippet: topic.Text,
      });
    }
  }

  return results;
}

/**
 * web_search 工具定义
 */
export const webSearchTool: Tool = {
  name: 'web_search',
  title: 'Web Search',
  description: `执行网络搜索，返回相关网页结果。

支持的搜索提供商：
- brave（推荐，有免费额度）
- serp（SerpAPI，Google结果）
- tavily（AI搜索优化）
- duckduckgo（无需API Key，结果有限）

配置环境变量：
- SEARCH_API_KEY: API密钥
- SEARCH_PROVIDER: 提供商名称（默认brave）

如果未配置API Key，将使用DuckDuckGo（结果有限）。`,

  layer: ToolLayer.Atomic,
  category: ToolCategory.Network,
  permissions: [ToolPermission.NetworkRead],

  annotations: {
    idempotent: true,
    cacheable: true,
    estimatedDuration: 2000,
    priority: 3,
  },

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询字符串',
      },
      maxResults: {
        type: 'number',
        description: '最大返回结果数（默认10，最大20）',
        default: 10,
      },
    },
    required: ['query'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            snippet: { type: 'string' },
          },
        },
      },
      totalResults: { type: 'number' },
      searchTime: { type: 'number' },
      provider: { type: 'string' },
    },
  },

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<WebSearchOutput>> {
    // 输入校验
    const validation = validateInput(input);
    if (!validation.valid || !validation.data) {
      return { success: false, error: `Invalid input: ${validation.error}` };
    }

    const { query, maxResults } = validation.data;
    const startTime = Date.now();

    // 获取配置
    const apiKey = context.env?.SEARCH_API_KEY;
    const provider = (context.env?.SEARCH_PROVIDER ?? 'duckduckgo').toLowerCase();

    try {
      let results: SearchResultItem[];
      let usedProvider: string;

      if (!apiKey) {
        // 无API Key时使用DuckDuckGo
        results = await searchDuckDuckGo(query, maxResults);
        usedProvider = 'duckduckgo';
      } else {
        switch (provider) {
          case 'brave':
            results = await searchBrave(query, maxResults, apiKey);
            usedProvider = 'brave';
            break;
          case 'serp':
          case 'serpapi':
            results = await searchSerp(query, maxResults, apiKey);
            usedProvider = 'serpapi';
            break;
          case 'tavily':
            results = await searchTavily(query, maxResults, apiKey);
            usedProvider = 'tavily';
            break;
          default:
            // 默认使用Brave
            results = await searchBrave(query, maxResults, apiKey);
            usedProvider = 'brave';
        }
      }

      return {
        success: true,
        data: {
          query,
          results: results.slice(0, maxResults),
          totalResults: results.length,
          searchTime: Date.now() - startTime,
          provider: usedProvider,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: `Search failed: ${err.message}`,
      };
    }
  },
};

export default webSearchTool;

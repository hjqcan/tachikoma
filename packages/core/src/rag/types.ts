/**
 * RAG (Retrieval-Augmented Generation) 类型定义
 */

/**
 * 向量嵌入
 */
export type Embedding = number[];

/**
 * 文档切片
 */
export interface DocumentChunk {
  /** 唯一 ID */
  id: string;
  /** 文本内容 */
  content: string;
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 向量嵌入 */
  embedding?: Embedding;
}

/**
 * 检索结果
 */
export interface SearchResult extends DocumentChunk {
  /** 相似度分数 (0-1) */
  score: number;
}

/**
 * 向量存储接口
 */
export interface IVectorStore {
  /**
   * 添加文档切片
   */
  add(chunks: DocumentChunk[]): Promise<void>;

  /**
   * 搜索相似文档
   * @param queryEmbedding 查询向量
   * @param limit 返回数量限制
   * @param minScore 最小相似度分数
   */
  search(
    queryEmbedding: Embedding,
    limit?: number,
    minScore?: number
  ): Promise<SearchResult[]>;

  /**
   * 保存到文件/存储
   */
  save(path: string): Promise<void>;

  /**
   * 从文件/存储加载
   */
  load(path: string): Promise<void>;
  
  /**
   * 清空存储
   */
  clear(): Promise<void>;

  /**
   * 获取 chunks 总数（可选方法）
   */
  count?(): number | Promise<number>;
}

/**
 * 知识库配置
 */
export interface KnowledgeBaseConfig {
  /** 向量存储实例 (可选，默认使用 SimpleVectorStore) */
  vectorStore?: IVectorStore;
  /** Embedding 模型配置 */
  embeddingConfig?: {
    provider: 'openai' | 'anthropic' | 'mock'; // 暂时支持 mock 用于测试
    apiKey?: string;
    model?: string;
  };
  /** 存储路径 */
  storagePath?: string;
}

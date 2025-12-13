/**
 * 向量存储模块
 *
 * 提供向量相似度搜索，用于语义记忆检索
 *
 * @module prompt/memory/vector-store
 */

// ============================================================================
// 向量类型定义
// ============================================================================

/**
 * 向量嵌入
 */
export type Embedding = number[];

/**
 * 向量条目
 */
export interface VectorEntry {
  /** 条目 ID */
  id: string;

  /** 原始内容 */
  content: string;

  /** 向量嵌入 */
  embedding: Embedding;

  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 向量搜索结果
 */
export interface VectorSearchResult {
  /** 条目 */
  entry: VectorEntry;

  /** 相似度分数 (0-1) */
  score: number;
}

/**
 * 嵌入生成器接口
 */
export interface IEmbeddingProvider {
  /**
   * 生成单个文本的嵌入
   */
  embed(text: string): Promise<Embedding>;

  /**
   * 批量生成嵌入
   */
  embedBatch(texts: string[]): Promise<Embedding[]>;

  /**
   * 获取嵌入维度
   */
  getDimension(): number;
}

/**
 * 向量存储接口
 */
export interface IVectorStore {
  /**
   * 添加条目
   */
  add(entry: VectorEntry): Promise<void>;

  /**
   * 批量添加
   */
  addBatch(entries: VectorEntry[]): Promise<void>;

  /**
   * 向量相似度搜索
   *
   * @param query - 查询向量
   * @param topK - 返回前 K 个结果
   * @param threshold - 相似度阈值 (0-1)
   */
  search(
    query: Embedding,
    topK?: number,
    threshold?: number
  ): Promise<VectorSearchResult[]>;

  /**
   * 通过 ID 获取条目
   */
  get(id: string): Promise<VectorEntry | null>;

  /**
   * 删除条目
   */
  delete(id: string): Promise<boolean>;

  /**
   * 清空存储
   */
  clear(): Promise<void>;

  /**
   * 获取条目数量
   */
  size(): number;
}

// ============================================================================
// 内存向量存储
// ============================================================================

/**
 * 内存向量存储配置
 */
export interface InMemoryVectorStoreConfig {
  /**
   * 相似度计算方法
   *
   * - cosine: 余弦相似度 (0-1)，最常用
   * - euclidean: 欧几里得距离转换为相似度 (0-1)
   * - dot: 点积，要求输入向量已归一化，否则分数语义不确定
   */
  similarityMethod: 'cosine' | 'euclidean' | 'dot';

  /** 默认 topK */
  defaultTopK: number;

  /** 默认相似度阈值 */
  defaultThreshold: number;
}

/**
 * 默认配置
 */
export const DEFAULT_VECTOR_STORE_CONFIG: InMemoryVectorStoreConfig = {
  similarityMethod: 'cosine',
  defaultTopK: 10,
  defaultThreshold: 0.5,
};

/**
 * 内存向量存储
 *
 * 简单的内存实现，适用于小规模数据（<10k 条目）
 * 生产环境建议使用专用向量数据库（如 Pinecone, Weaviate）
 */
export class InMemoryVectorStore implements IVectorStore {
  private readonly config: InMemoryVectorStoreConfig;
  private entries = new Map<string, VectorEntry>();

  constructor(config: Partial<InMemoryVectorStoreConfig> = {}) {
    this.config = { ...DEFAULT_VECTOR_STORE_CONFIG, ...config };
  }

  async add(entry: VectorEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async addBatch(entries: VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  async search(
    query: Embedding,
    topK?: number,
    threshold?: number
  ): Promise<VectorSearchResult[]> {
    const k = topK ?? this.config.defaultTopK;
    const minScore = threshold ?? this.config.defaultThreshold;

    const results: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      const score = this.computeSimilarity(query, entry.embedding);

      if (score >= minScore) {
        results.push({ entry, score });
      }
    }

    // 按分数降序排序
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, k);
  }

  async get(id: string): Promise<VectorEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  // ========================================
  // 相似度计算
  // ========================================

  private computeSimilarity(a: Embedding, b: Embedding): number {
    switch (this.config.similarityMethod) {
      case 'cosine':
        return this.cosineSimilarity(a, b);
      case 'euclidean':
        return this.euclideanSimilarity(a, b);
      case 'dot':
        return this.dotProduct(a, b);
    }
  }

  private cosineSimilarity(a: Embedding, b: Embedding): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += (a[i] ?? 0) * (b[i] ?? 0);
      normA += (a[i] ?? 0) * (a[i] ?? 0);
      normB += (b[i] ?? 0) * (b[i] ?? 0);
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  private euclideanSimilarity(a: Embedding, b: Embedding): number {
    if (a.length !== b.length) return 0;

    let sumSquares = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      sumSquares += diff * diff;
    }

    const distance = Math.sqrt(sumSquares);
    // 将距离转换为相似度 (0-1)
    return 1 / (1 + distance);
  }

  private dotProduct(a: Embedding, b: Embedding): number {
    if (a.length !== b.length) return 0;

    let product = 0;
    for (let i = 0; i < a.length; i++) {
      product += (a[i] ?? 0) * (b[i] ?? 0);
    }

    // 注意：此方法假定向量已归一化，结果在 [-1, 1] 范围
    // 将其映射到 [0, 1] 以保持与其他方法一致的接口
    // 如果向量未归一化，分数可能被 clamp 到 0 或 1
    return Math.max(0, Math.min(1, (product + 1) / 2));
  }
}

// ============================================================================
// 简单嵌入生成器（用于测试）
// ============================================================================

/**
 * 简单嵌入生成器
 *
 * 基于字符频率生成嵌入，仅用于测试
 * 生产环境应使用 OpenAI、Cohere 等嵌入 API
 */
export class SimpleEmbeddingProvider implements IEmbeddingProvider {
  private readonly dimension: number;

  constructor(dimension = 128) {
    this.dimension = dimension;
  }

  async embed(text: string): Promise<Embedding> {
    return this.generateEmbedding(text);
  }

  async embedBatch(texts: string[]): Promise<Embedding[]> {
    return texts.map((t) => this.generateEmbedding(t));
  }

  getDimension(): number {
    return this.dimension;
  }

  private generateEmbedding(text: string): Embedding {
    const embedding = new Array(this.dimension).fill(0) as number[];
    const normalizedText = text.toLowerCase();

    // 基于字符频率生成嵌入
    for (let i = 0; i < normalizedText.length; i++) {
      const charCode = normalizedText.charCodeAt(i);
      const index = charCode % this.dimension;
      embedding[index] = (embedding[index] ?? 0) + 1;
    }

    // 归一化
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] = (embedding[i] ?? 0) / norm;
      }
    }

    return embedding;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建内存向量存储
 */
export function createInMemoryVectorStore(
  config?: Partial<InMemoryVectorStoreConfig>
): InMemoryVectorStore {
  return new InMemoryVectorStore(config);
}

/**
 * 创建简单嵌入生成器
 */
export function createSimpleEmbeddingProvider(
  dimension?: number
): SimpleEmbeddingProvider {
  return new SimpleEmbeddingProvider(dimension);
}

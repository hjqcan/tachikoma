/**
 * 知识库管理器
 *
 * 负责文档的摄入（Embedding）和检索（Search）。
 */

import { createOpenAI } from '@ai-sdk/openai';
import { embedMany } from 'ai';
import { randomUUID } from 'node:crypto';
import type { KnowledgeBaseConfig, IVectorStore, DocumentChunk, SearchResult } from './types';
import { SimpleVectorStore } from './vector-store';
import { chunkText, mockEmbed } from './utils';

/** Embedding batch configuration */
export interface EmbeddingBatchConfig {
  batchSize?: number | undefined; // Default: 50
  batchDelayMs?: number | undefined; // Default: 1000
}

export class KnowledgeBase {
  private vectorStore: IVectorStore;
  private config: KnowledgeBaseConfig;
  private embeddingBatchConfig: EmbeddingBatchConfig;
  private static readonly MAX_CHUNKS_WARNING = 10000;

  constructor(config: KnowledgeBaseConfig = {}, batchConfig: EmbeddingBatchConfig = {}) {
    this.config = config;
    this.vectorStore = config.vectorStore || new SimpleVectorStore();
    this.embeddingBatchConfig = {
      batchSize: batchConfig.batchSize || 50,
      batchDelayMs: batchConfig.batchDelayMs || 1000,
    };
  }

  /**
   * 初始化（如加载持久化数据）
   */
  async initialize(): Promise<void> {
    if (this.config.storagePath) {
      await this.vectorStore.load(this.config.storagePath);
    }
  }

  /**
   * 保存状态
   */
  async save(): Promise<void> {
    if (this.config.storagePath) {
      await this.vectorStore.save(this.config.storagePath);
    }
  }

  /**
   * 添加文档
   *
   * 1. 文本切片
   * 2. 生成 Embedding（批量处理避免超限）
   * 3. 存入向量库
   * @returns Number of chunks created
   */
  async addDocument(
    sourceId: string,
    content: string,
    metadata: Record<string, unknown> = {}
  ): Promise<number> {
    // 1. 切片
    const textChunks = chunkText(content);

    // 2. 准备 chunks 对象，添加 chunkIndex 到 metadata
    const chunks: DocumentChunk[] = textChunks.map((text, index) => ({
      id: randomUUID(),
      content: text,
      metadata: { ...metadata, sourceId, chunkIndex: index },
    }));

    // 3. 生成 Embeddings with configurable batch throttling
    const batchSize = this.embeddingBatchConfig.batchSize || 50;
    const batchDelayMs = this.embeddingBatchConfig.batchDelayMs || 1000;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchTexts = batch.map((c) => c.content);

      const embeddings = await this.generateEmbeddings(batchTexts);

      batch.forEach((chunk, idx) => {
        chunk.embedding = embeddings[idx] || [];
      });

      // Delay between batches (except for the last batch)
      if (i + batchSize < chunks.length) {
        await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
      }
    }

    // 4. 存入
    await this.vectorStore.add(chunks);

    // 5. 检查总容量并警告
    const totalChunks = (await this.vectorStore.count?.()) || 0;
    if (totalChunks > KnowledgeBase.MAX_CHUNKS_WARNING) {
      console.warn(
        `⚠️  Knowledge base has ${totalChunks} chunks (>${KnowledgeBase.MAX_CHUNKS_WARNING}). ` +
          `Consider implementing cleanup/compression strategies.`
      );
    }

    // 6. 自动保存
    if (this.config.storagePath) {
      await this.save();
    }

    return chunks.length;
  }

  /**
   * 搜索
   */
  async search(query: string, limit = 3, minScore = 0.0): Promise<SearchResult[]> {
    // 1. 生成 Query Embedding
    const embeddings = await this.generateEmbeddings([query]);
    const queryEmbedding = embeddings[0];

    if (!queryEmbedding) {
      return [];
    }

    // 2. 向量搜索
    const results = await this.vectorStore.search(queryEmbedding, limit, minScore);
    return results;
  }

  /**
   * 生成 Embedding
   */
  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const provider = this.config.embeddingConfig?.provider || 'mock';

    if (provider === 'mock') {
      return texts.map((text) => mockEmbed(text));
    }

    // 使用 AI SDK 生成，并传入 apiKey
    try {
      let model;
      const modelName = this.config.embeddingConfig?.model;
      const apiKey = this.config.embeddingConfig?.apiKey;

      if (provider === 'openai') {
        // Pass apiKey to openai client
        const openaiClient = createOpenAI({ apiKey: apiKey || '' });
        model = openaiClient.embedding(modelName || 'text-embedding-3-small');
      } else if (provider === 'anthropic') {
        // Anthropic 目前官方没有 embedding 模型，暂时 fallback 或者报错
        // 这里只是示例逻辑
        throw new Error('Anthropic embedding not supported yet');
      } else {
        throw new Error(`Unknown embedding provider: ${provider}`);
      }

      const { embeddings } = await embedMany({
        model,
        values: texts,
      });

      return embeddings;
    } catch (error) {
      console.error('Embedding generation failed:', error);
      throw error;
    }
  }
}

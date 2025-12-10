/**
 * 简单向量存储实现
 * 
 * 基于内存 + 文件持久化的轻量级向量数据库。
 * 使用暴力余弦相似度计算，适用于中小规模数据 (<10k chunks)。
 */

import fs from 'fs/promises';
import { dirname } from 'path';
import type { IVectorStore, DocumentChunk, SearchResult, Embedding } from './types';
import { cosineSimilarity } from './utils';
import { fileExists, ensureDir } from '../orchestrator/session'; // 复用 session 中的工具函数

export class SimpleVectorStore implements IVectorStore {
  private chunks: DocumentChunk[] = [];

  constructor(initialChunks: DocumentChunk[] = []) {
    this.chunks = [...initialChunks];
  }

  async add(chunks: DocumentChunk[]): Promise<void> {
    this.chunks.push(...chunks);
  }

  /**
   * 搜索最相似的文档
   */
  search(queryEmbedding: number[], limit: number, minScore = 0.0): SearchResult[] {
    if (this.chunks.length === 0) {
      return [];
    }

    const results: SearchResult[] = this.chunks
      // Skip chunks without embeddings
      .filter((chunk) => chunk.embedding && chunk.embedding.length > 0)
      .map((chunk) => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding!),
      }))
      // Filter by minScore and sort by score descending
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return results;
  }

  /**
   * 获取 chunks 总数
   */
  count(): number {
    return this.chunks.length;
  }

  async save(path: string): Promise<void> {
    await ensureDir(dirname(path));
    const data = JSON.stringify(this.chunks, null, 2);
    await fs.writeFile(path, data, 'utf-8');
  }

  async load(path: string): Promise<void> {
    if (await fileExists(path)) {
      const data = await fs.readFile(path, 'utf-8');
      try {
        this.chunks = JSON.parse(data);
      } catch (error) {
        console.error(`Failed to parse vector store file at ${path}:`, error);
        this.chunks = [];
      }
    } else {
        // 如果文件不存在，静默跳过（初始化空库）
        this.chunks = [];
    }
  }

  async clear(): Promise<void> {
    this.chunks = [];
  }
}

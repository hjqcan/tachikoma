/**
 * PostgreSQL + pgvector 向量数据库提供者
 * 
 * 实现 VectorDBProvider 接口，使用 PostgreSQL + pgvector 扩展进行向量存储和检索。
 * 
 * 功能：
 * - 余弦相似度搜索
 * - 元数据过滤
 * - 自动创建表和 pgvector 扩展
 * - 内置连接池管理
 * 
 * 前置条件：
 * - PostgreSQL 11+ 并安装 pgvector 扩展
 * - CREATE EXTENSION vector; (需要 superuser 权限)
 */

import type { VectorDBProvider, VectorPoint, VectorSearchResult } from '../types';

// 动态导入 pg 以避免强制依赖
type PoolClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
};

type Pool = {
  connect: () => Promise<PoolClient>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

/**
 * PostgresVectorProvider 配置
 */
export interface PostgresVectorConfig {
  /** PostgreSQL 连接字符串 (e.g., postgres://user:pass@host:5432/db) */
  connectionString: string;
  /** 表名 (默认: 'vectors') */
  tableName?: string;
  /** 向量维度 */
  vectorSize: number;
  /** 是否在初始化时创建 pgvector 扩展 (需要 superuser) */
  createExtension?: boolean;
}

export class PostgresVectorProvider implements VectorDBProvider {
  private pool: Pool | null = null;
  private tableName: string;
  private vectorSize: number;
  private connectionString: string;
  private createExtension: boolean;

  constructor(config: PostgresVectorConfig) {
    this.connectionString = config.connectionString;
    this.tableName = config.tableName ?? 'vectors';
    this.vectorSize = config.vectorSize;
    this.createExtension = config.createExtension ?? false;
  }

  /**
   * 初始化连接池并创建表
   */
  async initialize(): Promise<void> {
    // 动态导入 pg
    let pg: { Pool: new (config: { connectionString: string }) => Pool };
    try {
      pg = await import('pg');
    } catch {
      throw new Error(
        'PostgreSQL driver (pg) is not installed. Please install it with: npm install pg'
      );
    }

    this.pool = new pg.Pool({ connectionString: this.connectionString });

    // 测试连接
    const client = await this.pool.connect();
    try {
      // 可选：创建 pgvector 扩展
      if (this.createExtension) {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      }

      // 创建表（如果不存在）
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id TEXT PRIMARY KEY,
          embedding vector(${this.vectorSize}),
          payload JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // 创建索引用于加速余弦相似度搜索
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.tableName}_embedding_idx 
        ON ${this.tableName} 
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
      `).catch(() => {
        // IVFFlat 索引可能需要先有数据才能创建，忽略错误
        // 或使用 HNSW 索引作为替代
      });
    } finally {
      client.release();
    }
  }

  /**
   * 插入或更新向量
   */
  async upsert(points: VectorPoint[]): Promise<void> {
    if (!this.pool) throw new Error('Provider not initialized. Call initialize() first.');
    if (points.length === 0) return;

    const client = await this.pool.connect();
    try {
      // 使用事务批量插入
      await client.query('BEGIN');
      
      for (const point of points) {
        const vectorStr = `[${point.vector.join(',')}]`;
        await client.query(
          `INSERT INTO ${this.tableName} (id, embedding, payload)
           VALUES ($1, $2::vector, $3)
           ON CONFLICT (id) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             payload = EXCLUDED.payload`,
          [point.id, vectorStr, JSON.stringify(point.payload)]
        );
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 余弦相似度搜索
   */
  async search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>
  ): Promise<VectorSearchResult[]> {
    if (!this.pool) throw new Error('Provider not initialized. Call initialize() first.');

    const vectorStr = `[${vector.join(',')}]`;
    let sql = `
      SELECT 
        id, 
        payload,
        1 - (embedding <=> $1::vector) as score
      FROM ${this.tableName}
    `;
    
    const values: unknown[] = [vectorStr];
    
    // 构建过滤条件
    if (filter && Object.keys(filter).length > 0) {
      const conditions: string[] = [];
      let paramIndex = 2;
      
      for (const [key, value] of Object.entries(filter)) {
        conditions.push(`payload->>'${key}' = $${paramIndex}`);
        values.push(String(value));
        paramIndex++;
      }
      
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    sql += ` ORDER BY embedding <=> $1::vector LIMIT $${values.length + 1}`;
    values.push(limit);

    const result = await this.pool.query(sql, values);

    return result.rows.map((row) => ({
      id: row.id as string,
      score: row.score as number,
      payload: (row.payload as Record<string, unknown>) ?? {},
    }));
  }

  /**
   * 按 ID 删除
   */
  async delete(ids: string[]): Promise<void> {
    if (!this.pool) throw new Error('Provider not initialized. Call initialize() first.');
    if (ids.length === 0) return;

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`,
      ids
    );
  }

  /**
   * 按过滤条件删除
   */
  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    if (!this.pool) throw new Error('Provider not initialized. Call initialize() first.');
    
    if (Object.keys(filter).length === 0) return 0;

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(filter)) {
      conditions.push(`payload->>'${key}' = $${paramIndex}`);
      values.push(String(value));
      paramIndex++;
    }

    const result = await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE ${conditions.join(' AND ')} RETURNING id`,
      values
    );

    return result.rows.length;
  }

  /**
   * 滚动获取 ID 列表
   */
  async scrollIds(filter?: Record<string, unknown>, limit = 10000): Promise<string[]> {
    if (!this.pool) throw new Error('Provider not initialized. Call initialize() first.');

    let sql = `SELECT id FROM ${this.tableName}`;
    const values: unknown[] = [];
    
    if (filter && Object.keys(filter).length > 0) {
      const conditions: string[] = [];
      let paramIndex = 1;
      
      for (const [key, value] of Object.entries(filter)) {
        conditions.push(`payload->>'${key}' = $${paramIndex}`);
        values.push(String(value));
        paramIndex++;
      }
      
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    sql += ` LIMIT $${values.length + 1}`;
    values.push(limit);

    const result = await this.pool.query(sql, values);
    return result.rows.map((row) => row.id as string);
  }

  /**
   * 获取集合信息
   */
  async getInfo(): Promise<{ count: number; vectorSize: number }> {
    if (!this.pool) throw new Error('Provider not initialized. Call initialize() first.');

    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM ${this.tableName}`
    );

    return {
      count: parseInt(result.rows[0]?.count as string || '0', 10),
      vectorSize: this.vectorSize,
    };
  }

  /**
   * 关闭连接池
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

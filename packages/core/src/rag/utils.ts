/**
 * RAG 工具函数
 */

import { createHash } from 'crypto';

/**
 * 计算两个向量的余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const valA = a[i];
    const valB = b[i];
    if (valA !== undefined && valB !== undefined) {
        dotProduct += valA * valB;
        normA += valA * valA;
        normB += valB * valB;
    }
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 简单的文本切片函数
 * 
 * TODO: 未来可以使用更有语义感知的切片库 (如 langchain/text_splitter)
 */
export function chunkText(
  text: string, 
  chunkSize: number = 1000, 
  overlap: number = 200
): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + chunkSize;
    
    // 如果不是最后一块，尝试在空白处切分，避免切断单词
    if (endIndex < text.length) {
      // 在 endIndex 附近寻找最后的换行符或空格
      const lookback = Math.min(100, chunkSize / 2); // 向回看一段距离
      const contentWindow = text.slice(Math.max(0, endIndex - lookback), endIndex);
      
      const lastNewLine = contentWindow.lastIndexOf('\n');
      const lastSpace = contentWindow.lastIndexOf(' ');
      
      if (lastNewLine !== -1) {
        endIndex = endIndex - lookback + lastNewLine + 1;
      } else if (lastSpace !== -1) {
        endIndex = endIndex - lookback + lastSpace + 1;
      }
    }

    chunks.push(text.slice(startIndex, endIndex).trim());
    
    // 更新起始位置，减去重叠部分
    startIndex = endIndex - overlap;
    
    // 防止死循环（如果重叠导致步进为0）
    if (startIndex >= endIndex) {
      startIndex = endIndex;
    }
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * 生成 Mock Embedding (仅用于测试)
 * 使用 MD5 哈希生成确定性的 "伪向量"
 */
export function mockEmbed(text: string, dim: number = 1536): number[] {
  const hash = createHash('md5').update(text).digest('hex');
  const vector: number[] = [];
  
  // 使用哈希值生成伪随机数填充向量
  for (let i = 0; i < dim; i++) {
    // 简单的线性同余生成器
    const val = (parseInt(hash.slice(i % 30, (i % 30) + 2), 16) / 255) - 0.5;
    vector.push(val);
  }
  
  return vector;
}

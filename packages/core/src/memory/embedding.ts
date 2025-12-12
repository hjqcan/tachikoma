import type { EmbeddingService } from './types';

/**
 * OpenRouter Embedding Service
 * 
 * Uses OpenRouter API to generate embeddings via OpenAI models.
 * Default model: openai/text-embedding-3-small (1536 dimensions)
 */
export class OpenRouterEmbeddingService implements EmbeddingService {
  private apiKey: string;
  private model: string;
  private readonly baseUrl = 'https://openrouter.ai/api/v1/embeddings';

  constructor(apiKey: string, model = 'openai/text-embedding-3-small') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const embeddings = await this.embedBatch([text]);
    if (embeddings.length === 0) {
      throw new Error('No embedding returned from service');
    }
    return embeddings[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://tachikoma.agent',
        'X-Title': 'Tachikoma Agent',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore
      }
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const data = await response.json() as OpenAIEmbeddingResponse;

    // Sort by index to ensure order matches input
    data.data.sort((a, b) => a.index - b.index);

    return data.data.map(item => item.embedding);
  }
}

/**
 * Mock Embedding Service
 * 
 * Generates random embeddings for testing.
 */
export class MockEmbeddingService implements EmbeddingService {
  private dimension: number;

  constructor(dimension = 1536) {
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    return this.generateVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.generateVector(text));
  }

  private generateVector(text: string): number[] {
    const vector = new Array(this.dimension).fill(0);
    const lower = text.toLowerCase();
    
    // Simple keyword-based embedding for testing semantic similarity
    if (lower.includes('agent') || lower.includes('memory') || lower.includes('build')) {
      vector[0] = 1;
    } else if (lower.includes('weather') || lower.includes('food')) {
      vector[1] = 1;
    } else {
      vector[2] = 1;
    }
    
    // Add deterministic noise based on text length to avoid identical vectors
    vector[3] = (text.length % 100) / 100;

    // Normalize
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return magnitude === 0 
      ? vector // Should not happen with logic above
      : vector.map(val => val / magnitude);
  }
}

// Minimal type definition for OpenAI embedding response
interface OpenAIEmbeddingResponse {
  data: {
    embedding: number[];
    index: number;
    object: string;
  }[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

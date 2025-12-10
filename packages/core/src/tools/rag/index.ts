import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { KnowledgeBase } from '../../rag';
import { resolve } from 'path';

const knowledgeRetrievalSchema = z.object({
  query: z.string().describe('The query to search for in the knowledge base'),
  limit: z.number().optional().describe('Max number of results to return (default: 3)'),
  minScore: z.number().optional().describe('Minimum similarity score (0-1, default: 0.0)'),
});

interface KnowledgeRetrievalResult {
  content: string;
  score: number;
  sourceId: string;
  sourcePath?: string;
  chunkIndex?: number;
}

interface KnowledgeRetrievalData {
  results: KnowledgeRetrievalResult[];
  degraded?: boolean;
  degradationReason?: string;
}

const outputSchema = z.object({
  success: z.boolean(),
  data: z.object({
    results: z.array(z.object({
      content: z.string(),
      score: z.number(),
      sourceId: z.string(),
      sourcePath: z.string().optional(),
      chunkIndex: z.number().optional(),
    })),
    degraded: z.boolean().optional(),
    degradationReason: z.string().optional(),
  }).optional(),
  error: z.string().optional(),
});

export const knowledgeRetrievalTool: Tool = {
  name: 'knowledge_retrieval',
  description: 'Search the knowledge base for relevant documentation and snippets.',
  inputSchema: zodToJsonSchema(knowledgeRetrievalSchema, 'knowledgeRetrievalInput') as Record<string, unknown>,
  outputSchema: zodToJsonSchema(outputSchema, 'knowledgeRetrievalOutput') as Record<string, unknown>,
  
  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<KnowledgeRetrievalData>> {
    try {
      // 1. Input validation with zod parse
      const parseResult = knowledgeRetrievalSchema.safeParse(input);
      if (!parseResult.success) {
        return {
          success: false,
          error: `Invalid input: ${parseResult.error.message}`,
        };
      }
      const typedInput = parseResult.data;

      // 2. Use context.env for API key, fallback to workDir-relative storage
      const apiKey = context.env?.OPENAI_API_KEY as string | undefined;
      const workDir = context.workDir || process.cwd();
      const storagePath = resolve(workDir, '.tachikoma', 'knowledge', 'vectors.json');

      // Track if we're degrading to mock mode
      const degraded = !apiKey;
      const degradationReason = degraded
        ? 'No OPENAI_API_KEY found in context.env, using mock embeddings'
        : undefined;

      // Warn about degradation
      if (degraded) {
        console.warn(`⚠️  RAG degraded: ${degradationReason}`);
      }

      // 3. Initialize KnowledgeBase with proper config
      // Allow batch config from environment variables
      const batchSize = context.env?.RAG_BATCH_SIZE
        ? parseInt(context.env.RAG_BATCH_SIZE as string, 10)
        : undefined;
      const batchDelayMs = context.env?.RAG_BATCH_DELAY_MS
        ? parseInt(context.env.RAG_BATCH_DELAY_MS as string, 10)
        : undefined;

      const kb = new KnowledgeBase(
        {
          storagePath,
          embeddingConfig: {
            provider: apiKey ? 'openai' : 'mock',
            apiKey: apiKey || '',
          },
        },
        { batchSize, batchDelayMs }
      );

      await kb.initialize();

      // 4. Search with exposed parameters
      const results = await kb.search(
        typedInput.query,
        typedInput.limit || 3,
        typedInput.minScore || 0.0
      );

      // 5. Return schema-compliant output with enhanced metadata
      return {
        success: true,
        data: {
          results: results.map((r) => ({
            content: r.content,
            score: r.score,
            sourceId: String(r.metadata.sourceId || 'unknown'),
            sourcePath: r.metadata.sourcePath as string | undefined,
            chunkIndex: r.metadata.chunkIndex as number | undefined,
          })),
          degraded,
          degradationReason,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Error searching knowledge base: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};

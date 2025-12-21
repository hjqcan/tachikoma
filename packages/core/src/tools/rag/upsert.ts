import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { KnowledgeBase } from '../../rag';
import { resolve } from 'path';

const knowledgeUpsertSchema = z.object({
  sourceId: z.string().describe('Unique identifier for the document source'),
  content: z.string().describe('The document content to ingest'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata for the document'),
  sourcePath: z.string().optional().describe('Optional file path for traceability'),
});

interface KnowledgeUpsertData {
  message: string;
  chunksCreated: number;
  degraded?: boolean | undefined;
  degradationReason?: string | undefined;
}

const outputSchema = z.object({
  success: z.boolean(),
  data: z.object({
    message: z.string(),
    chunksCreated: z.number(),
    degraded: z.boolean().optional(),
    degradationReason: z.string().optional(),
  }).optional(),
  error: z.string().optional(),
});

const inputJsonSchema = zodToJsonSchema(
  knowledgeUpsertSchema as unknown as Parameters<typeof zodToJsonSchema>[0],
  { $refStrategy: 'none' }
) as Record<string, unknown>;

const upsertOutputJsonSchema = zodToJsonSchema(
  outputSchema as unknown as Parameters<typeof zodToJsonSchema>[0],
  { $refStrategy: 'none' }
) as Record<string, unknown>;

export const knowledgeUpsertTool: Tool = {
  name: 'knowledge_upsert',
  description:
    'Ingest or update a document in the knowledge base. Use this to add project documentation, code files, or reference materials.',
  inputSchema: inputJsonSchema,
  outputSchema: upsertOutputJsonSchema,

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<KnowledgeUpsertData>> {
    try {
      // 1. Input validation
      const parseResult = knowledgeUpsertSchema.safeParse(input);
      if (!parseResult.success) {
        return {
          success: false,
          error: `Invalid input: ${parseResult.error.message}`,
        };
      }
      const typedInput = parseResult.data;

      // 2. Use context.env for API key
      const apiKey = context.env?.OPENAI_API_KEY as string | undefined;
      const workDir = context.workDir || process.cwd();
      const storagePath = resolve(workDir, '.tachikoma', 'knowledge', 'vectors.json');

      // Track degradation
      const degraded = !apiKey;
      const degradationReason = degraded
        ? 'No OPENAI_API_KEY found in context.env, using mock embeddings'
        : undefined;

      // Warn about degradation
      if (degraded) {
        console.warn(`⚠️  RAG degraded: ${degradationReason}`);
      }

      // 3. Initialize KnowledgeBase with batch config from environment
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

      // 4. Add document with source path and chunk index in metadata
      const metadata = {
        ...typedInput.metadata,
        sourcePath: typedInput.sourcePath,
      };

      const chunksCreated = await kb.addDocument(typedInput.sourceId, typedInput.content, metadata);

      return {
        success: true,
        data: {
          message: `Document '${typedInput.sourceId}' successfully ingested into knowledge base.`,
          chunksCreated,
          degraded,
          degradationReason,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Error ingesting document: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};

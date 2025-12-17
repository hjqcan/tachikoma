import { describe, test, expect } from 'bun:test';
import {
  SummarizationStrategy,
  type SummarizationConfig,
  type ContextMessage,
  type StructuredSummary,
} from '../src/prompt';

function createConfig(overrides?: Partial<SummarizationConfig>): SummarizationConfig {
  return {
    mode: 'structured',
    offloadBeforeSummarize: false,
    keepLastN: 2,
    ...overrides,
  };
}

function estimateTokensSimple(content: string): number {
  return Math.ceil(content.length / 3);
}

describe('SummarizationStrategy', () => {
  test('skips summarization when summarizeUpTo <= 0 and does not mutate messages', async () => {
    const config = createConfig({ keepLastN: 10 });
    const strategy = new SummarizationStrategy(config);

    const messages: ContextMessage[] = [
      { id: 'u1', role: 'user', content: 'Hello', timestamp: Date.now(), format: 'full' },
      { id: 'a1', role: 'assistant', content: 'Hi', timestamp: Date.now(), format: 'full' },
    ];

    let called = false;
    const llmClient = {
      async generateSummary(): Promise<StructuredSummary> {
        called = true;
        throw new Error('should not be called');
      },
    };

    const before = messages.map((m) => ({ ...m }));
    const result = await strategy.summarize(messages, llmClient, estimateTokensSimple);

    expect(called).toBe(false);
    expect(result.success).toBe(false);
    expect(messages).toEqual(before);
  });

  test('pins compact task context and excludes the original large task message', async () => {
    const config = createConfig({ keepLastN: 1 });
    const strategy = new SummarizationStrategy(config);

    const largeTaskMessage = `Task: Build something\n\nConstraints:\n- Must be 1:1\n\nAvailable tools:\n- tool_a\n- tool_b\n` + 'X'.repeat(5000);

    const messages: ContextMessage[] = [
      { id: 'task', role: 'user', content: largeTaskMessage, timestamp: Date.now(), format: 'full' },
      { id: 'u2', role: 'user', content: 'More context', timestamp: Date.now(), format: 'full' },
      { id: 'a2', role: 'assistant', content: 'Ack', timestamp: Date.now(), format: 'full' },
    ];

    const llmClient = {
      async generateSummary(): Promise<StructuredSummary> {
        return {
          userGoal: 'Build something',
          completedSteps: [],
          keyFindings: [],
          modifiedFiles: [],
          currentProgress: '',
          nextSteps: [],
          errors: [],
          lastStopPoint: '',
        };
      },
    };

    const result = await strategy.summarize(messages, llmClient, estimateTokensSimple);
    expect(result.success).toBe(true);

    // New first message should be pinned task context (system), and should not include tool list.
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.id.startsWith('pinned-task-')).toBe(true);
    expect(messages[0]?.content).toContain('Task:');
    expect(messages[0]?.content).not.toContain('Available tools:');

    // Summary message should exist as a system message right after.
    expect(messages[1]?.role).toBe('system');
    expect(messages[1]?.id.startsWith('summary-')).toBe(true);

    // Original large task message should be removed.
    expect(messages.find((m) => m.id === 'task')).toBeUndefined();

    // keepLastN=1 keeps the last message intact.
    expect(messages[messages.length - 1]?.id).toBe('a2');
  });

  test('does not throw or mutate messages when LLM summarization fails', async () => {
    const config = createConfig({ keepLastN: 0 });
    const strategy = new SummarizationStrategy(config);

    const messages: ContextMessage[] = [
      { id: 'u1', role: 'user', content: 'Hello', timestamp: Date.now(), format: 'full' },
      { id: 'a1', role: 'assistant', content: 'Hi', timestamp: Date.now(), format: 'full' },
    ];

    const before = messages.map((m) => ({ ...m }));
    const llmClient = {
      async generateSummary(): Promise<StructuredSummary> {
        throw new Error('network down');
      },
    };

    const result = await strategy.summarize(messages, llmClient, estimateTokensSimple);
    expect(result.success).toBe(false);
    expect(messages).toEqual(before);
  });
});


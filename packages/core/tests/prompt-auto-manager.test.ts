import { describe, test, expect, mock } from 'bun:test';

import {
  AutoContextManager,
  SmartCompactionDecider,
  createAutoContextManager,
  createSmartCompactionDecider,
} from '../src/prompt/auto-manager';
import type { PromptContextEngine } from '../src/prompt/prompt-engine';

// ============================================================================
// Mock PromptContextEngine
// ============================================================================

function createMockEngine(options?: {
  needsReduction?: boolean;
  autoReduceResult?: { beforeTokens: number; afterTokens: number } | null;
}): PromptContextEngine {
  return {
    needsReduction: mock(() => options?.needsReduction ?? false),
    autoReduce: mock(async () => options?.autoReduceResult ?? null),
  } as unknown as PromptContextEngine;
}

// ============================================================================
// AutoContextManager Tests
// ============================================================================

describe('prompt/auto-manager AutoContextManager', () => {
  test('does not trigger reduction before check interval', async () => {
    const engine = createMockEngine({ needsReduction: true });
    const manager = createAutoContextManager(engine, {
      compactCheckInterval: 5,
      asyncMode: false,
    });

    // Add 4 messages (less than interval of 5)
    for (let i = 0; i < 4; i++) {
      await manager.onMessageAdded();
    }

    expect(engine.needsReduction).not.toHaveBeenCalled();
  });

  test('triggers reduction check at interval', async () => {
    const engine = createMockEngine({ needsReduction: false });
    const manager = createAutoContextManager(engine, {
      compactCheckInterval: 3,
      asyncMode: false,
    });

    // Add 3 messages (equals interval)
    for (let i = 0; i < 3; i++) {
      await manager.onMessageAdded();
    }

    expect(engine.needsReduction).toHaveBeenCalled();
  });

  test('executes reduction when needsReduction returns true', async () => {
    const engine = createMockEngine({
      needsReduction: true,
      autoReduceResult: { beforeTokens: 1000, afterTokens: 500 },
    });
    const manager = createAutoContextManager(engine, {
      compactCheckInterval: 1,
      asyncMode: false,
    });

    await manager.onMessageAdded();

    expect(engine.autoReduce).toHaveBeenCalled();

    const metrics = manager.getMetrics();
    expect(metrics.autoCompactCount).toBe(1);
    expect(metrics.totalTokensSaved).toBe(500);
  });

  test('calls onCompacted callback', async () => {
    const onCompacted = mock(() => undefined);
    const engine = createMockEngine({
      needsReduction: true,
      autoReduceResult: { beforeTokens: 100, afterTokens: 50 },
    });
    const manager = createAutoContextManager(engine, {
      compactCheckInterval: 1,
      asyncMode: false,
      onCompacted,
    });

    await manager.onMessageAdded();

    expect(onCompacted).toHaveBeenCalled();
  });

  test('calls onSummarized callback for summary results', async () => {
    const onSummarized = mock(() => undefined);
    const engine = {
      needsReduction: mock(() => true),
      autoReduce: mock(async () => ({
        success: true,
        beforeTokens: 1000,
        afterTokens: 200,
        summary: {
          userGoal: 'test goal',
          completedSteps: [],
          keyFindings: [],
          modifiedFiles: [],
          currentProgress: 'in progress',
          nextSteps: [],
          errors: [],
          lastStopPoint: 'step1',
        },
      })),
    } as unknown as PromptContextEngine;

    const manager = createAutoContextManager(engine, {
      compactCheckInterval: 1,
      asyncMode: false,
      onSummarized,
    });

    await manager.onMessageAdded();

    expect(onSummarized).toHaveBeenCalled();
    expect(manager.getMetrics().autoSummarizeCount).toBe(1);
  });

  test('forceCheck executes immediately', async () => {
    const engine = createMockEngine({
      needsReduction: true,
      autoReduceResult: { beforeTokens: 500, afterTokens: 250 },
    });
    const manager = createAutoContextManager(engine, {
      compactCheckInterval: 100, // High interval
      asyncMode: false,
    });

    const result = await manager.forceCheck();

    expect(result).not.toBeNull();
    expect(result?.beforeTokens).toBe(500);
  });

  test('forceCheck returns null when no reduction needed', async () => {
    const engine = createMockEngine({ needsReduction: false });
    const manager = createAutoContextManager(engine);

    const result = await manager.forceCheck();
    expect(result).toBeNull();
  });

  test('resetMetrics clears all counters', async () => {
    const engine = createMockEngine({
      needsReduction: true,
      autoReduceResult: { beforeTokens: 100, afterTokens: 50 },
    });
    const manager = createAutoContextManager(engine, {
      compactCheckInterval: 1,
      asyncMode: false,
    });

    await manager.onMessageAdded();
    expect(manager.getMetrics().totalTokensSaved).toBe(50);

    manager.resetMetrics();
    const metrics = manager.getMetrics();
    expect(metrics.autoCompactCount).toBe(0);
    expect(metrics.autoSummarizeCount).toBe(0);
    expect(metrics.totalTokensSaved).toBe(0);
  });

  test('waitForPendingReduction waits for async reduction', async () => {
    let resolved = false;
    const engine = {
      needsReduction: mock(() => true),
      autoReduce: mock(async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
        return { beforeTokens: 100, afterTokens: 50 };
      }),
    } as unknown as PromptContextEngine;

    const manager = createAutoContextManager(engine, {
      compactCheckInterval: 1,
      asyncMode: true,
    });

    await manager.onMessageAdded();
    expect(resolved).toBe(false);

    await manager.waitForPendingReduction();
    expect(resolved).toBe(true);
  });
});

// ============================================================================
// SmartCompactionDecider Tests
// ============================================================================

describe('prompt/auto-manager SmartCompactionDecider', () => {
  const decider = createSmartCompactionDecider();

  test('calculateImportance returns score between 0 and 100', () => {
    const score = decider.calculateImportance('Hello world', 'user', 0, 10);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('system messages have highest importance', () => {
    const system = decider.calculateImportance('System', 'system', 0, 10);
    const user = decider.calculateImportance('User', 'user', 0, 10);
    const assistant = decider.calculateImportance('Assistant', 'assistant', 0, 10);

    expect(system).toBeGreaterThan(user);
    expect(user).toBeGreaterThan(assistant);
  });

  test('recent messages have higher importance', () => {
    const old = decider.calculateImportance('Same content', 'user', 0, 10);
    const recent = decider.calculateImportance('Same content', 'user', 9, 10);

    expect(recent).toBeGreaterThan(old);
  });

  test('messages with key content get bonus', () => {
    const normal = decider.calculateImportance('Hello there', 'assistant', 5, 10);
    const withError = decider.calculateImportance('Error occurred', 'assistant', 5, 10);
    const withSuccess = decider.calculateImportance('Task completed successfully', 'assistant', 5, 10);

    expect(withError).toBeGreaterThan(normal);
    expect(withSuccess).toBeGreaterThan(normal);
  });

  test('getCompactionCandidates returns low-importance indices first', () => {
    const messages = [
      { role: 'system', content: 'Important system' },
      { role: 'assistant', content: 'Some output' },
      { role: 'user', content: 'User input' },
      { role: 'assistant', content: 'More output' },
    ];

    const candidates = decider.getCompactionCandidates(messages, 2);

    expect(candidates.length).toBe(2);
    // Assistant messages should be compacted first (lower importance)
    expect(candidates).toContain(1);
    expect(candidates).not.toContain(0); // System should not be in candidates
  });

  test('getCompactionCandidates respects targetCount', () => {
    const messages = [
      { role: 'user', content: 'msg1' },
      { role: 'user', content: 'msg2' },
      { role: 'user', content: 'msg3' },
      { role: 'user', content: 'msg4' },
    ];

    const candidates = decider.getCompactionCandidates(messages, 2);
    expect(candidates.length).toBe(2);
  });
});

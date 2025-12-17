import { describe, test, expect } from 'bun:test';
import {
  createDefaultPromptConfig,
  createPromptContextEngine,
  CompactionStrategy,
  OffloadStrategy,
  SummarizationStrategy,
  type ContextMessage,
  type StructuredSummary,
} from '../src/prompt';

function estimateTokensSimple(content: string): number {
  return Math.ceil(content.length / 3);
}

describe('Prompt language policy (user-language internal injections)', () => {
  test('Note status reminder follows the latest user message language', () => {
    const config = createDefaultPromptConfig('/tmp');
    const engine = createPromptContextEngine(config);

    engine.addMessage({
      id: 'u1',
      role: 'user',
      content: 'Hello, please help.',
      timestamp: Date.now(),
      format: 'full',
    });

    engine.addTodo('Do something');
    engine.injectStatusReminder();

    const ctx = engine.getContext();
    const last = ctx[ctx.length - 1];
    expect(last?.role).toBe('system');
    expect(last?.content).toContain('## Status Reminder');

    // Switch to Chinese user message; reminder should switch language on next injection.
    engine.addMessage({
      id: 'u2',
      role: 'user',
      content: '我们继续吧',
      timestamp: Date.now(),
      format: 'full',
    });

    engine.addTodo('继续处理');
    engine.injectStatusReminder();

    const ctx2 = engine.getContext();
    const last2 = ctx2[ctx2.length - 1];
    expect(last2?.role).toBe('system');
    expect(last2?.content).toContain('## 当前状态提醒');
  });

  test('Summarization wrapper follows detected user language', async () => {
    const strategy = new SummarizationStrategy({
      mode: 'structured',
      offloadBeforeSummarize: false,
      keepLastN: 1,
    });

    const messages: ContextMessage[] = [
      { id: 'u1', role: 'user', content: '你好', timestamp: Date.now(), format: 'full' },
      { id: 'a1', role: 'assistant', content: '好的', timestamp: Date.now(), format: 'full' },
    ];

    const llmClient = {
      async generateSummary(): Promise<StructuredSummary> {
        return {
          userGoal: '帮助用户',
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
    expect(messages.some((m) => m.id.startsWith('summary-'))).toBe(true);

    const summaryMsg = messages.find((m) => m.id.startsWith('summary-'));
    expect(summaryMsg?.role).toBe('system');
    expect(summaryMsg?.content).toContain('对话摘要');
  });

  test('Offload placeholder respects language', async () => {
    const offload = new OffloadStrategy({
      workDir: '/tmp',
      tokenThreshold: 1,
      fileFormat: 'txt',
    });

    const fileStore = new Map<string, string>();
    const fileManager = {
      async writeFile(path: string, content: string): Promise<void> {
        fileStore.set(path, content);
      },
      async readFile(path: string): Promise<string> {
        return fileStore.get(path) ?? '';
      },
      async exists(path: string): Promise<boolean> {
        return fileStore.has(path);
      },
    };

    const msgEn: ContextMessage = {
      id: 'm1',
      role: 'user',
      content: 'A'.repeat(500),
      timestamp: Date.now(),
      format: 'full',
    };

    await offload.offload([msgEn], fileManager, estimateTokensSimple, 'en');
    expect(msgEn.content).toContain('content offloaded to');

    const msgZh: ContextMessage = {
      id: 'm2',
      role: 'user',
      content: '中'.repeat(500),
      timestamp: Date.now(),
      format: 'full',
    };

    await offload.offload([msgZh], fileManager, estimateTokensSimple, 'zh');
    expect(msgZh.content).toContain('内容已卸载到文件');
  });

  test('Compaction placeholders respect language', () => {
    const compaction = new CompactionStrategy({
      keepLastN: 0,
      compactRatio: 1,
      minGainRatio: 0,
      toolResultRules: [],
    });

    const toolCallMessage: ContextMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'Calling tool...',
      timestamp: Date.now(),
      format: 'full',
      toolCall: {
        id: 'call-1',
        name: 'file_write',
        input: { blob: 'X'.repeat(2000) },
      },
    };

    const messages = [toolCallMessage];
    compaction.compact(messages, estimateTokensSimple, 'en');
    expect(messages[0]?.content).toContain('[Call file_write');

    const toolCallMessageZh: ContextMessage = {
      id: 'a2',
      role: 'assistant',
      content: '调用工具...',
      timestamp: Date.now(),
      format: 'full',
      toolCall: { id: 'call-2', name: 'file_write', input: { blob: 'X'.repeat(2000) } },
    };
    const messagesZh = [toolCallMessageZh];
    compaction.compact(messagesZh, estimateTokensSimple, 'zh');
    expect(messagesZh[0]?.content).toContain('[调用 file_write');
  });
});

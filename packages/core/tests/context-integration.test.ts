/**
 * Prompt 模块集成测试（内部）
 *
 * 测试 Task 8 的上下文工程功能：
 * - 阈值配置与模型感知
 * - Token 估算器
 * - 上下文压缩/摘要
 * - 笔记系统
 */

import { describe, test, expect } from 'bun:test';
import {
  createPromptContextEngine,
  createDefaultPromptConfig,
  createModelAwarePromptConfig,
  computeModelAwareThresholds,
  validateThresholds,
  getModelContextLimit,
  MODEL_CONTEXT_LIMITS,
  DEFAULT_THRESHOLDS,
  createTokenEstimator,
  estimateTokens,
  type ContextMessage,
} from '../src/prompt';

// ============================================================================
// 8.2 阈值配置与模型感知测试
// ============================================================================

describe('阈值配置与模型感知', () => {
  test('DEFAULT_THRESHOLDS 应符合 Manus 推荐值', () => {
    expect(DEFAULT_THRESHOLDS.rotThreshold).toBe(128_000);
    expect(DEFAULT_THRESHOLDS.softLimit).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.hardLimit);
    expect(DEFAULT_THRESHOLDS.softLimit).toBeGreaterThan(0);
  });

  test('MODEL_CONTEXT_LIMITS 应包含主要模型', () => {
    expect(MODEL_CONTEXT_LIMITS['claude-3-sonnet']).toBeDefined();
    expect(MODEL_CONTEXT_LIMITS['gpt-4o']).toBeDefined();
    expect(MODEL_CONTEXT_LIMITS['gemini-pro']).toBeDefined();
  });

  test('getModelContextLimit 应返回正确的限制', () => {
    expect(getModelContextLimit('claude-3-sonnet')).toBe(200_000);
    expect(getModelContextLimit('gpt-4o')).toBe(128_000);
    // 未知模型返回默认值
    expect(getModelContextLimit('unknown-model')).toBe(128_000);
  });

  test('computeModelAwareThresholds 应基于模型计算阈值', () => {
    const thresholds = computeModelAwareThresholds('claude-3-sonnet');
    
    // hardLimit 应该是模型窗口的 80%
    expect(thresholds.hardLimit).toBe(160_000);
    // softLimit 应该小于 hardLimit
    expect(thresholds.softLimit).toBeLessThan(thresholds.hardLimit);
    // rotThreshold 应该符合限制
    expect(thresholds.rotThreshold).toBeLessThanOrEqual(thresholds.hardLimit - 10_000);
  });

  test('computeModelAwareThresholds 小窗口模型应正确钳制', () => {
    const thresholds = computeModelAwareThresholds('gpt-4o');
    
    // GPT-4o 窗口是 128K，hardLimit = 102.4K
    expect(thresholds.hardLimit).toBe(102_400);
    // rotThreshold 应该被钳制
    expect(thresholds.rotThreshold).toBeLessThanOrEqual(thresholds.hardLimit - 10_000);
    expect(thresholds.softLimit).toBeLessThanOrEqual(thresholds.hardLimit - 10_000);
  });

  test('validateThresholds 有效阈值不抛出异常', () => {
    // 有效阈值不应该抛出异常
    expect(() => validateThresholds({
      softLimit: 100_000,
      hardLimit: 150_000,
      rotThreshold: 120_000,
    })).not.toThrow();
  });

  test('validateThresholds 无效阈值应抛出异常', () => {
    // 无效：softLimit > hardLimit
    expect(() => validateThresholds({
      softLimit: 200_000,
      hardLimit: 150_000,
      rotThreshold: 120_000,
    })).toThrow();

    // 无效：rotThreshold > hardLimit
    expect(() => validateThresholds({
      softLimit: 100_000,
      hardLimit: 150_000,
      rotThreshold: 160_000,
    })).toThrow();
  });

  test('createModelAwarePromptConfig 应创建完整配置', () => {
    const config = createModelAwarePromptConfig('claude-3-sonnet', '/tmp/test');
    
    expect(config.thresholds).toBeDefined();
    expect(config.compaction).toBeDefined();
    expect(config.summarization).toBeDefined();
    expect(config.offload).toBeDefined();
    expect(config.offload.workDir).toBe('/tmp/test');
  });
});

// ============================================================================
// 8.3 Token 估算器测试
// ============================================================================

describe('Token 估算器', () => {
  test('createTokenEstimator 创建简单估算器', () => {
    const estimator = createTokenEstimator('simple');
    const tokens = estimator.estimate('Hello World');
    expect(tokens).toBeGreaterThan(0);
  });

  test('createTokenEstimator 创建字符估算器', () => {
    const estimator = createTokenEstimator('character-based');
    
    // 英文文本
    const englishTokens = estimator.estimate('Hello World');
    expect(englishTokens).toBeGreaterThan(0);
    
    // 中文文本（应该估算更多 tokens）
    const chineseTokens = estimator.estimate('你好世界');
    expect(chineseTokens).toBeGreaterThan(0);
  });

  test('createTokenEstimator 缓存估算器一致性', () => {
    const estimator = createTokenEstimator('simple');
    
    const text = 'This is a test string for caching';
    const tokens1 = estimator.estimate(text);
    const tokens2 = estimator.estimate(text);
    
    // 两次估算结果应该一致
    expect(tokens1).toBe(tokens2);
  });

  test('estimateTokens 辅助函数应工作', () => {
    const tokens = estimateTokens('Hello World');
    expect(tokens).toBeGreaterThan(0);
  });
});

// ============================================================================
// 8.4 GenericAgentBackend 集成测试（基础）
// ============================================================================

describe('PromptContextEngine 基础功能', () => {
  test('createPromptContextEngine 应创建实例', () => {
    const config = createDefaultPromptConfig('/tmp');
    const manager = createPromptContextEngine(config);
    
    expect(manager).toBeDefined();
    expect(manager.getContext()).toEqual([]);
  });

  test('addMessage 应正确添加消息', () => {
    const config = createDefaultPromptConfig('/tmp');
    const manager = createPromptContextEngine(config);
    
    const message: ContextMessage = {
      id: 'test-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
      format: 'full',
    };
    
    manager.addMessage(message);
    
    const context = manager.getContext();
    expect(context.length).toBe(1);
    expect(context[0]?.content).toBe('Hello');
  });

  test('needsReduction 应基于阈值判断', () => {
    const config = createDefaultPromptConfig('/tmp');
    // 设置很低的阈值以便测试
    config.thresholds.softLimit = 10;
    config.thresholds.hardLimit = 20;
    
    const manager = createPromptContextEngine(config);
    
    // 初始应该不需要压缩
    expect(manager.needsReduction()).toBe(false);
    
    // 添加大量内容后应该需要
    manager.addMessage({
      id: 'big-1',
      role: 'user',
      content: 'A'.repeat(100),
      timestamp: Date.now(),
      format: 'full',
    });
    
    expect(manager.needsReduction()).toBe(true);
  });

  test('笔记系统应工作', () => {
    const config = createDefaultPromptConfig('/tmp');
    const manager = createPromptContextEngine(config);
    
    // 添加待办
    manager.addTodo('Complete the task');
    
    // 添加发现
    manager.addFinding('Found important information');
    
    // 获取笔记
    const notes = manager.getNotes();
    expect(notes.todos.length).toBe(1);
    expect(notes.findings.length).toBe(1);
  });

  test('自定义 tokenEstimator 应生效', () => {
    const config = createDefaultPromptConfig('/tmp');
    // 添加自定义估算器（固定返回 1）
    config.tokenEstimator = () => 1;
    
    const manager = createPromptContextEngine(config);
    
    // 任何内容都应该估算为 1 token
    const tokens = manager.estimateTokens('This is a long text');
    expect(tokens).toBe(1);
  });
});

// ============================================================================
// 8.5 Memory 接口测试
// ============================================================================

describe('Memory 系统接口', () => {
  test('shouldRetrieveMemories 无 memoryProvider 应返回 false', () => {
    const config = createDefaultPromptConfig('/tmp');
    const manager = createPromptContextEngine(config);
    
    // 没有配置 memoryProvider，始终返回 false
    expect(manager.shouldRetrieveMemories()).toBe(false);
    
    manager.addMessage({
      id: 'user-1',
      role: 'user',
      content: 'Tell me about the project setup',
      timestamp: Date.now(),
      format: 'full',
    });
    
    // 仍然返回 false，因为没有 memoryProvider
    expect(manager.shouldRetrieveMemories()).toBe(false);
  });

  test('getRetrievalContext 应返回检索上下文', () => {
    const config = createDefaultPromptConfig('/tmp');
    const manager = createPromptContextEngine(config);
    
    manager.addMessage({
      id: 'user-1',
      role: 'user',
      content: 'What is the database schema?',
      timestamp: Date.now(),
      format: 'full',
    });
    
    const retrievalContext = manager.getRetrievalContext();
    expect(retrievalContext).toContain('database schema');
  });

  test('injectRetrievedMemories 应注入记忆', () => {
    const config = createDefaultPromptConfig('/tmp');
    const manager = createPromptContextEngine(config);
    
    manager.injectRetrievedMemories([
      {
        id: 'mem-1',
        scope: 'declarative',
        content: 'Database uses PostgreSQL',
        createdAt: Date.now(),
        relevanceScore: 0.9,
      },
    ]);
    
    const context = manager.getContext();
    expect(context.length).toBe(1);
    expect(context[0]?.role).toBe('system');
    expect(context[0]?.content).toContain('PostgreSQL');
  });
});

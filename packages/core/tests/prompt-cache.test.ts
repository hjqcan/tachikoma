import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  LocalPromptCache,
  DefaultCacheStrategy,
  SmartCacheStrategy,
  getProviderCacheCapability,
  inferProviderFromModel,
  adaptMessages,
  PROVIDER_CACHE_CAPABILITIES,
} from '../src/prompt/cache';
import type { ContextMessage } from '../src/prompt/types';

// ============================================================================
// Provider Adapters Tests
// ============================================================================

describe('prompt/cache Provider Adapters', () => {
  test('getProviderCacheCapability returns correct capabilities', () => {
    const anthropic = getProviderCacheCapability('anthropic');
    expect(anthropic.supportsNativeCache).toBe(true);
    expect(anthropic.cacheControlField).toBe('cache_control');

    const openai = getProviderCacheCapability('openai');
    expect(openai.supportsNativeCache).toBe(true);
    expect(openai.cacheControlField).toBeUndefined();

    const google = getProviderCacheCapability('google');
    expect(google.supportsNativeCache).toBe(true);
    expect(google.cacheControlField).toBe('cached_content');

    const mistral = getProviderCacheCapability('mistral');
    expect(mistral.supportsNativeCache).toBe(false);

    const generic = getProviderCacheCapability('unknown-provider');
    expect(generic.supportsNativeCache).toBe(false);
  });

  test('getProviderCacheCapability handles case insensitivity', () => {
    const upper = getProviderCacheCapability('ANTHROPIC');
    const lower = getProviderCacheCapability('anthropic');
    expect(upper.provider).toBe(lower.provider);
  });

  test('inferProviderFromModel identifies providers from model names', () => {
    expect(inferProviderFromModel('claude-3-5-sonnet')).toBe('anthropic');
    expect(inferProviderFromModel('gpt-4o')).toBe('openai');
    expect(inferProviderFromModel('gemini-1.5-pro')).toBe('google');
    expect(inferProviderFromModel('mistral-large')).toBe('mistral');
    expect(inferProviderFromModel('grok-2')).toBe('xai');
    expect(inferProviderFromModel('some-random-model')).toBe('generic');
  });

  test('adaptMessages adds cache control for Anthropic', () => {
    const messages: ContextMessage[] = [
      { id: '1', role: 'system', content: 'System prompt', timestamp: Date.now(), format: 'full' },
      { id: '2', role: 'user', content: 'Hello', timestamp: Date.now(), format: 'full' },
    ];

    const capability = PROVIDER_CACHE_CAPABILITIES.anthropic!;
    const adapted = adaptMessages(messages, capability);

    expect(adapted.length).toBe(2);
    expect(adapted[0]?.shouldCache).toBe(true);
    expect(adapted[0]?.cacheControl?.type).toBe('ephemeral');
  });

  test('adaptMessages works for OpenAI (no explicit cache control)', () => {
    const messages: ContextMessage[] = [
      { id: '1', role: 'system', content: 'System prompt', timestamp: Date.now(), format: 'full' },
    ];

    const capability = PROVIDER_CACHE_CAPABILITIES.openai!;
    const adapted = adaptMessages(messages, capability);

    expect(adapted[0]?.shouldCache).toBe(true);
    expect(adapted[0]?.cacheControl).toBeUndefined();
  });
});

// ============================================================================
// LocalPromptCache Tests
// ============================================================================

describe('prompt/cache LocalPromptCache', () => {
  let cache: LocalPromptCache;

  beforeEach(() => {
    cache = new LocalPromptCache();
  });

  afterEach(() => {
    cache.clear();
  });

  test('caches and retrieves summaries', () => {
    const hash = 'test-hash-1';
    const summary = {
      userGoal: 'testing',
      constraints: [],
      completedSteps: [],
      keyFindings: [],
      modifiedFiles: [],
      currentProgress: 'in progress',
      nextSteps: [],
      errors: [],
      lastStopPoint: 'step1',
    };

    cache.setSummary(hash, summary);
    const retrieved = cache.getSummary(hash);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.userGoal).toBe('testing');
  });

  test('returns null for missing entries', () => {
    expect(cache.getSummary('nonexistent')).toBeNull();
    expect(cache.getCompactedContext('nonexistent')).toBeNull();
    expect(cache.getTokenCount('nonexistent')).toBeNull();
  });

  test('caches and retrieves token counts', () => {
    const hash = 'content-hash';
    cache.setTokenCount(hash, 1000);

    const count = cache.getTokenCount(hash);
    expect(count).toBe(1000);
  });

  test('computeContextHash produces consistent hashes', () => {
    const messages: ContextMessage[] = [
      { id: '1', role: 'user', content: 'Hello', timestamp: Date.now(), format: 'full' },
    ];

    const hash1 = cache.computeContextHash(messages);
    const hash2 = cache.computeContextHash(messages);

    expect(hash1).toBe(hash2);
  });

  test('computeContextHash differs for different content', () => {
    const messages1: ContextMessage[] = [
      { id: '1', role: 'user', content: 'Hello', timestamp: Date.now(), format: 'full' },
    ];
    const messages2: ContextMessage[] = [
      { id: '1', role: 'user', content: 'World', timestamp: Date.now(), format: 'full' },
    ];

    const hash1 = cache.computeContextHash(messages1);
    const hash2 = cache.computeContextHash(messages2);

    expect(hash1).not.toBe(hash2);
  });

  test('getMetrics returns correct statistics', () => {
    const validSummary = {
      userGoal: '',
      constraints: [],
      completedSteps: [],
      keyFindings: [],
      modifiedFiles: [],
      currentProgress: '',
      nextSteps: [],
      errors: [],
      lastStopPoint: '',
    };

    cache.getSummary('miss1');
    cache.getSummary('miss2');
    cache.setSummary('hit', validSummary);
    cache.getSummary('hit');

    const metrics = cache.getMetrics();
    expect(metrics.localMisses).toBe(2);
    expect(metrics.localHits).toBe(1);
    expect(metrics.localCacheSize).toBe(1);
  });

  test('clear resets all caches and metrics', () => {
    const validSummary = {
      userGoal: '',
      constraints: [],
      completedSteps: [],
      keyFindings: [],
      modifiedFiles: [],
      currentProgress: '',
      nextSteps: [],
      errors: [],
      lastStopPoint: '',
    };
    cache.setSummary('key', validSummary);
    cache.setTokenCount('key', 100);
    cache.clear();

    expect(cache.size).toBe(0);
    const metrics = cache.getMetrics();
    expect(metrics.localHits).toBe(0);
    expect(metrics.localMisses).toBe(0);
  });
});

// ============================================================================
// Cache Strategy Tests
// ============================================================================

describe('prompt/cache DefaultCacheStrategy', () => {
  const strategy = new DefaultCacheStrategy();

  test('prepareCacheControl returns CachedMessage array', () => {
    const messages: ContextMessage[] = [
      { id: '1', role: 'system', content: 'System', timestamp: Date.now(), format: 'full' },
      { id: '2', role: 'user', content: 'User', timestamp: Date.now(), format: 'full' },
    ];

    const capability = PROVIDER_CACHE_CAPABILITIES.anthropic!;
    const cached = strategy.prepareCacheControl(messages, capability);

    expect(cached.length).toBe(2);
    expect(cached[0]?.shouldCache).toBeDefined();
  });

  test('computeCacheKey produces stable keys', () => {
    const messages: ContextMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now(), format: 'full' },
    ];

    const key1 = strategy.computeCacheKey(messages);
    const key2 = strategy.computeCacheKey(messages);

    expect(key1).toBe(key2);
  });

  test('estimateHitRate returns 0 for null previous key', () => {
    const rate = strategy.estimateHitRate(null, 'current');
    expect(rate).toBe(0);
  });

  test('estimateHitRate returns high rate for same key', () => {
    const rate = strategy.estimateHitRate('same', 'same');
    expect(rate).toBe(0.95);
  });
});

describe('prompt/cache SmartCacheStrategy', () => {
  const strategy = new SmartCacheStrategy();

  test('prepares cache control based on importance', () => {
    const messages: ContextMessage[] = [
      { id: '1', role: 'system', content: 'Important system message', timestamp: Date.now(), format: 'full' },
      { id: '2', role: 'assistant', content: 'Response', timestamp: Date.now(), format: 'full' },
    ];

    const capability = PROVIDER_CACHE_CAPABILITIES.generic!;
    const cached = strategy.prepareCacheControl(messages, capability);

    // System messages should have higher priority
    expect(cached[0]?.shouldCache).toBe(true);
  });

  test('computeCacheKey includes content prefix', () => {
    const messages: ContextMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Hello world', timestamp: Date.now(), format: 'full' },
    ];

    const key = strategy.computeCacheKey(messages);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });
});

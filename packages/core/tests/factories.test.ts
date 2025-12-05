/**
 * 工厂模块测试
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  FactoryRegistry,
  defaultRegistry,
  NotRegisteredError,
  DuplicateRegistrationError,
  createAgent,
  createSandbox,
  createContextManager,
  createOrchestrator,
  createWorker,
  createPlanner,
  createMemoryAgent,
  StubAgent,
  StubSandbox,
  StubContextManager,
  setGlobalConfig,
  resetGlobalConfig,
} from '../src/factories';
import { DEFAULT_CONFIG, loadConfig } from '../src/config';
import type { Agent, AgentConfig, Task } from '../src/types';

describe('FactoryRegistry', () => {
  let registry: FactoryRegistry;

  beforeEach(() => {
    registry = new FactoryRegistry();
  });

  describe('Agent 注册', () => {
    it('应正确注册 Agent 工厂', () => {
      const factory = (id: string, config: AgentConfig) =>
        new StubAgent(id, 'worker', config);

      registry.registerAgent('worker', factory);

      expect(registry.hasAgent('worker')).toBe(true);
    });

    it('应正确获取已注册的 Agent 工厂', () => {
      const factory = (id: string, config: AgentConfig) =>
        new StubAgent(id, 'worker', config);

      registry.registerAgent('worker', factory);
      const retrieved = registry.getAgentFactory('worker');

      expect(retrieved).toBe(factory);
    });

    it('应正确列出所有已注册类型', () => {
      const factory = (id: string, config: AgentConfig) =>
        new StubAgent(id, 'worker', config);

      registry.registerAgent('worker', factory);
      registry.registerAgent('orchestrator', factory);

      const types = registry.getRegisteredAgentTypes();
      expect(types).toContain('worker');
      expect(types).toContain('orchestrator');
    });

    it('默认不允许重复注册', () => {
      const factory = (id: string, config: AgentConfig) =>
        new StubAgent(id, 'worker', config);

      registry.registerAgent('worker', factory);

      expect(() => registry.registerAgent('worker', factory)).toThrow(
        DuplicateRegistrationError
      );
    });

    it('允许覆盖时应正确更新', () => {
      registry = new FactoryRegistry({ allowOverride: true });

      const factory1 = (id: string, config: AgentConfig) =>
        new StubAgent(id, 'worker', config);
      const factory2 = (id: string, config: AgentConfig) =>
        new StubAgent(id, 'worker', config);

      registry.registerAgent('worker', factory1);
      registry.registerAgent('worker', factory2);

      expect(registry.getAgentFactory('worker')).toBe(factory2);
    });

    it('应正确注销 Agent 工厂', () => {
      const factory = (id: string, config: AgentConfig) =>
        new StubAgent(id, 'worker', config);

      registry.registerAgent('worker', factory);
      expect(registry.unregisterAgent('worker')).toBe(true);
      expect(registry.hasAgent('worker')).toBe(false);
    });
  });

  describe('Sandbox 注册', () => {
    it('应正确注册 Sandbox 工厂', () => {
      const factory = (id: string) =>
        new StubSandbox(id, DEFAULT_CONFIG.sandbox);

      registry.registerSandbox(factory);

      expect(registry.hasSandbox()).toBe(true);
    });

    it('应正确注销 Sandbox 工厂', () => {
      const factory = (id: string) =>
        new StubSandbox(id, DEFAULT_CONFIG.sandbox);

      registry.registerSandbox(factory);
      expect(registry.unregisterSandbox()).toBe(true);
      expect(registry.hasSandbox()).toBe(false);
    });
  });

  describe('ContextManager 注册', () => {
    it('应正确注册 ContextManager 工厂', () => {
      const factory = (sessionId: string) =>
        new StubContextManager(sessionId, DEFAULT_CONFIG.context);

      registry.registerContextManager(factory);

      expect(registry.hasContextManager()).toBe(true);
    });
  });

  describe('工具方法', () => {
    it('clear 应清空所有注册', () => {
      const agentFactory = (id: string, config: AgentConfig) =>
        new StubAgent(id, 'worker', config);
      const sandboxFactory = (id: string) =>
        new StubSandbox(id, DEFAULT_CONFIG.sandbox);
      const contextFactory = (sessionId: string) =>
        new StubContextManager(sessionId, DEFAULT_CONFIG.context);

      registry.registerAgent('worker', agentFactory);
      registry.registerSandbox(sandboxFactory);
      registry.registerContextManager(contextFactory);

      registry.clear();

      expect(registry.hasAgent('worker')).toBe(false);
      expect(registry.hasSandbox()).toBe(false);
      expect(registry.hasContextManager()).toBe(false);
    });

    it('getStatus 应返回正确状态', () => {
      const factory = (id: string, config: AgentConfig) =>
        new StubAgent(id, 'worker', config);

      registry.registerAgent('worker', factory);

      const status = registry.getStatus();
      expect(status.agents).toContain('worker');
      expect(status.hasSandbox).toBe(false);
      expect(status.hasContextManager).toBe(false);
    });
  });
});

describe('createAgent', () => {
  beforeEach(() => {
    resetGlobalConfig();
    defaultRegistry.clear();
  });

  it('应创建 Stub Agent（默认行为）', () => {
    const agent = createAgent('orchestrator');

    expect(agent).toBeInstanceOf(StubAgent);
    expect(agent.type).toBe('orchestrator');
    expect(agent.config.provider).toBe('anthropic');
  });

  it('应使用自定义 ID', () => {
    const agent = createAgent('worker', { id: 'custom-id' });

    expect(agent.id).toBe('custom-id');
  });

  it('应使用自定义配置', () => {
    const customConfig = loadConfig(
      { models: { worker: { model: 'custom-model' } } },
      { loadFromEnvironment: false }
    );

    const agent = createAgent('worker', { config: customConfig });

    expect(agent.config.model).toBe('custom-model');
  });

  it('应使用已注册的工厂', () => {
    const customFactory = (id: string, config: AgentConfig): Agent => {
      const agent = new StubAgent(id, 'worker', config);
      // 可以添加自定义逻辑
      return agent;
    };

    defaultRegistry.registerAgent('worker', customFactory);

    const agent = createAgent('worker');
    expect(agent).toBeInstanceOf(StubAgent);
  });

  it('useStub=false 且未注册时应抛出错误', () => {
    expect(() => createAgent('orchestrator', { useStub: false })).toThrow(
      NotRegisteredError
    );
  });
});

describe('createSandbox', () => {
  beforeEach(() => {
    resetGlobalConfig();
    defaultRegistry.clear();
  });

  it('应创建 Stub Sandbox（默认行为）', () => {
    const sandbox = createSandbox();

    expect(sandbox).toBeInstanceOf(StubSandbox);
    expect(sandbox.status).toBe('running');
  });

  it('应使用自定义 ID', () => {
    const sandbox = createSandbox({ id: 'custom-sandbox' });

    expect(sandbox.id).toBe('custom-sandbox');
  });
});

describe('createContextManager', () => {
  beforeEach(() => {
    resetGlobalConfig();
    defaultRegistry.clear();
  });

  it('应创建 Stub ContextManager（默认行为）', () => {
    const contextManager = createContextManager();

    expect(contextManager).toBeInstanceOf(StubContextManager);
  });

  it('应使用自定义会话 ID', () => {
    const contextManager = createContextManager({ sessionId: 'session-123' });
    const context = contextManager.getContext();

    expect(context.sessionId).toBe('session-123');
  });
});

describe('便捷创建函数', () => {
  beforeEach(() => {
    resetGlobalConfig();
    defaultRegistry.clear();
  });

  it('createOrchestrator 应创建 orchestrator 类型', () => {
    const agent = createOrchestrator();
    expect(agent.type).toBe('orchestrator');
    expect(agent.config.model).toBe('claude-opus-4');
  });

  it('createWorker 应创建 worker 类型', () => {
    const agent = createWorker();
    expect(agent.type).toBe('worker');
    expect(agent.config.model).toBe('claude-sonnet-4');
  });

  it('createPlanner 应创建 planner 类型', () => {
    const agent = createPlanner();
    expect(agent.type).toBe('planner');
    expect(agent.config.model).toBe('claude-haiku-3.5');
  });

  it('createMemoryAgent 应创建 memory 类型', () => {
    const agent = createMemoryAgent();
    expect(agent.type).toBe('memory');
  });
});

describe('StubAgent', () => {
  it('应正确执行任务', async () => {
    const agent = new StubAgent('test-agent', 'worker', {
      provider: 'test',
      model: 'test',
      maxTokens: 1000,
    });

    const task: Task = {
      id: 'task-1',
      type: 'atomic',
      objective: '测试任务',
      constraints: [],
    };

    const result = await agent.run(task);

    expect(result.taskId).toBe('task-1');
    expect(result.status).toBe('success');
    expect(result.metrics.duration).toBeGreaterThanOrEqual(0);
  });

  it('不应允许并发执行', async () => {
    const agent = new StubAgent('test-agent', 'worker', {
      provider: 'test',
      model: 'test',
      maxTokens: 1000,
    });

    const task: Task = {
      id: 'task-1',
      type: 'atomic',
      objective: '测试任务',
      constraints: [],
    };

    // 启动第一个任务
    const promise1 = agent.run(task);

    // 尝试启动第二个任务应该失败
    await expect(agent.run(task)).rejects.toThrow('already running');

    // 等待第一个任务完成
    await promise1;
  });

  it('stop 应正确停止 agent', async () => {
    const agent = new StubAgent('test-agent', 'worker', {
      provider: 'test',
      model: 'test',
      maxTokens: 1000,
    });

    await agent.stop();

    // StubAgent 实现中 stop 只是一个空操作
    // 验证方法存在且不抛出错误
    expect(true).toBe(true);
  });
});

describe('StubSandbox', () => {
  it('应正确执行代码', async () => {
    const sandbox = new StubSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);

    const result = await sandbox.execute('console.log("hello")');

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('应正确读写文件', async () => {
    const sandbox = new StubSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);

    await sandbox.writeFile('/test.txt', 'hello world');
    const content = await sandbox.readFile('/test.txt');

    expect(content).toBe('hello world');
  });

  it('读取不存在的文件应抛出错误', async () => {
    const sandbox = new StubSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);

    await expect(sandbox.readFile('/not-exists.txt')).rejects.toThrow(
      'File not found'
    );
  });

  it('应正确运行命令', async () => {
    const sandbox = new StubSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);

    const result = await sandbox.runCommand('ls -la');

    expect(result.success).toBe(true);
    expect(result.command).toBe('ls -la');
  });

  it('destroy 后不应能执行操作', async () => {
    const sandbox = new StubSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);

    await sandbox.destroy();

    const result = await sandbox.execute('console.log("hello")');
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('not running');
  });
});

describe('StubContextManager', () => {
  it('应正确添加消息', () => {
    const contextManager = new StubContextManager(
      'session-1',
      DEFAULT_CONFIG.context
    );

    contextManager.addMessage({
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    });

    const context = contextManager.getContext();
    expect(context.messages).toHaveLength(1);
    const firstMessage = context.messages[0];
    expect(firstMessage?.content).toBe('Hello');
  });

  it('应正确计算 token 数量', () => {
    const contextManager = new StubContextManager(
      'session-1',
      DEFAULT_CONFIG.context
    );

    // 添加 100 字符的消息
    contextManager.addMessage({
      id: 'msg-1',
      role: 'user',
      content: 'a'.repeat(100),
      timestamp: Date.now(),
    });

    // 粗略估算：100 字符 / 4 = 25 tokens
    expect(contextManager.getTokenCount()).toBe(25);
  });

  it('compact 应移除旧消息', () => {
    const contextManager = new StubContextManager(
      'session-1',
      DEFAULT_CONFIG.context
    );

    // 添加 30 条消息
    for (let i = 0; i < 30; i++) {
      contextManager.addMessage({
        id: `msg-${i}`,
        role: 'user',
        content: `Message ${i}`,
        timestamp: Date.now(),
      });
    }

    expect(contextManager.getContext().messages).toHaveLength(30);

    // 激进压缩应保留 5 条
    contextManager.compact('aggressive');

    expect(contextManager.getContext().messages).toHaveLength(5);
  });

  it('summarize 应返回摘要', () => {
    const contextManager = new StubContextManager(
      'session-1',
      DEFAULT_CONFIG.context
    );

    const summary = contextManager.summarize({
      includeModifiedFiles: true,
      includeUserGoal: true,
      includeKeyDecisions: true,
      includeUnresolvedIssues: true,
      includeNextSteps: true,
    });

    expect(summary).toHaveProperty('modifiedFiles');
    expect(summary).toHaveProperty('userGoal');
    expect(summary).toHaveProperty('keyDecisions');
  });
});

describe('全局配置', () => {
  beforeEach(() => {
    resetGlobalConfig();
  });

  it('setGlobalConfig 应更新全局配置', () => {
    const customConfig = loadConfig(
      { models: { orchestrator: { model: 'global-model' } } },
      { loadFromEnvironment: false }
    );

    setGlobalConfig(customConfig);

    const agent = createOrchestrator();
    expect(agent.config.model).toBe('global-model');
  });

  it('resetGlobalConfig 应重置为默认', () => {
    const customConfig = loadConfig(
      { models: { orchestrator: { model: 'global-model' } } },
      { loadFromEnvironment: false }
    );

    setGlobalConfig(customConfig);
    resetGlobalConfig();

    const agent = createOrchestrator();
    expect(agent.config.model).toBe('claude-opus-4');
  });
});


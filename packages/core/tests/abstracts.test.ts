/**
 * 抽象基类测试
 */

import { describe, expect, it } from 'bun:test';
import {
  BaseAgent,
  BaseSandbox,
  SimpleContextManager,
} from '../src/abstracts';
import { DEFAULT_CONFIG } from '../src/config';
import type {
  Task,
  TaskResult,
  AgentConfig,
  SandboxConfig,
  ExecutionOptions,
  ExecutionResult,
  CommandResult,
  ContextThresholds,
} from '../src/types';

// ============================================================================
// 测试用具体实现
// ============================================================================

/**
 * 测试用 Agent 实现
 */
class TestAgent extends BaseAgent {
  private shouldFail = false;
  private executionDelay = 0;

  constructor(id: string, config: AgentConfig) {
    super(id, 'worker', config);
  }

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  setExecutionDelay(delay: number): void {
    this.executionDelay = delay;
  }

  protected async executeTask(task: Task): Promise<TaskResult> {
    if (this.executionDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.executionDelay));
    }

    if (this.shouldFail) {
      throw new Error('Task execution failed');
    }

    return {
      taskId: task.id,
      status: 'success',
      output: { completed: true },
      artifacts: [],
      metrics: {
        startTime: Date.now(),
        endTime: Date.now(),
        duration: 0,
        tokensUsed: 100,
        toolCallCount: 2,
        retryCount: 0,
      },
      trace: {
        traceId: 'test-trace',
        spanId: 'test-span',
        operation: 'test',
        attributes: {},
        events: [],
        duration: 0,
      },
    };
  }
}

/**
 * 测试用 Sandbox 实现
 */
class TestSandbox extends BaseSandbox {
  private files = new Map<string, string>();

  constructor(id: string, config: SandboxConfig) {
    super(id, config);
  }

  protected async doInitialize(): Promise<void> {
    // 模拟初始化
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  protected async doExecute(code: string, _options?: ExecutionOptions): Promise<ExecutionResult> {
    return {
      success: true,
      stdout: `Executed: ${code.slice(0, 50)}`,
      stderr: '',
      exitCode: 0,
      duration: 10,
    };
  }

  protected async doWriteFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  protected async doReadFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (!content) throw new Error(`File not found: ${path}`);
    return content;
  }

  protected async doRunCommand(command: string): Promise<CommandResult> {
    return {
      command,
      success: true,
      stdout: `Command: ${command}`,
      stderr: '',
      exitCode: 0,
      duration: 5,
    };
  }

  protected async doDestroy(): Promise<void> {
    this.files.clear();
  }
}

// ============================================================================
// BaseAgent 测试
// ============================================================================

describe('BaseAgent', () => {
  const testConfig: AgentConfig = {
    provider: 'test',
    model: 'test-model',
    maxTokens: 1000,
  };

  describe('基本属性', () => {
    it('应正确初始化属性', () => {
      const agent = new TestAgent('test-agent', testConfig);

      expect(agent.id).toBe('test-agent');
      expect(agent.type).toBe('worker');
      expect(agent.config).toEqual(testConfig);
    });

    it('初始状态应为 idle', () => {
      const agent = new TestAgent('test-agent', testConfig);

      expect(agent.getState()).toBe('idle');
    });
  });

  describe('任务执行', () => {
    it('应正确执行任务', async () => {
      const agent = new TestAgent('test-agent', testConfig);
      const task: Task = {
        id: 'task-1',
        type: 'atomic',
        objective: '测试目标',
        constraints: [],
      };

      const result = await agent.run(task);

      expect(result.taskId).toBe('task-1');
      expect(result.status).toBe('success');
    });

    it('执行期间状态应为 running', async () => {
      const agent = new TestAgent('test-agent', testConfig);
      agent.setExecutionDelay(50);

      const task: Task = {
        id: 'task-1',
        type: 'atomic',
        objective: '测试',
        constraints: [],
      };

      const promise = agent.run(task);

      // 立即检查状态
      expect(agent.getState()).toBe('running');

      await promise;

      // 完成后状态应为 idle
      expect(agent.getState()).toBe('idle');
    });

    it('不应允许并发执行', async () => {
      const agent = new TestAgent('test-agent', testConfig);
      agent.setExecutionDelay(50);

      const task: Task = {
        id: 'task-1',
        type: 'atomic',
        objective: '测试',
        constraints: [],
      };

      const promise1 = agent.run(task);

      await expect(agent.run(task)).rejects.toThrow('already running');

      await promise1;
    });

    it('执行失败时应返回失败结果', async () => {
      const agent = new TestAgent('test-agent', testConfig);
      agent.setShouldFail(true);

      const task: Task = {
        id: 'task-1',
        type: 'atomic',
        objective: '测试',
        constraints: [],
      };

      const result = await agent.run(task);

      expect(result.status).toBe('failure');
      expect(result.output).toHaveProperty('error');
    });
  });

  describe('生命周期钩子', () => {
    it('应调用 onBeforeRun 钩子', async () => {
      const agent = new TestAgent('test-agent', testConfig);
      let hookCalled = false;

      agent.setHooks({
        onBeforeRun: async () => {
          hookCalled = true;
        },
      });

      const task: Task = {
        id: 'task-1',
        type: 'atomic',
        objective: '测试',
        constraints: [],
      };

      await agent.run(task);

      expect(hookCalled).toBe(true);
    });

    it('应调用 onAfterRun 钩子', async () => {
      const agent = new TestAgent('test-agent', testConfig);
      let receivedResult: TaskResult | null = null;

      agent.setHooks({
        onAfterRun: async (_task, result) => {
          receivedResult = result;
        },
      });

      const task: Task = {
        id: 'task-1',
        type: 'atomic',
        objective: '测试',
        constraints: [],
      };

      await agent.run(task);

      expect(receivedResult).not.toBeNull();
      expect(receivedResult!.status).toBe('success');
    });

    it('应调用 onError 钩子', async () => {
      const agent = new TestAgent('test-agent', testConfig);
      agent.setShouldFail(true);
      let errorReceived: Error | null = null;

      agent.setHooks({
        onError: async (_task, error) => {
          errorReceived = error;
        },
      });

      const task: Task = {
        id: 'task-1',
        type: 'atomic',
        objective: '测试',
        constraints: [],
      };

      await agent.run(task);

      expect(errorReceived).not.toBeNull();
      expect(errorReceived!.message).toBe('Task execution failed');
    });
  });

  describe('停止功能', () => {
    it('stop 应将状态设置为 stopped', async () => {
      const agent = new TestAgent('test-agent', testConfig);

      await agent.stop();

      expect(agent.getState()).toBe('stopped');
    });

    it('停止后不应允许执行任务', async () => {
      const agent = new TestAgent('test-agent', testConfig);
      await agent.stop();

      const task: Task = {
        id: 'task-1',
        type: 'atomic',
        objective: '测试',
        constraints: [],
      };

      await expect(agent.run(task)).rejects.toThrow('has been stopped');
    });
  });

  describe('日志上下文', () => {
    it('应返回正确的日志上下文', () => {
      const agent = new TestAgent('test-agent', testConfig);

      const context = agent.getLogContext();

      expect(context.agentId).toBe('test-agent');
      expect(context.agentType).toBe('worker');
    });
  });
});

// ============================================================================
// BaseSandbox 测试
// ============================================================================

describe('BaseSandbox', () => {
  describe('初始化', () => {
    it('初始状态应为 creating', () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);

      expect(sandbox.status).toBe('creating');
    });

    it('初始化后状态应为 running', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);

      await sandbox.initialize();

      expect(sandbox.status).toBe('running');
    });

    it('不应重复初始化', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);

      await sandbox.initialize();

      await expect(sandbox.initialize()).rejects.toThrow('Cannot initialize');
    });
  });

  describe('代码执行', () => {
    it('初始化前不应能执行代码', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);

      await expect(sandbox.execute('console.log("test")')).rejects.toThrow(
        'not running'
      );
    });

    it('应正确执行代码', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);
      await sandbox.initialize();

      const result = await sandbox.execute('console.log("hello")');

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('文件操作', () => {
    it('应正确读写文件', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);
      await sandbox.initialize();

      await sandbox.writeFile('/test.txt', 'test content');
      const content = await sandbox.readFile('/test.txt');

      expect(content).toBe('test content');
    });
  });

  describe('命令执行', () => {
    it('应正确运行命令', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);
      await sandbox.initialize();

      const result = await sandbox.runCommand('echo hello');

      expect(result.success).toBe(true);
      expect(result.command).toBe('echo hello');
    });
  });

  describe('销毁', () => {
    it('销毁后状态应为 stopped', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);
      await sandbox.initialize();

      await sandbox.destroy();

      expect(sandbox.status).toBe('stopped');
    });

    it('销毁后不应能执行操作', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);
      await sandbox.initialize();
      await sandbox.destroy();

      await expect(sandbox.execute('console.log("test")')).rejects.toThrow(
        'not running'
      );
    });
  });

  describe('生命周期钩子', () => {
    it('应调用 onCreate 钩子', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);
      let hookCalled = false;

      sandbox.setHooks({
        onCreate: async () => {
          hookCalled = true;
        },
      });

      await sandbox.initialize();

      expect(hookCalled).toBe(true);
    });

    it('应调用 onBeforeExecute 和 onAfterExecute 钩子', async () => {
      const sandbox = new TestSandbox('test-sandbox', DEFAULT_CONFIG.sandbox);
      await sandbox.initialize();

      let beforeCalled = false;
      let afterCalled = false;

      sandbox.setHooks({
        onBeforeExecute: async () => {
          beforeCalled = true;
        },
        onAfterExecute: async () => {
          afterCalled = true;
        },
      });

      await sandbox.execute('test');

      expect(beforeCalled).toBe(true);
      expect(afterCalled).toBe(true);
    });
  });
});

// ============================================================================
// SimpleContextManager 测试
// ============================================================================

describe('SimpleContextManager', () => {
  const thresholds: ContextThresholds = DEFAULT_CONFIG.context;

  describe('消息管理', () => {
    it('应正确添加消息', () => {
      const manager = new SimpleContextManager('session-1', thresholds);

      manager.addMessage({
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      const context = manager.getContext();
      expect(context.messages).toHaveLength(1);
    });

    it('应为消息自动生成 ID', () => {
      const manager = new SimpleContextManager('session-1', thresholds);

      manager.addMessage({
        id: '',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      const context = manager.getContext();
      const firstMessage = context.messages[0];
      expect(firstMessage).toBeDefined();
      expect(firstMessage?.id).toBeTruthy();
    });
  });

  describe('Token 计数', () => {
    it('应正确计算 token 数量', () => {
      const manager = new SimpleContextManager('session-1', thresholds);

      // 100 字符 ≈ 25 tokens
      manager.addMessage({
        id: 'msg-1',
        role: 'user',
        content: 'a'.repeat(100),
        timestamp: Date.now(),
      });

      expect(manager.getTokenCount()).toBe(25);
    });
  });

  describe('压缩', () => {
    it('aggressive 压缩应保留 5 条消息', () => {
      const manager = new SimpleContextManager('session-1', thresholds);

      for (let i = 0; i < 20; i++) {
        manager.addMessage({
          id: `msg-${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      manager.compact('aggressive');

      expect(manager.getContext().messages.length).toBeLessThanOrEqual(5);
    });

    it('balanced 压缩应保留 10 条消息', () => {
      const manager = new SimpleContextManager('session-1', thresholds);

      for (let i = 0; i < 20; i++) {
        manager.addMessage({
          id: `msg-${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      manager.compact('balanced');

      expect(manager.getContext().messages.length).toBeLessThanOrEqual(10);
    });

    it('应保留系统消息', () => {
      const manager = new SimpleContextManager('session-1', thresholds);

      manager.addMessage({
        id: 'system',
        role: 'system',
        content: 'System prompt',
        timestamp: Date.now(),
      });

      for (let i = 0; i < 20; i++) {
        manager.addMessage({
          id: `msg-${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      manager.compact('aggressive');

      const context = manager.getContext();
      const systemMessages = context.messages.filter(m => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
    });
  });

  describe('摘要', () => {
    it('应生成摘要', () => {
      const manager = new SimpleContextManager('session-1', thresholds);

      manager.addMessage({
        id: 'msg-1',
        role: 'user',
        content: 'My goal is to build a web app',
        timestamp: Date.now(),
      });

      const summary = manager.summarize({
        includeModifiedFiles: true,
        includeUserGoal: true,
        includeKeyDecisions: true,
        includeUnresolvedIssues: true,
        includeNextSteps: true,
      });

      expect(summary).toHaveProperty('userGoal');
      expect(summary.userGoal).toContain('goal');
    });
  });

  describe('清空', () => {
    it('应清空所有数据', () => {
      const manager = new SimpleContextManager('session-1', thresholds);

      manager.addMessage({
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      manager.clear();

      const context = manager.getContext();
      expect(context.messages).toHaveLength(0);
      expect(context.tokenCount).toBe(0);
    });
  });

  describe('生命周期钩子', () => {
    it('应调用 onMessageAdded 钩子', () => {
      const manager = new SimpleContextManager('session-1', thresholds);
      let messageContent = '';

      manager.setHooks({
        onMessageAdded: (msg) => {
          messageContent = msg.content;
        },
      });

      manager.addMessage({
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      expect(messageContent).toBe('Hello');
    });

    it('应调用 onThresholdReached 钩子', () => {
      // 使用较小的阈值进行测试
      const smallThresholds: ContextThresholds = {
        ...thresholds,
        compactionTrigger: 100,
      };
      const manager = new SimpleContextManager('session-1', smallThresholds);
      let thresholdType = '';

      manager.setHooks({
        onThresholdReached: (type) => {
          thresholdType = type;
        },
      });

      // 添加足够多的内容触发阈值
      manager.addMessage({
        id: 'msg-1',
        role: 'user',
        content: 'a'.repeat(500), // 约 125 tokens
        timestamp: Date.now(),
      });

      expect(thresholdType).toBe('compaction');
    });
  });
});


/**
 * Collaboration 模块单元测试
 *
 * 测试 Agent Registry、Message Broker、PubSub、Blackboard
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  FileAgentRegistry,
  FileMessageBroker,
  FilePubSubHub,
  FileBlackboard,
  CollaborationManager,
  BUILTIN_TOPICS,
} from '../src/collaboration';
import type { AgentRegistration, CollaborationRequest } from '../src/collaboration';

describe('FileAgentRegistry', () => {
  let tmpDir: string;
  let registry: FileAgentRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'collab-test-'));
    registry = new FileAgentRegistry(tmpDir, { pollInterval: 100, offlineThreshold: 1000 });
  });

  afterEach(async () => {
    await registry.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('should register and get agent', async () => {
    await registry.register({
      agentId: 'worker-1',
      sessionId: 'session-1',
      type: 'worker',
      capabilities: ['code', 'review'],
      status: 'online',
      priority: 5,
    });

    const agent = await registry.getAgent('worker-1');
    expect(agent).not.toBeNull();
    expect(agent?.agentId).toBe('worker-1');
    expect(agent?.capabilities).toEqual(['code', 'review']);
  });

  test('should list agents with filter', async () => {
    await registry.register({
      agentId: 'worker-1',
      sessionId: 'session-1',
      type: 'worker',
      capabilities: ['code'],
      status: 'online',
      priority: 5,
    });

    await registry.register({
      agentId: 'orchestrator-1',
      sessionId: 'session-1',
      type: 'orchestrator',
      capabilities: ['planning'],
      status: 'online',
      priority: 10,
    });

    const workers = await registry.listAgents({ type: 'worker' });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.agentId).toBe('worker-1');

    const allAgents = await registry.listAgents();
    expect(allAgents).toHaveLength(2);
  });

  test('should unregister agent', async () => {
    await registry.register({
      agentId: 'worker-1',
      sessionId: 'session-1',
      type: 'worker',
      capabilities: [],
      status: 'online',
      priority: 0,
    });

    await registry.unregister('worker-1');
    const agent = await registry.getAgent('worker-1');
    expect(agent).toBeNull();
  });

  test('should update heartbeat', async () => {
    await registry.register({
      agentId: 'worker-1',
      sessionId: 'session-1',
      type: 'worker',
      capabilities: [],
      status: 'online',
      priority: 0,
    });

    const before = await registry.getAgent('worker-1');
    const beforeHeartbeat = before?.lastHeartbeat ?? 0;

    await new Promise(r => setTimeout(r, 10));
    await registry.heartbeat('worker-1');

    const after = await registry.getAgent('worker-1');
    expect(after?.lastHeartbeat).toBeGreaterThan(beforeHeartbeat);
  });
});

describe('FileMessageBroker', () => {
  let tmpDir: string;
  let broker1: FileMessageBroker;
  let broker2: FileMessageBroker;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'broker-test-'));
    broker1 = new FileMessageBroker(tmpDir, 'agent-1', { pollInterval: 50, defaultTimeout: 5000 });
    broker2 = new FileMessageBroker(tmpDir, 'agent-2', { pollInterval: 50, defaultTimeout: 5000 });
  });

  afterEach(async () => {
    await broker1.close();
    await broker2.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('should send and receive fire-and-forget requests', async () => {
    const received: unknown[] = [];

    // Agent 2 监听请求
    broker2.onRequest(async (req: CollaborationRequest) => {
      received.push(req.payload);
      return { success: true };
    });

    // Agent 1 发送请求（fire-and-forget）
    await broker1.send({
      fromAgentId: 'agent-1',
      toAgentId: 'agent-2',
      type: 'query',
      payload: { message: 'hello' },
      timeout: 5000,
      priority: 5,
    });

    // 等待处理
    await new Promise(r => setTimeout(r, 300));

    expect(received).toHaveLength(1);
    expect((received[0] as { message: string }).message).toBe('hello');
  });

  test('should handle request-response closed loop', async () => {
    // Agent 2 监听请求并返回响应
    broker2.onRequest(async (req: CollaborationRequest) => {
      const payload = req.payload as { message: string };
      return {
        success: true,
        payload: { echo: payload.message, from: 'agent-2' },
      };
    });

    // Agent 1 发送请求并等待响应
    const response = await broker1.request({
      fromAgentId: 'agent-1',
      toAgentId: 'agent-2',
      type: 'query',
      payload: { message: 'hello' },
      timeout: 5000,
      priority: 5,
    });

    expect(response.success).toBe(true);
    expect(response.fromAgentId).toBe('agent-2');
    const responsePayload = response.payload as { echo: string; from: string };
    expect(responsePayload.echo).toBe('hello');
    expect(responsePayload.from).toBe('agent-2');
  });

  test('should sort pending requests by priority', async () => {
    // 发送多个不同优先级的请求
    await broker1.send({
      fromAgentId: 'sender',
      toAgentId: 'agent-1',
      type: 'task',
      payload: { id: 1 },
      timeout: 5000,
      priority: 1,
    });

    await broker1.send({
      fromAgentId: 'sender',
      toAgentId: 'agent-1',
      type: 'task',
      payload: { id: 2 },
      timeout: 5000,
      priority: 10,
    });

    await broker1.send({
      fromAgentId: 'sender',
      toAgentId: 'agent-1',
      type: 'task',
      payload: { id: 3 },
      timeout: 5000,
      priority: 5,
    });

    const pending = await broker1.getPendingRequests();
    expect(pending).toHaveLength(3);
    expect(pending[0]?.priority).toBe(10);
    expect(pending[1]?.priority).toBe(5);
    expect(pending[2]?.priority).toBe(1);
  });
});

describe('FilePubSubHub', () => {
  let tmpDir: string;
  let hub1: FilePubSubHub;
  let hub2: FilePubSubHub;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pubsub-test-'));
    hub1 = new FilePubSubHub(tmpDir, 'publisher-1', { pollInterval: 50, eventTTL: 5000 });
    hub2 = new FilePubSubHub(tmpDir, 'subscriber-1', { pollInterval: 50, eventTTL: 5000 });
  });

  afterEach(async () => {
    await hub1.close();
    await hub2.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('should publish and receive events', async () => {
    const received: unknown[] = [];

    hub2.subscribe(BUILTIN_TOPICS.TASK_COMPLETED, (event) => {
      received.push(event.payload);
    });

    await hub1.publish(BUILTIN_TOPICS.TASK_COMPLETED, { taskId: 'task-1' });

    // 等待事件传播
    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(1);
    expect((received[0] as { taskId: string }).taskId).toBe('task-1');
  });

  test('should match wildcard patterns', async () => {
    const received: string[] = [];

    hub2.subscribePattern('task:*', (event) => {
      received.push(event.topic);
    });

    await hub1.publish('task:started', { id: 1 });
    await hub1.publish('task:completed', { id: 1 });
    await hub1.publish('agent:joined', { id: 1 }); // 不匹配

    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(2);
    expect(received).toContain('task:started');
    expect(received).toContain('task:completed');
  });
});

describe('FileBlackboard', () => {
  let tmpDir: string;
  let bb1: FileBlackboard;
  let bb2: FileBlackboard;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'bb-test-'));
    bb1 = new FileBlackboard(tmpDir, 'writer-1', { pollInterval: 50 });
    bb2 = new FileBlackboard(tmpDir, 'writer-2', { pollInterval: 50 });
  });

  afterEach(async () => {
    await bb1.close();
    await bb2.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('should set and get values', async () => {
    await bb1.set('config', { theme: 'dark' });

    const value = await bb2.get<{ theme: string }>('config');
    expect(value).toEqual({ theme: 'dark' });
  });

  test('should delete keys', async () => {
    await bb1.set('temp', 'data');
    expect(await bb1.get('temp')).toBe('data');

    const deleted = await bb1.delete('temp');
    expect(deleted).toBe(true);
    expect(await bb1.get('temp')).toBeNull();
  });

  test('should support compareAndSet', async () => {
    await bb1.set('counter', 0);

    // 成功的 CAS
    const success1 = await bb1.compareAndSet('counter', 1, 10);
    expect(success1).toBe(true);
    expect(await bb1.get('counter')).toBe(10);

    // 失败的 CAS（版本不匹配）
    const success2 = await bb1.compareAndSet('counter', 1, 20);
    expect(success2).toBe(false);
    expect(await bb1.get('counter')).toBe(10);
  });

  test('should list keys with pattern', async () => {
    await bb1.set('user:1:name', 'Alice');
    await bb1.set('user:2:name', 'Bob');
    await bb1.set('config:theme', 'dark');

    const userKeys = await bb1.keys('user:*');
    expect(userKeys).toHaveLength(2);

    const allKeys = await bb1.keys();
    expect(allKeys).toHaveLength(3);
  });
});

describe('CollaborationManager', () => {
  let tmpDir: string;
  let manager: CollaborationManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'manager-test-'));
    manager = new CollaborationManager({
      backend: 'file',
      rootDir: tmpDir,
      heartbeatInterval: 100,
      requestTimeout: 5000,
      offlineThreshold: 1000,
    });
  });

  afterEach(async () => {
    await manager.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('should start and register agent', async () => {
    await manager.start('worker-1', {
      sessionId: 'session-1',
      type: 'worker',
      capabilities: ['code'],
      status: 'online',
      priority: 5,
    });

    expect(manager.isStarted()).toBe(true);
    expect(manager.getAgentId()).toBe('worker-1');

    const peers = await manager.discoverPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.agentId).toBe('worker-1');
  });

  test('should discover peers by capabilities', async () => {
    await manager.start('worker-1', {
      sessionId: 'session-1',
      type: 'worker',
      capabilities: ['code', 'review'],
      status: 'online',
      priority: 5,
    });

    // 手动注册另一个 agent
    await manager.registry.register({
      agentId: 'worker-2',
      sessionId: 'session-1',
      type: 'worker',
      capabilities: ['test'],
      status: 'online',
      priority: 3,
    });

    const codePeers = await manager.discoverPeers(['code']);
    expect(codePeers).toHaveLength(1);
    expect(codePeers[0]?.agentId).toBe('worker-1');

    const allPeers = await manager.discoverPeers();
    expect(allPeers).toHaveLength(2);
  });
});

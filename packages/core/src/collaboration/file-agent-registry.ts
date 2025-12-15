/**
 * 文件系统 Agent Registry 实现
 *
 * 基于共享文件系统的 Agent 发现与注册服务
 * 使用 `.tachikoma/collaboration/registry/` 目录存储 Agent 信息
 *
 * @module collaboration/file-agent-registry
 */

import { join } from 'node:path';
import type {
  AgentRegistration,
  AgentFilter,
  AgentStatus,
  AgentChangeHandler,
  IAgentRegistry,
} from './types';
import {
  atomicWriteJson,
  readJsonFile,
  listDir,
  fileExists,
  safeDeleteFile,
  ensureDir,
} from '../orchestrator/session/utils';

/**
 * 文件系统 Agent Registry
 */
export class FileAgentRegistry implements IAgentRegistry {
  private readonly registryDir: string;
  private readonly changeHandlers = new Set<AgentChangeHandler>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private knownAgents = new Map<string, AgentRegistration>();
  private readonly pollInterval: number;
  private readonly offlineThreshold: number;

  constructor(
    rootDir: string,
    options: { pollInterval?: number; offlineThreshold?: number } = {}
  ) {
    this.registryDir = join(rootDir, 'collaboration', 'registry');
    this.pollInterval = options.pollInterval ?? 2000;
    this.offlineThreshold = options.offlineThreshold ?? 15000;
  }

  /**
   * 获取 Agent 文件路径
   */
  private getAgentPath(agentId: string): string {
    return join(this.registryDir, `${agentId}.json`);
  }

  /**
   * 注册 Agent
   */
  async register(agent: Omit<AgentRegistration, 'lastHeartbeat'>): Promise<void> {
    await ensureDir(this.registryDir);

    const registration: AgentRegistration = {
      ...agent,
      lastHeartbeat: Date.now(),
    };

    await atomicWriteJson(this.getAgentPath(agent.agentId), registration);
    this.knownAgents.set(agent.agentId, registration);

    // 通知变更
    await this.notifyChange(registration, 'joined');

    // 启动轮询（如果尚未启动）
    this.startPolling();
  }

  /**
   * 注销 Agent
   */
  async unregister(agentId: string): Promise<void> {
    const agent = this.knownAgents.get(agentId);
    await safeDeleteFile(this.getAgentPath(agentId));
    this.knownAgents.delete(agentId);

    if (agent) {
      await this.notifyChange(agent, 'left');
    }
  }

  /**
   * 获取 Agent 信息
   */
  async getAgent(agentId: string): Promise<AgentRegistration | null> {
    const path = this.getAgentPath(agentId);
    if (!fileExists(path)) {
      return null;
    }
    return readJsonFile<AgentRegistration>(path);
  }

  /**
   * 列出 Agents
   */
  async listAgents(filter?: AgentFilter): Promise<AgentRegistration[]> {
    const files = await listDir(this.registryDir).catch(() => []);
    const agents: AgentRegistration[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const agent = await readJsonFile<AgentRegistration>(
        join(this.registryDir, file)
      );
      if (!agent) continue;

      // 检查是否离线
      const isOffline = Date.now() - agent.lastHeartbeat > this.offlineThreshold;
      if (isOffline && agent.status !== 'offline') {
        agent.status = 'offline';
      }

      // 应用过滤
      if (filter) {
        if (filter.sessionId && agent.sessionId !== filter.sessionId) continue;
        if (filter.type && agent.type !== filter.type) continue;
        if (filter.status && agent.status !== filter.status) continue;
        if (filter.capabilities) {
          const hasAll = filter.capabilities.every(cap =>
            agent.capabilities.includes(cap)
          );
          if (!hasAll) continue;
        }
      }

      agents.push(agent);
    }

    return agents;
  }

  /**
   * 更新心跳
   */
  async heartbeat(agentId: string): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent) return;

    agent.lastHeartbeat = Date.now();
    if (agent.status === 'offline') {
      agent.status = 'online';
    }

    await atomicWriteJson(this.getAgentPath(agentId), agent);
    this.knownAgents.set(agentId, agent);
  }

  /**
   * 更新状态
   */
  async updateStatus(agentId: string, status: AgentStatus): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent) return;

    const oldStatus = agent.status;
    agent.status = status;
    agent.lastHeartbeat = Date.now();

    await atomicWriteJson(this.getAgentPath(agentId), agent);
    this.knownAgents.set(agentId, agent);

    if (oldStatus !== status) {
      await this.notifyChange(agent, 'status_changed');
    }
  }

  /**
   * 监听 Agent 变更
   */
  onAgentChange(handler: AgentChangeHandler): void {
    this.changeHandlers.add(handler);
  }

  /**
   * 移除变更监听
   */
  offAgentChange(handler: AgentChangeHandler): void {
    this.changeHandlers.delete(handler);
  }

  /**
   * 关闭 Registry
   */
  async close(): Promise<void> {
    this.stopPolling();
    this.changeHandlers.clear();
    this.knownAgents.clear();
  }

  /**
   * 通知变更
   */
  private async notifyChange(
    agent: AgentRegistration,
    event: 'joined' | 'left' | 'status_changed'
  ): Promise<void> {
    for (const handler of this.changeHandlers) {
      try {
        await handler(agent, event);
      } catch (error) {
        console.error('[FileAgentRegistry] Error in change handler:', error);
      }
    }
  }

  /**
   * 启动轮询检测
   */
  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.pollForChanges().catch(error => {
        console.error('[FileAgentRegistry] Poll error:', error);
      });
    }, this.pollInterval);
  }

  /**
   * 停止轮询
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 轮询检测变更
   */
  private async pollForChanges(): Promise<void> {
    const currentAgents = await this.listAgents();
    const currentIds = new Set(currentAgents.map(a => a.agentId));

    // 检测新加入的 Agent
    for (const agent of currentAgents) {
      const known = this.knownAgents.get(agent.agentId);
      if (!known) {
        this.knownAgents.set(agent.agentId, agent);
        await this.notifyChange(agent, 'joined');
      } else if (known.status !== agent.status) {
        this.knownAgents.set(agent.agentId, agent);
        await this.notifyChange(agent, 'status_changed');
      }
    }

    // 检测离开的 Agent
    for (const [agentId, agent] of this.knownAgents) {
      if (!currentIds.has(agentId)) {
        this.knownAgents.delete(agentId);
        await this.notifyChange(agent, 'left');
      }
    }
  }
}

/**
 * 创建文件系统 Agent Registry
 */
export function createFileAgentRegistry(
  rootDir: string,
  options?: { pollInterval?: number; offlineThreshold?: number }
): FileAgentRegistry {
  return new FileAgentRegistry(rootDir, options);
}

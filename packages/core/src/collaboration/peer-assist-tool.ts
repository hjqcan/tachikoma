/**
 * Peer Assist 工具
 *
 * 允许 Worker 请求其他 Worker 协助完成任务
 *
 * @module collaboration/peer-assist
 */

import type { Tool } from '../types';
import type { ToolResult } from '../tools/types';
import type { AgentRegistration } from './types';
import type { CollaborationManager } from './collaboration-manager';

/**
 * Peer Assist 工具输入
 */
export interface PeerAssistInput {
  /** 目标能力要求（可选） */
  requiredCapabilities?: string[];
  /** 指定目标 Agent ID（可选，优先于 capabilities） */
  targetAgentId?: string;
  /** 任务描述 */
  taskDescription: string;
  /** 任务负载（传给目标 Agent） */
  taskPayload?: unknown;
  /** 请求优先级（0-10，默认 5） */
  priority?: number;
  /** 超时时间（毫秒，默认 30000） */
  timeout?: number;
}

/**
 * Peer Assist 工具输出
 */
export interface PeerAssistOutput {
  /** 是否成功 */
  success: boolean;
  /** 响应 Agent ID */
  respondedAgentId?: string;
  /** 响应负载 */
  response?: unknown;
  /** 错误信息 */
  error?: string;
  /** 可用 Peers 列表（如果没有找到合适的） */
  availablePeers?: AgentRegistration[];
}

/**
 * Peer Assist 工具定义（不含 execute）
 */
export const peerAssistToolDefinition: Omit<Tool, 'execute'> = {
  name: 'request_peer_assist',
  description: `请求其他 Agent 协助完成任务。

使用场景：
1. 需要特定能力的 Agent 处理子任务
2. 并行处理提高效率
3. 跨领域协作

参数：
- requiredCapabilities: 目标 Agent 需要具备的能力列表
- targetAgentId: 直接指定目标 Agent（可选）
- taskDescription: 任务描述
- taskPayload: 传给目标的详细数据（可选）
- priority: 优先级 0-10，高优先级会插队（默认 5）
- timeout: 超时毫秒数（默认 30000）`,
  inputSchema: {
    type: 'object',
    properties: {
      requiredCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description: '目标 Agent 需要具备的能力列表',
      },
      targetAgentId: {
        type: 'string',
        description: '直接指定目标 Agent ID',
      },
      taskDescription: {
        type: 'string',
        description: '任务描述',
      },
      taskPayload: {
        type: 'object',
        description: '传给目标的详细数据',
      },
      priority: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        default: 5,
        description: '请求优先级',
      },
      timeout: {
        type: 'number',
        default: 30000,
        description: '超时时间（毫秒）',
      },
    },
    required: ['taskDescription'],
  },
};

/**
 * 创建 Peer Assist 工具执行器
 *
 * @param collaboration - CollaborationManager 实例
 * @returns 工具执行函数
 */
export function createPeerAssistExecutor(
  collaboration: CollaborationManager
): (input: PeerAssistInput) => Promise<ToolResult<PeerAssistOutput>> {
  return async (input: PeerAssistInput): Promise<ToolResult<PeerAssistOutput>> => {
    const {
      requiredCapabilities,
      targetAgentId,
      taskDescription,
      taskPayload,
      priority = 5,
      timeout = 30000,
    } = input;

    try {
      // 1. 确定目标 Agent
      let target: AgentRegistration | null = null;

      if (targetAgentId) {
        // 直接指定
        target = await collaboration.registry.getAgent(targetAgentId);
        if (!target || target.status !== 'online') {
          return {
            success: false,
            error: `Target agent ${targetAgentId} not available`,
          };
        }
      } else {
        // 通过能力发现 - 包含 busy 状态以便回退
        const peers = await collaboration.discoverPeers(requiredCapabilities, true);
        const selfId = collaboration.getAgentId();

        // 排除自己
        const candidates = peers.filter((p: AgentRegistration) => p.agentId !== selfId);

        if (candidates.length === 0) {
          return {
            success: false,
            error: 'No suitable peers found',
            data: {
              success: false,
              error: 'No suitable peers found',
              availablePeers: peers,
            },
          };
        }

        // 选择优先级最高的空闲 Agent
        target = candidates
          .filter((p: AgentRegistration) => p.status === 'online')
          .sort((a: AgentRegistration, b: AgentRegistration) => b.priority - a.priority)[0] ?? null;

        if (!target) {
          // 没有空闲的，选择 busy 中优先级最高的（可能正在处理其他请求）
          target = candidates
            .filter((p: AgentRegistration) => p.status === 'busy')
            .sort((a: AgentRegistration, b: AgentRegistration) => b.priority - a.priority)[0] ?? null;
        }
      }

      if (!target) {
        return {
          success: false,
          error: 'No target agent found',
        };
      }

      // 2. 发送协作请求
      const response = await collaboration.broker.request({
        fromAgentId: collaboration.getAgentId() ?? 'unknown',
        toAgentId: target.agentId,
        type: 'assist',
        payload: {
          description: taskDescription,
          data: taskPayload,
        },
        timeout,
        priority,
      });

      return {
        success: response.success,
        data: {
          success: response.success,
          respondedAgentId: response.fromAgentId,
          response: response.payload,
          ...(response.error && { error: response.error }),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * 创建完整的 Peer Assist 工具
 *
 * @param collaboration - CollaborationManager 实例
 * @returns 包含定义和执行器的工具对象
 */
export function createPeerAssistTool(
  collaboration: CollaborationManager
): Tool {
  return {
    ...peerAssistToolDefinition,
    execute: createPeerAssistExecutor(collaboration),
  } as Tool;
}


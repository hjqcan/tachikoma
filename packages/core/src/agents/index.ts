/**
 * Agents 模块
 *
 * 提供对外可复用、可继承的 Agent 实现封装（例如 WorkerAgent）。
 *
 * 注意：Planner 目前是 service/组件（非 Agent），以避免把 plan(input) 强行塞进 Task->TaskResult 语义。
 */

export { WorkerAgent, createWorkerAgent, type WorkerAgentOptions } from './worker-agent';


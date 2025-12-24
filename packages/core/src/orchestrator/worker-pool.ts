/**
 * Worker 池管理模块
 *
 * 注：实际实现已拆分到 worker-pool/ 目录
 *
 * @packageDocumentation
 */

// 向后兼容：重新导出所有类型和实现
export type {
  WorkerPoolEventType,
  WorkerPoolEvent,
  WorkerPoolEventHandler,
  AssignmentResult,
  IWorkerPool,
  MockTaskExecutor,
  MockWorkerPoolOptions,
} from './worker-pool/index';

export {
  DefaultWorkerPool,
  createWorkerPool,
  MockWorkerPool,
  createMockWorkerPool,
} from './worker-pool/index';

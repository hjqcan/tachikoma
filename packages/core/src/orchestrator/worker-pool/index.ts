/**
 * Worker 池模块
 *
 * @packageDocumentation
 */

// 类型导出
export type {
  WorkerPoolEventType,
  WorkerPoolEvent,
  WorkerPoolEventHandler,
  AssignmentResult,
  IWorkerPool,
  ActiveTask,
  MockTaskExecutor,
  MockWorkerPoolOptions,
} from './types';

// 实现导出
export { DefaultWorkerPool, createWorkerPool } from './default-pool';
export { MockWorkerPool, createMockWorkerPool } from './mock-pool';


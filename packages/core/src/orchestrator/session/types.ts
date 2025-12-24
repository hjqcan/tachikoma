/**
 * 共享文件系统协调机制类型定义（barrel）
 *
 * 说明：
 * - 原 `types.ts` 过大（>1k 行），已按职责拆分到 `./types/*`
 * - 对外仍保持 `import { ... } from './types'` 不变，避免破坏上层引用
 */

export * from './types/config';
export * from './types/runtime';
export * from './types/worker';
export * from './types/shared';
export * from './types/events';
export * from './types/checkpoint';
export * from './types/session-file-manager';



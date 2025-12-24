import type { OrchestratorEventType } from '../types';
import type { RecoveryStrategy } from '../session';

export type EmitFn = <T = unknown>(
  type: OrchestratorEventType,
  taskId: string,
  data: T,
  subtaskId?: string
) => void;

export interface ResumeFromOptions {
  strategy?: RecoveryStrategy;
  skipFailed?: boolean;
  resetRetryCount?: boolean;
  maxRetries?: number;
  timeout?: number;
  signal?: AbortSignal;
}



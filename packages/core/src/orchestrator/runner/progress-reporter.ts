import type { ProgressFile } from '../session';
import type { OrchestratorState } from '../state';

export class ProgressReporter {
  constructor(private readonly state: OrchestratorState) {}

  async write(taskId: string, status: ProgressFile['status']): Promise<void> {
    const sm = this.state.sessionManager;
    const exec = this.state.executionState;
    if (!sm || !exec) return;

    const payload: Omit<ProgressFile, 'sessionId' | 'updatedAt'> = {
      taskId,
      status,
      currentStep: exec.currentStep,
      totalSteps: exec.totalSteps,
      completedSubtasks: Array.from(exec.completedSubtasks.keys()),
      failedSubtasks: Array.from(exec.failedSubtasks.keys()),
      runningSubtasks: Array.from(exec.runningSubtasks),
      startedAt: exec.startTime,
    };

    await sm.writeProgress(payload);
  }
}



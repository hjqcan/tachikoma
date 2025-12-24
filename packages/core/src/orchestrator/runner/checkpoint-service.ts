import { createSubtaskSnapshots } from '../session';
import type { CheckpointData, CheckpointManager } from '../session';
import type { OrchestratorConfig, PlannerOutput } from '../types';
import type { OrchestratorState } from '../state';
import type { EmitFn } from './types';

export class CheckpointService {
  private inFlight = false;

  constructor(
    private readonly orchestratorConfig: OrchestratorConfig,
    private readonly state: OrchestratorState,
    private readonly emit: EmitFn,
    private readonly getCheckpointManager: () => CheckpointManager | null
  ) {}

  setInFlight(flag: boolean): void {
    this.inFlight = flag;
  }

  buildPayload(
    taskId: string,
    planStatus: CheckpointData['planStatus']
  ): Omit<CheckpointData, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'version'> | null {
    if (!this.orchestratorConfig.checkpoint.enabled) return null;
    const checkpointManager = this.getCheckpointManager();
    if (!checkpointManager) return null;

    const exec = this.state.executionState;
    const plan = this.state.currentPlanOutput as PlannerOutput | null;
    if (!exec || !plan) return null;

    const subtaskSnapshots = createSubtaskSnapshots(
      plan.subtasks.map((s) => ({
        id: s.id,
        status: 'pending' as const,
        ...(typeof s.assignedWorkerId === 'string' ? { assignedWorkerId: s.assignedWorkerId } : {}),
      })),
      {
        completedSubtasks: exec.completedSubtasks as unknown as Map<string, unknown>,
        failedSubtasks: exec.failedSubtasks,
        runningSubtasks: exec.runningSubtasks,
      }
    );

    const completedResults: Record<string, unknown> = {};
    for (const [id, result] of exec.completedSubtasks.entries()) {
      completedResults[id] = result.output;
    }

    const executionPlan = plan.executionPlan?.steps
      ? {
          steps: plan.executionPlan.steps.map((s) => ({
            order: s.order,
            subtaskIds: s.subtaskIds,
            parallel: s.parallel,
          })),
        }
      : undefined;

    return {
      taskId,
      planStatus,
      currentStep: exec.currentStep,
      totalSteps: exec.totalSteps,
      completedSubtaskIds: Array.from(exec.completedSubtasks.keys()),
      failedSubtaskIds: Array.from(exec.failedSubtasks.keys()),
      runningSubtaskIds: Array.from(exec.runningSubtasks),
      subtaskSnapshots,
      completedResults,
      totalRetries: exec.totalRetries,
      totalTokens: exec.totalTokens,
      ...(executionPlan ? { executionPlan } : {}),
      ...(this.state.currentRunMetadata ? { contextData: this.state.currentRunMetadata } : {}),
    };
  }

  async saveSnapshot(
    taskId: string,
    planStatus: CheckpointData['planStatus'],
    reason?: string
  ): Promise<void> {
    if (!this.orchestratorConfig.checkpoint.enabled) return;
    const checkpointManager = this.getCheckpointManager();
    if (!checkpointManager) return;
    if (this.inFlight) return;

    const payload = this.buildPayload(taskId, planStatus);
    if (!payload) return;

    this.inFlight = true;
    try {
      const checkpoint = await checkpointManager.saveCheckpoint(payload);
      this.emit('checkpoint:created', taskId, {
        checkpointId: checkpoint.id,
        ...(reason ? { reason } : {}),
      });
    } finally {
      this.inFlight = false;
    }
  }
}



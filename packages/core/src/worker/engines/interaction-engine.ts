/**
 * Interaction Engine
 *
 * Manages human interaction protocols:
 * - Approval flows (Callbacks & File Protocol)
 * - Intervention handling (Pause, Abort, Redirect)
 */

import type {
  WorkerApprovalRequestMessage,
  WorkerExecutionOptions,
  PendingApprovalInput,
  ApprovalCategory,
} from '../types';
import { DEFAULT_KEY_DECISION_POLICY } from '../types';

export class InteractionEngine {
  private abortController: AbortController | null = null;


  /**
   * Set the abort controller for the current task
   */
  setAbortController(controller: AbortController) {
    this.abortController = controller;
  }

  /**
   * Wait for approval (Blocking + Timeout)
   *
   * Priority:
   * 1. onApprovalRequest callback
   * 2. File protocol (pending_approval.json)
   * 3. Default decision (warns)
   */
  async waitForApproval(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    subtaskId = 'unknown'
  ): Promise<boolean> {
    const timeout = request.timeout ?? DEFAULT_KEY_DECISION_POLICY.approvalTimeout;
    const defaultDecision = request.defaultDecision ?? DEFAULT_KEY_DECISION_POLICY.defaultDecision;
    const pollInterval = 1000;

    // Priority 1: Callback
    if (options.onApprovalRequest) {
      return this.waitForApprovalViaCallback(request, options, timeout, defaultDecision);
    }

    // Priority 2: File Protocol
    if (options.onWritePendingApproval && options.onReadApprovalResponse) {
      return this.waitForApprovalViaFileProtocol(
        request, 
        options, 
        subtaskId, 
        timeout, 
        defaultDecision, 
        pollInterval
      );
    }

    // Fallback: Default Decision
    console.warn(
      `[InteractionEngine] ⚠️ No approval mechanism available for request ${request.requestId}. ` +
      `Neither callback nor file protocol configured. Using default decision: ${defaultDecision}`
    );
    return defaultDecision === 'approve';
  }

  /**
   * Wait for approval via Callback
   */
  protected async waitForApprovalViaCallback(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    timeout: number,
    defaultDecision: 'approve' | 'reject'
  ): Promise<boolean> {
    try {
      const timeoutPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          console.warn(
            `[InteractionEngine] Approval timeout for request ${request.requestId}, ` +
            `using default decision: ${defaultDecision}`
          );
          resolve(defaultDecision === 'approve');
        }, timeout);
      });

      return await Promise.race([
        options.onApprovalRequest ? options.onApprovalRequest(request) : Promise.resolve(defaultDecision === 'approve'),
        timeoutPromise,
      ]);
    } catch (error) {
      console.error(`[InteractionEngine] Approval callback error:`, error);
      return defaultDecision === 'approve';
    }
  }

  /**
   * Wait for approval via File Protocol
   */
  private async waitForApprovalViaFileProtocol(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    subtaskId: string,
    timeout: number,
    defaultDecision: 'approve' | 'reject',
    pollInterval: number
  ): Promise<boolean> {
    try {
      // 1. Write pending approval
      const approvalInput: PendingApprovalInput = {
        requestId: request.requestId,
        subtaskId: subtaskId,
        type: this.mapCategoryToApprovalType(request.category),
        description: request.description,
        details: {
          metadata: request.details,
          impactScope: (request.details.impactScope as 'high' | 'medium' | 'low') ?? 'high',
          reversible: (request.details.reversible as boolean) ?? false, 
        },
        timeout,
        defaultDecision: defaultDecision,
      };

      if (options.onWritePendingApproval) {
        await options.onWritePendingApproval(approvalInput);
      }
      console.log(`[InteractionEngine] Wrote pending approval: ${request.requestId}`);

      // 2. Poll for response
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        if (this.abortController?.signal.aborted) {
          console.log(`[InteractionEngine] Approval wait aborted`);
          return false;
        }

        if (options.onReadApprovalResponse) {
          // eslint-disable-next-line no-await-in-loop
          const response = await options.onReadApprovalResponse();
          if (response && response.requestId === request.requestId) {
            console.log(
              `[InteractionEngine] Approval response received: ${response.approved ? 'approved' : 'rejected'}`
            );

            if (options.onClearPendingApproval) {
              // eslint-disable-next-line no-await-in-loop
              await options.onClearPendingApproval();
            }

            return response.approved;
          }
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      // 3. Timeout
      console.warn(
        `[InteractionEngine] Approval timeout for request ${request.requestId}, ` +
        `using default decision: ${defaultDecision}`
      );

      if (options.onClearPendingApproval) {
        await options.onClearPendingApproval();
      }

      return defaultDecision === 'approve';
    } catch (error) {
      console.error(`[InteractionEngine] File protocol approval error:`, error);
      return defaultDecision === 'approve';
    }
  }

  /**
   * Check and Handle Intervention
   * Returns: 'continue' | 'pause' | 'abort'
   */
  async checkAndHandleIntervention(
    options: WorkerExecutionOptions
  ): Promise<'continue' | 'pause' | 'abort'> {
    if (!options.onCheckIntervention) {
      return 'continue';
    }

    try {
      const intervention = await options.onCheckIntervention();

      if (!intervention || intervention.acknowledged) {
        return 'continue';
      }

      console.log(
        `[InteractionEngine] Intervention detected: ${intervention.type} - ${intervention.reason}`
      );

      switch (intervention.type) {
        case 'abort':
          if (options.onAcknowledgeIntervention) {
            await options.onAcknowledgeIntervention(intervention.interventionId);
          }
          return 'abort';

        case 'pause':
          return 'pause';

        case 'resume':
          if (options.onAcknowledgeIntervention) {
            await options.onAcknowledgeIntervention(intervention.interventionId);
          }
          return 'continue';

        case 'redirect':
        case 'guidance':
          console.log(`[InteractionEngine] Guidance: ${intervention.instructions}`);
          if (options.onAcknowledgeIntervention) {
            await options.onAcknowledgeIntervention(intervention.interventionId);
          }
          return 'continue';

        default:
          return 'continue';
      }
    } catch (error) {
      console.warn(`[InteractionEngine] Error checking intervention:`, error);
      return 'continue';
    }
  }

  /**
   * Map Approval Category to File Protocol Type
   */
  private mapCategoryToApprovalType(
    category?: ApprovalCategory
  ): PendingApprovalInput['type'] {
    switch (category) {
      case 'key_decision':
      case 'high_risk_tool':
      case 'dangerous_pattern':
        return 'dangerous_operation';
      default:
        return 'dangerous_operation';
    }
  }
}

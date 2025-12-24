/**
 * Orchestrator 服务模块导出
 */

export { EventService, createEventService } from './event-service';

export {
  ApprovalArbitrationService,
  createApprovalArbitrationService,
} from './approval-arbitration';
export type {
  FileWriteArbitrationParams,
  ExpandCommitArbitrationParams,
  DelayedApproval,
  TaskMasterCallbacks,
  ApprovalArbitrationConfig,
} from './approval-arbitration';

export {
  IntegrationContextService,
  createIntegrationContextService,
} from './integration-context';
export type {
  SharedKnowledgeData,
  IntegrationContextConfig,
} from './integration-context';

export {
  CollaborationService,
  createCollaborationService,
} from './collaboration-service';
export type {
  CollaborationConfig,
  WorkerCollaborationConfig,
  CollaborationWorkerInfo,
  IWorkerPoolForCollaboration,
  CollaborationRequest,
  CollaborationResponse,
  ICollaborationManager,
} from './collaboration-service';

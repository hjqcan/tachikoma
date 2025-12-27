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

export {
  BuildGateService,
  createBuildGateService,
} from './build-gate';
export type {
  BuildError,
  BuildGateResult,
  BuildGateConfig,
  BuildGateCheckOptions,
  ProjectType,
} from './build-gate';

export { ProjectDetector } from './project-detector';
export type { ProjectConfig } from './project-detector';

export {
  VerificationGateService,
  createVerificationGateService,
} from './verification-gate';
export type {
  VerificationLayerResult,
  VerificationError,
  VerificationOptions,
  VerificationResult,
  VerificationGateConfig,
} from './verification-gate';

export { DevServerManager, createDevServerManager } from './dev-server-manager';
export type { DevServerConfig, DevServerHandle } from './dev-server-manager';

export { SmokeGateService, createSmokeGateService } from './smoke-gate';
export type { SmokeTestConfig, SmokeTestResult } from './smoke-gate';

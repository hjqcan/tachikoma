/**
 * Skill Learning Module
 *
 * 提供技能学习能力，包括轨迹反思和技能生成
 *
 * @module skills/learning
 */

// ============================================================================
// Reflection 导出
// ============================================================================

export {
  TrajectoryReflector,
  createTrajectoryReflector,
  thinkingRecordToTrajectory,
  actionRecordToTrajectory,
} from './reflection';

export type {
  TrajectoryRecord,
  ExecutionFeedback,
  IdentifiedPattern,
  FailureMode,
  ReflectionResult,
  ReflectionConfig,
} from './reflection';

// ============================================================================
// Creation 导出
// ============================================================================

export {
  SkillCreator,
  createSkillCreator,
} from './creation';

export type {
  SkillCreationConfig,
  SkillCreationInput,
  SkillCreationResult,
} from './creation';

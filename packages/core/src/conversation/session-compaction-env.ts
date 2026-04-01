import type {
  SessionCompactionConfig,
  TodoFsmConfig,
  FusionFeatureFlagsConfig,
} from '../orchestrator/types';

type EnvMap = Record<string, string | undefined>;

type FusionFeatureFlagsOverrides = {
  toolRuntimeV2?: Partial<FusionFeatureFlagsConfig['toolRuntimeV2']>;
  toolProfile?: Partial<FusionFeatureFlagsConfig['toolProfile']>;
  syntheticToolResult?: Partial<FusionFeatureFlagsConfig['syntheticToolResult']>;
  midExecutionSmoke?: Partial<FusionFeatureFlagsConfig['midExecutionSmoke']>;
  resume?: {
    replayGuard?: Partial<FusionFeatureFlagsConfig['resume']['replayGuard']>;
  };
};

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function parseToolProfileEnv(value: string | undefined): 'pi-core' | 'full' | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pi-core' || normalized === 'full') {
    return normalized;
  }
  return undefined;
}

/**
 * 从环境变量解析 sessionCompaction 覆写。
 *
 * 说明：
 * - 仅采纳可解析且满足最小约束的值（避免把非法 env 直接传入配置校验导致启动失败）
 * - 无有效覆盖时返回 undefined
 */
export function resolveSessionCompactionConfigFromEnv(
  env: EnvMap = process.env
): Partial<SessionCompactionConfig> | undefined {
  const overrides: Partial<SessionCompactionConfig> = {};

  const enabled = parseBooleanEnv(env.TACHIKOMA_SESSION_COMPACTION_ENABLED);
  if (enabled !== undefined) overrides.enabled = enabled;

  const todoGuardEnabled = parseBooleanEnv(env.TACHIKOMA_COMPACTION_TODO_GUARD_ENABLED);
  if (todoGuardEnabled !== undefined) overrides.todoGuardEnabled = todoGuardEnabled;

  const maxConstraintChars = parseIntegerEnv(env.TACHIKOMA_COMPACTION_MAX_CONSTRAINT_CHARS);
  if (maxConstraintChars !== undefined && maxConstraintChars >= 0) {
    overrides.maxConstraintChars = maxConstraintChars;
  }

  const keepLastConstraints = parseIntegerEnv(env.TACHIKOMA_COMPACTION_KEEP_LAST_CONSTRAINTS);
  if (keepLastConstraints !== undefined && keepLastConstraints >= 1) {
    overrides.keepLastConstraints = keepLastConstraints;
  }

  const maxSummaryItems = parseIntegerEnv(env.TACHIKOMA_COMPACTION_MAX_SUMMARY_ITEMS);
  if (maxSummaryItems !== undefined && maxSummaryItems >= 1) {
    overrides.maxSummaryItems = maxSummaryItems;
  }

  const maxSummaryChars = parseIntegerEnv(env.TACHIKOMA_COMPACTION_MAX_SUMMARY_CHARS);
  if (maxSummaryChars !== undefined && maxSummaryChars >= 200) {
    overrides.maxSummaryChars = maxSummaryChars;
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * 从环境变量解析 todo FSM 覆写。
 *
 * 变量：
 * - TACHIKOMA_TODO_FSM_STRICT_MODE=true|false
 */
export function resolveTodoFsmConfigFromEnv(
  env: EnvMap = process.env
): Partial<TodoFsmConfig> | undefined {
  const strictMode = parseBooleanEnv(env.TACHIKOMA_TODO_FSM_STRICT_MODE);
  if (strictMode === undefined) return undefined;
  return { strictMode };
}

/**
 * 从环境变量解析融合特性开关覆写。
 *
 * 变量：
 * - TACHIKOMA_TOOL_RUNTIME_V2_ENABLED=true|false
 * - TACHIKOMA_TOOL_RUNTIME_V2_SHADOW_MODE=true|false
 * - TACHIKOMA_TOOL_PROFILE_DEFAULT=pi-core|full
 * - TACHIKOMA_SYNTHETIC_TOOL_RESULT_ENABLED=true|false
 * - TACHIKOMA_MID_EXECUTION_SMOKE_ENABLED=true|false
 * - TACHIKOMA_RESUME_REPLAY_GUARD_ENABLED=true|false
 */
export function resolveFusionFeatureFlagsFromEnv(
  env: EnvMap = process.env
): FusionFeatureFlagsOverrides | undefined {
  const toolRuntimeEnabled = parseBooleanEnv(env.TACHIKOMA_TOOL_RUNTIME_V2_ENABLED);
  const toolRuntimeShadowMode = parseBooleanEnv(env.TACHIKOMA_TOOL_RUNTIME_V2_SHADOW_MODE);
  const toolProfileDefault = parseToolProfileEnv(
    env.TACHIKOMA_TOOL_PROFILE_DEFAULT ?? env.TACHIKOMA_TOOL_PROFILE
  );
  const syntheticToolResultEnabled = parseBooleanEnv(
    env.TACHIKOMA_SYNTHETIC_TOOL_RESULT_ENABLED
  );
  const midExecutionSmokeEnabled = parseBooleanEnv(
    env.TACHIKOMA_MID_EXECUTION_SMOKE_ENABLED
  );
  const resumeReplayGuardEnabled = parseBooleanEnv(
    env.TACHIKOMA_RESUME_REPLAY_GUARD_ENABLED
  );

  const overrides: FusionFeatureFlagsOverrides = {};
  if (toolRuntimeEnabled !== undefined || toolRuntimeShadowMode !== undefined) {
    overrides.toolRuntimeV2 = {
      ...(toolRuntimeEnabled !== undefined ? { enabled: toolRuntimeEnabled } : {}),
      ...(toolRuntimeShadowMode !== undefined
        ? { shadowMode: toolRuntimeShadowMode }
        : {}),
    };
  }
  if (toolProfileDefault !== undefined) {
    overrides.toolProfile = { default: toolProfileDefault };
  }
  if (syntheticToolResultEnabled !== undefined) {
    overrides.syntheticToolResult = { enabled: syntheticToolResultEnabled };
  }
  if (midExecutionSmokeEnabled !== undefined) {
    overrides.midExecutionSmoke = { enabled: midExecutionSmokeEnabled };
  }
  if (resumeReplayGuardEnabled !== undefined) {
    overrides.resume = { replayGuard: { enabled: resumeReplayGuardEnabled } };
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

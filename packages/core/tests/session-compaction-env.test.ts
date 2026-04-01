import { describe, expect, test } from 'bun:test';
import {
  resolveFusionFeatureFlagsFromEnv,
  resolveSessionCompactionConfigFromEnv,
  resolveTodoFsmConfigFromEnv,
} from '../src/conversation/session-compaction-env';

describe('resolveSessionCompactionConfigFromEnv', () => {
  test('无覆盖时返回 undefined', () => {
    const result = resolveSessionCompactionConfigFromEnv({});
    expect(result).toBeUndefined();
  });

  test('应解析布尔与数值覆盖', () => {
    const result = resolveSessionCompactionConfigFromEnv({
      TACHIKOMA_SESSION_COMPACTION_ENABLED: 'false',
      TACHIKOMA_COMPACTION_TODO_GUARD_ENABLED: '1',
      TACHIKOMA_COMPACTION_MAX_CONSTRAINT_CHARS: '2048',
      TACHIKOMA_COMPACTION_KEEP_LAST_CONSTRAINTS: '8',
      TACHIKOMA_COMPACTION_MAX_SUMMARY_ITEMS: '12',
      TACHIKOMA_COMPACTION_MAX_SUMMARY_CHARS: '2400',
    });

    expect(result).toEqual({
      enabled: false,
      todoGuardEnabled: true,
      maxConstraintChars: 2048,
      keepLastConstraints: 8,
      maxSummaryItems: 12,
      maxSummaryChars: 2400,
    });
  });

  test('应忽略非法或越界值，只保留有效覆盖', () => {
    const result = resolveSessionCompactionConfigFromEnv({
      TACHIKOMA_SESSION_COMPACTION_ENABLED: 'maybe',
      TACHIKOMA_COMPACTION_TODO_GUARD_ENABLED: 'off',
      TACHIKOMA_COMPACTION_MAX_CONSTRAINT_CHARS: '-1',
      TACHIKOMA_COMPACTION_KEEP_LAST_CONSTRAINTS: '0',
      TACHIKOMA_COMPACTION_MAX_SUMMARY_ITEMS: 'NaN',
      TACHIKOMA_COMPACTION_MAX_SUMMARY_CHARS: '199',
    });

    expect(result).toEqual({
      todoGuardEnabled: false,
    });
  });
});

describe('resolveTodoFsmConfigFromEnv', () => {
  test('无覆盖时返回 undefined', () => {
    const result = resolveTodoFsmConfigFromEnv({});
    expect(result).toBeUndefined();
  });

  test('应解析 strictMode=true/false', () => {
    const strict = resolveTodoFsmConfigFromEnv({
      TACHIKOMA_TODO_FSM_STRICT_MODE: 'true',
    });
    const warn = resolveTodoFsmConfigFromEnv({
      TACHIKOMA_TODO_FSM_STRICT_MODE: '0',
    });

    expect(strict).toEqual({ strictMode: true });
    expect(warn).toEqual({ strictMode: false });
  });

  test('非法布尔值应忽略', () => {
    const result = resolveTodoFsmConfigFromEnv({
      TACHIKOMA_TODO_FSM_STRICT_MODE: 'maybe',
    });
    expect(result).toBeUndefined();
  });
});

describe('resolveFusionFeatureFlagsFromEnv', () => {
  test('无覆盖时返回 undefined', () => {
    const result = resolveFusionFeatureFlagsFromEnv({});
    expect(result).toBeUndefined();
  });

  test('应解析完整融合开关覆写', () => {
    const result = resolveFusionFeatureFlagsFromEnv({
      TACHIKOMA_TOOL_RUNTIME_V2_ENABLED: 'false',
      TACHIKOMA_TOOL_RUNTIME_V2_SHADOW_MODE: '1',
      TACHIKOMA_TOOL_PROFILE_DEFAULT: 'pi-core',
      TACHIKOMA_SYNTHETIC_TOOL_RESULT_ENABLED: 'off',
      TACHIKOMA_MID_EXECUTION_SMOKE_ENABLED: '0',
      TACHIKOMA_RESUME_REPLAY_GUARD_ENABLED: 'false',
    });

    expect(result).toEqual({
      toolRuntimeV2: {
        enabled: false,
        shadowMode: true,
      },
      toolProfile: {
        default: 'pi-core',
      },
      syntheticToolResult: {
        enabled: false,
      },
      midExecutionSmoke: {
        enabled: false,
      },
      resume: {
        replayGuard: {
          enabled: false,
        },
      },
    });
  });

  test('应忽略非法值并回退', () => {
    const result = resolveFusionFeatureFlagsFromEnv({
      TACHIKOMA_TOOL_RUNTIME_V2_ENABLED: 'maybe',
      TACHIKOMA_TOOL_PROFILE_DEFAULT: 'minimal',
      TACHIKOMA_SYNTHETIC_TOOL_RESULT_ENABLED: 'true',
    });

    expect(result).toEqual({
      syntheticToolResult: {
        enabled: true,
      },
    });
  });
});

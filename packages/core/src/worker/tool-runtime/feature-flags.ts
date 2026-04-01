export interface ToolRuntimeFeatureFlags {
  toolRuntimeV2Enabled: boolean;
  toolRuntimeV2ShadowMode: boolean;
  syntheticToolResultEnabled: boolean;
}

type EnvMap = Record<string, string | undefined> | undefined;

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

export function resolveToolRuntimeFeatureFlags(
  env?: EnvMap
): ToolRuntimeFeatureFlags {
  const runtimeEnabled = parseBoolean(env?.TACHIKOMA_TOOL_RUNTIME_V2_ENABLED);
  const shadowMode = parseBoolean(env?.TACHIKOMA_TOOL_RUNTIME_V2_SHADOW_MODE);
  const syntheticEnabled = parseBoolean(env?.TACHIKOMA_SYNTHETIC_TOOL_RESULT_ENABLED);

  return {
    toolRuntimeV2Enabled: runtimeEnabled ?? true,
    toolRuntimeV2ShadowMode: shadowMode ?? false,
    syntheticToolResultEnabled: syntheticEnabled ?? true,
  };
}

import type { Tool } from '../../types';
import { createResolvedToolsetSnapshot } from './resolved-toolset';
import type { ResolvedToolset, ToolProfile } from './types';

export const PI_CORE_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  read: 'file_read',
  write: 'file_write',
  edit: 'apply_patch',
  bash: 'shell_run',
});

export interface ToolPreflightInput {
  tools: Tool[];
  constraints?: string[];
  profile?: ToolProfile;
  aliasMap?: Record<string, string>;
}

export interface ToolPreflightResult {
  profile: ToolProfile;
  nativeTools: Tool[];
  resolvedToolset: ResolvedToolset;
  availableToolNames: string[];
  availableSkillToolNames: string[];
  aliasMap: Record<string, string>;
  sanitizedConstraints: string[];
  removedToolHints: string[];
  mismatchCount: number;
  notes: string[];
}

function normalizeProfile(value: string | undefined): ToolProfile {
  if (value === 'pi-core' || value === 'full') {
    return value;
  }
  return 'full';
}

export function resolveToolProfile(
  explicitProfile?: ToolProfile | string,
  env?: Record<string, string>
): ToolProfile {
  const fromEnv =
    env?.TACHIKOMA_TOOL_PROFILE ??
    env?.TACHIKOMA_TOOL_PROFILE_DEFAULT ??
    env?.TOOL_PROFILE;
  return normalizeProfile(typeof explicitProfile === 'string' ? explicitProfile : fromEnv);
}

function resolveAliasTarget(alias: string, aliasMap: Record<string, string>): string {
  return aliasMap[alias] ?? aliasMap[alias.toLowerCase()] ?? alias;
}

function parseRecommendedToolHint(
  line: string
): { label: string; separator: string; tools: string[] } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const withoutBullet = trimmed.replace(/^[-*]\s+/, '');
  const match = withoutBullet.match(
    /^(推荐工具|recommended tools?|recommended tool)\s*([:：])\s*(.+)$/i
  );
  if (!match || !match[3]) return null;
  const label = match[1];
  const separator = match[2];
  if (!label || !separator) return null;
  const tools = match[3]
    .split(/[,\s、，/]+/)
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  if (tools.length === 0) return null;
  return { label, separator, tools };
}

function filterToolsByProfile(
  tools: Tool[],
  requestedProfile: ToolProfile,
  aliasMap: Record<string, string>
): { nativeTools: Tool[]; profile: ToolProfile; notes: string[] } {
  if (requestedProfile !== 'pi-core') {
    return { nativeTools: tools, profile: requestedProfile, notes: [] };
  }

  const notes: string[] = [];
  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    byName.set(tool.name, tool);
  }

  const coreTargets = Array.from(new Set(Object.values(aliasMap)));
  const nativeTools = coreTargets
    .map((name) => byName.get(name))
    .filter((tool): tool is Tool => Boolean(tool));

  if (nativeTools.length === 0) {
    notes.push('Requested pi-core profile but no canonical tools were available; fell back to full profile.');
    return {
      nativeTools: tools,
      profile: 'full',
      notes,
    };
  }

  const missingCoreTargets = coreTargets.filter((name) => !byName.has(name));
  if (missingCoreTargets.length > 0) {
    notes.push(
      `pi-core profile missing canonical tools: ${missingCoreTargets.join(', ')}. Continuing with available subset.`
    );
  }

  return {
    nativeTools,
    profile: 'pi-core',
    notes,
  };
}

function buildAvailableSkillToolNames(
  nativeTools: Tool[],
  aliasMap: Record<string, string>
): string[] {
  const available = new Set<string>(nativeTools.map((tool) => tool.name));
  for (const [alias, target] of Object.entries(aliasMap)) {
    if (available.has(target)) {
      available.add(alias);
    }
  }
  return Array.from(available);
}

function sanitizeConstraints(
  constraints: string[],
  availableToolNames: Set<string>,
  aliasMap: Record<string, string>
): { sanitizedConstraints: string[]; removedToolHints: string[]; mismatchCount: number } {
  if (!Array.isArray(constraints) || constraints.length === 0) {
    return { sanitizedConstraints: [], removedToolHints: [], mismatchCount: 0 };
  }

  const removedToolHints: string[] = [];
  const sanitized: string[] = [];

  for (const constraint of constraints) {
    if (typeof constraint !== 'string' || constraint.trim().length === 0) {
      continue;
    }

    const lines = constraint.split('\n');
    const keptLines: string[] = [];

    for (const line of lines) {
      const parsed = parseRecommendedToolHint(line);
      if (!parsed) {
        keptLines.push(line);
        continue;
      }

      const availableHints: string[] = [];
      const missingHints: string[] = [];

      for (const originalHint of parsed.tools) {
        const mapped = resolveAliasTarget(originalHint, aliasMap);
        if (availableToolNames.has(mapped)) {
          availableHints.push(mapped);
        } else if (availableToolNames.has(originalHint)) {
          availableHints.push(originalHint);
        } else {
          missingHints.push(originalHint);
        }
      }

      const dedupAvailable = Array.from(new Set(availableHints));
      const dedupMissing = Array.from(new Set(missingHints));

      if (dedupAvailable.length === 0) {
        removedToolHints.push(...dedupMissing);
        continue;
      }

      let rewritten = `${parsed.label}${parsed.separator} ${dedupAvailable.join(', ')}`;
      if (dedupMissing.length > 0) {
        removedToolHints.push(...dedupMissing);
        rewritten += ` (unavailable: ${dedupMissing.join(', ')})`;
      }
      keptLines.push(rewritten);
    }

    if (keptLines.length > 0) {
      sanitized.push(keptLines.join('\n'));
    }
  }

  const uniqueRemoved = Array.from(new Set(removedToolHints));
  if (uniqueRemoved.length > 0) {
    sanitized.push(
      `Note: recommended tools unavailable and removed: ${uniqueRemoved.join(', ')}. Use only the tools listed in "Available tools".`
    );
  }

  return {
    sanitizedConstraints: sanitized,
    removedToolHints,
    mismatchCount: uniqueRemoved.length,
  };
}

function buildAliasNote(
  aliasMap: Record<string, string>,
  availableToolNames: Set<string>
): string | null {
  const activeAliases: string[] = [];
  for (const [alias, target] of Object.entries(aliasMap)) {
    if (availableToolNames.has(target)) {
      activeAliases.push(`${alias}->${target}`);
    }
  }
  if (activeAliases.length === 0) return null;
  return `Tool aliases (reference only): ${activeAliases.join(', ')}. Always call the actual tool names on the right side.`;
}

export function runToolPreflight(input: ToolPreflightInput): ToolPreflightResult {
  const aliasMap = {
    ...PI_CORE_TOOL_ALIASES,
    ...(input.aliasMap ?? {}),
  };
  const requestedProfile = input.profile ?? 'full';
  const constraints = Array.isArray(input.constraints) ? input.constraints : [];

  const profileSelection = filterToolsByProfile(input.tools, requestedProfile, aliasMap);
  const nativeTools = profileSelection.nativeTools;
  const availableToolNames = nativeTools.map((tool) => tool.name);
  const availableSet = new Set<string>(availableToolNames);

  const sanitized = sanitizeConstraints(constraints, availableSet, aliasMap);
  const aliasNote = buildAliasNote(aliasMap, availableSet);
  const sanitizedConstraints = [...sanitized.sanitizedConstraints];
  if (aliasNote) {
    sanitizedConstraints.push(aliasNote);
  }

  const availableSkillToolNames = buildAvailableSkillToolNames(nativeTools, aliasMap);
  const resolvedToolset = createResolvedToolsetSnapshot(nativeTools, {
    profile: profileSelection.profile,
    capabilities: Object.fromEntries(
      availableSkillToolNames.map((name) => [name, true] as const)
    ),
  });

  return {
    profile: profileSelection.profile,
    nativeTools,
    resolvedToolset,
    availableToolNames,
    availableSkillToolNames,
    aliasMap,
    sanitizedConstraints,
    removedToolHints: sanitized.removedToolHints,
    mismatchCount: sanitized.mismatchCount,
    notes: profileSelection.notes,
  };
}

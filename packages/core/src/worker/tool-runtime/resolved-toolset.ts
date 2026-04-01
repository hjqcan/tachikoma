import { createHash } from 'node:crypto';
import type { Tool } from '../../types';
import type {
  ResolvedToolset,
  SemanticSkillDescriptor,
  ToolProfile,
} from './types';

export interface ResolvedToolsetSnapshotOptions {
  profile?: ToolProfile;
  semanticSkills?: SemanticSkillDescriptor[];
  capabilities?: Record<string, boolean>;
}

function buildCapabilities(
  tools: Tool[],
  overrides?: Record<string, boolean>
): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {};
  for (const tool of tools) {
    capabilities[tool.name] = true;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      capabilities[key] = value;
    }
  }
  return capabilities;
}

function buildHash(
  toolNames: string[],
  skillNames: string[],
  profile: ToolProfile
): string {
  const hashInput = JSON.stringify({
    profile,
    tools: [...toolNames].sort(),
    skills: [...skillNames].sort(),
  });
  return createHash('sha1').update(hashInput).digest('hex').slice(0, 16);
}

export function createResolvedToolsetSnapshot(
  nativeTools: Tool[],
  options: ResolvedToolsetSnapshotOptions = {}
): ResolvedToolset {
  const profile = options.profile ?? 'full';
  const semanticSkills = options.semanticSkills ?? [];
  const capabilities = buildCapabilities(nativeTools, options.capabilities);
  const toolNames = nativeTools.map((tool) => tool.name);
  const skillNames = semanticSkills.map((skill) => skill.name);
  const hash = buildHash(toolNames, skillNames, profile);

  return {
    nativeTools,
    semanticSkills,
    profile,
    capabilities,
    hash,
  };
}

import type { Tool } from '../types';

export const BASH_TOOL_NAME = 'Bash';
export const FILE_READ_TOOL_NAME = 'Read';
export const FILE_WRITE_TOOL_NAME = 'Write';
export const FILE_EDIT_TOOL_NAME = 'Edit';
export const GREP_TOOL_NAME = 'Grep';
export const GLOB_TOOL_NAME = 'Glob';
export const TODO_WRITE_TOOL_NAME = 'TodoWrite';
export const TODO_READ_TOOL_NAME = 'TodoRead';
export const AGENT_TOOL_NAME = 'Agent';

const MODEL_FACING_TOOL_NAME_BY_INTERNAL = Object.freeze({
  shell_run: BASH_TOOL_NAME,
  file_read: FILE_READ_TOOL_NAME,
  file_write: FILE_WRITE_TOOL_NAME,
  apply_patch: FILE_EDIT_TOOL_NAME,
  code_search: GREP_TOOL_NAME,
  file_list: GLOB_TOOL_NAME,
  todowrite: TODO_WRITE_TOOL_NAME,
  todoread: TODO_READ_TOOL_NAME,
  spawn_subagent: AGENT_TOOL_NAME,
} as const);

type InternalToolName = keyof typeof MODEL_FACING_TOOL_NAME_BY_INTERNAL;

function normalizeName(input: string): string {
  return input.trim().toLowerCase();
}

const INTERNAL_BY_MODEL_FACING = new Map<string, string>();
for (const [internalName, modelName] of Object.entries(MODEL_FACING_TOOL_NAME_BY_INTERNAL)) {
  INTERNAL_BY_MODEL_FACING.set(normalizeName(modelName), internalName);
  INTERNAL_BY_MODEL_FACING.set(normalizeName(internalName), internalName);
}

export function getModelFacingToolName(nameOrTool: string | Pick<Tool, 'name'>): string {
  const internalName = typeof nameOrTool === 'string' ? nameOrTool : nameOrTool.name;
  return MODEL_FACING_TOOL_NAME_BY_INTERNAL[
    internalName as InternalToolName
  ] ?? internalName;
}

export function resolveInternalToolName(name: string): string {
  return INTERNAL_BY_MODEL_FACING.get(normalizeName(name)) ?? name;
}

export function getDefaultModelFacingAliases(nameOrTool: string | Pick<Tool, 'name'>): string[] {
  const internalName = typeof nameOrTool === 'string' ? nameOrTool : nameOrTool.name;
  const modelFacingName = getModelFacingToolName(internalName);

  if (modelFacingName === internalName) {
    return [];
  }

  const aliases = new Set<string>([
    modelFacingName,
    normalizeName(modelFacingName),
  ]);

  aliases.delete(internalName);
  aliases.delete(normalizeName(internalName));

  return Array.from(aliases);
}

export function getAllToolLookupNames(tool: Pick<Tool, 'name' | 'aliases'>): string[] {
  const names = new Set<string>([
    tool.name,
    normalizeName(tool.name),
    getModelFacingToolName(tool),
    normalizeName(getModelFacingToolName(tool)),
    ...(tool.aliases ?? []),
  ]);
  return Array.from(names);
}

export const MODEL_FACING_TOOL_NAMES = Object.freeze({
  Bash: BASH_TOOL_NAME,
  Read: FILE_READ_TOOL_NAME,
  Write: FILE_WRITE_TOOL_NAME,
  Edit: FILE_EDIT_TOOL_NAME,
  Grep: GREP_TOOL_NAME,
  Glob: GLOB_TOOL_NAME,
  TodoWrite: TODO_WRITE_TOOL_NAME,
  TodoRead: TODO_READ_TOOL_NAME,
  Agent: AGENT_TOOL_NAME,
});

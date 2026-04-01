import type { Tool } from '../../types';

export type ToolProfile = 'pi-core' | 'full';

export interface SemanticSkillDescriptor {
  name: string;
  description?: string;
  requiresTools?: string[];
}

export interface ResolvedToolset {
  nativeTools: Tool[];
  semanticSkills: SemanticSkillDescriptor[];
  profile: ToolProfile;
  capabilities: Record<string, boolean>;
  hash: string;
}

export interface ToolCallContext {
  taskId: string;
  callId: string;
  toolName: string;
  input: unknown;
  toolset: ResolvedToolset;
  metadata: Record<string, unknown>;
}

export interface ToolResultContext {
  call: ToolCallContext;
  success: boolean;
  isError: boolean;
  output: unknown;
  durationMs: number;
}

export interface ToolErrorContext {
  call: ToolCallContext;
  error: unknown;
  errorCode?: string;
}

export interface ToolMiddleware {
  beforeToolCall?(ctx: ToolCallContext): Promise<ToolCallContext> | ToolCallContext;
  afterToolResult?(ctx: ToolResultContext): Promise<ToolResultContext> | ToolResultContext;
  onToolError?(ctx: ToolErrorContext): Promise<ToolResultContext | null> | ToolResultContext | null;
}

export type ToolRuntimeEventType =
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'tool_call_failed'
  | 'tool_call_recovered';

export interface ToolRuntimeEvent {
  type: ToolRuntimeEventType;
  timestamp: number;
  call: ToolCallContext;
  result?: ToolResultContext;
  errorMessage?: string;
  errorCode?: string;
}

export interface ToolRuntimeExecutorResult {
  success: boolean;
  output: unknown;
  isError?: boolean;
}

export interface ToolRuntimeExecuteParams {
  taskId: string;
  toolName: string;
  input: unknown;
  execute: (ctx: ToolCallContext) => Promise<ToolRuntimeExecutorResult>;
  callId?: string;
  toolset?: ResolvedToolset;
  metadata?: Record<string, unknown>;
  errorCode?: string;
  recoverUnhandledErrors?: boolean;
}

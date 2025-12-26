/**
 * LSP tools (inspired by opencode)
 *
 * Provides workspace-aware language intelligence via local language servers.
 */

import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Tool, ExecutionContext } from '../../types';
import type {
  ToolResult,
  LspToolInput,
  LspToolOutput,
  LspDiagnosticsInput,
  LspDiagnosticsOutput,
} from '../types';
import { ToolCategory, ToolLayer, ToolPermission } from '../types';
import { ensureWorkDir, validatePath } from './utils';
import { LSP } from '../../lsp';

const LSP_OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const;

const POSITION_REQUIRED = new Set([
  'goToDefinition',
  'findReferences',
  'hover',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
]);

function isValidOperation(value: string): value is (typeof LSP_OPERATIONS)[number] {
  return (LSP_OPERATIONS as readonly string[]).includes(value);
}

async function resolveFilePath(inputPath: string, context: ExecutionContext): Promise<string> {
  return validatePath(inputPath, context.workDir);
}

export const lspTool: Tool = {
  name: 'lsp',
  title: 'LSP',
  description: `Perform LSP lookups using local language servers.
- Supports goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation
- Lines/characters are 1-based (as shown in editors)`,
  category: ToolCategory.DataProcessing,
  layer: ToolLayer.Atomic,
  permissions: [ToolPermission.FileSystemRead, ToolPermission.ProcessSpawn],
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [...LSP_OPERATIONS],
        description: 'LSP operation to execute',
      },
      filePath: {
        type: 'string',
        description: 'Absolute or relative path to the file',
      },
      line: {
        type: 'number',
        description: 'Line number (1-based)',
      },
      character: {
        type: 'number',
        description: 'Character offset (1-based)',
      },
      query: {
        type: 'string',
        description: 'Query for workspaceSymbol (optional)',
      },
    },
    required: ['operation', 'filePath'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          operation: { type: 'string' },
          file: { type: 'string' },
          count: { type: 'number' },
          result: {},
        },
      },
    },
  },
  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<LspToolOutput>> {
    const payload = input as Partial<LspToolInput>;
    const operation = typeof payload.operation === 'string' ? payload.operation : '';
    const filePath =
      typeof payload.filePath === 'string'
        ? payload.filePath
        : typeof (payload as Record<string, unknown>).path === 'string'
          ? ((payload as Record<string, unknown>).path as string)
          : typeof (payload as Record<string, unknown>).file === 'string'
            ? ((payload as Record<string, unknown>).file as string)
            : '';

    if (!operation || !isValidOperation(operation)) {
      return { success: false, error: `Invalid operation: ${String(operation)}` };
    }
    if (!filePath) {
      return { success: false, error: 'filePath is required' };
    }

    const workDirCheck = await ensureWorkDir(context.workDir);
    if (!workDirCheck.valid) {
      return { success: false, error: workDirCheck.error ?? 'Invalid workDir' };
    }

    let absolutePath: string;
    try {
      absolutePath = await resolveFilePath(filePath, context);
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || 'Invalid file path' };
    }

    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        return { success: false, error: `Not a file: ${filePath}` };
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return { success: false, error: `File not found: ${filePath}` };
      }
      return { success: false, error: err.message || 'Failed to stat file' };
    }

    const available = await LSP.hasClients(absolutePath, context.workDir, context.env);
    if (!available) {
      return {
        success: false,
        error:
          'No LSP server available for this file type. Ensure a language server is installed and on PATH.',
      };
    }

    const line = typeof payload.line === 'number' ? payload.line : undefined;
    const character = typeof payload.character === 'number' ? payload.character : undefined;

    if (POSITION_REQUIRED.has(operation)) {
      if (!line || !character || line < 1 || character < 1) {
        return { success: false, error: 'line and character (1-based) are required for this operation' };
      }
    }

    try {
      await LSP.touchFile(absolutePath, context.workDir, context.env, true);
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || 'Failed to open file for LSP' };
    }

    const position = {
      file: absolutePath,
      line: (line ?? 1) - 1,
      character: (character ?? 1) - 1,
    };

    let result: unknown = null;
    switch (operation) {
      case 'goToDefinition':
        result = await LSP.definition(position, context.workDir, context.env);
        break;
      case 'findReferences':
        result = await LSP.references(position, context.workDir, context.env);
        break;
      case 'hover':
        result = await LSP.hover(position, context.workDir, context.env);
        break;
      case 'documentSymbol':
        result = await LSP.documentSymbol(pathToFileURL(absolutePath).href, context.workDir, context.env);
        break;
      case 'workspaceSymbol':
        result = await LSP.workspaceSymbol(payload.query ?? '', context.workDir, context.env);
        break;
      case 'goToImplementation':
        result = await LSP.implementation(position, context.workDir, context.env);
        break;
      case 'prepareCallHierarchy':
        result = await LSP.prepareCallHierarchy(position, context.workDir, context.env);
        break;
      case 'incomingCalls':
        result = await LSP.incomingCalls(position, context.workDir, context.env);
        break;
      case 'outgoingCalls':
        result = await LSP.outgoingCalls(position, context.workDir, context.env);
        break;
      default:
        result = null;
    }

    const count = Array.isArray(result) ? result.length : result ? 1 : 0;

    return {
      success: true,
      data: {
        operation,
        file: filePath,
        count,
        result,
      },
    };
  },
};

export const lspDiagnosticsTool: Tool = {
  name: 'lsp_diagnostics',
  title: 'LSP Diagnostics',
  description: 'Fetch diagnostics (errors/warnings) from local language servers for a file.',
  category: ToolCategory.DataProcessing,
  layer: ToolLayer.Atomic,
  permissions: [ToolPermission.FileSystemRead, ToolPermission.ProcessSpawn],
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file',
      },
    },
    required: ['path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          count: { type: 'number' },
          diagnostics: { type: 'array' },
          pretty: { type: 'array' },
        },
      },
    },
  },
  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<LspDiagnosticsOutput>> {
    const payload = input as LspDiagnosticsInput;
    if (!payload?.path) {
      return { success: false, error: 'path is required' };
    }

    const workDirCheck = await ensureWorkDir(context.workDir);
    if (!workDirCheck.valid) {
      return { success: false, error: workDirCheck.error ?? 'Invalid workDir' };
    }

    let absolutePath: string;
    try {
      absolutePath = await resolveFilePath(payload.path, context);
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || 'Invalid file path' };
    }

    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        return { success: false, error: `Not a file: ${payload.path}` };
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return { success: false, error: `File not found: ${payload.path}` };
      }
      return { success: false, error: err.message || 'Failed to stat file' };
    }

    const available = await LSP.hasClients(absolutePath, context.workDir, context.env);
    if (!available) {
      return {
        success: false,
        error:
          'No LSP server available for this file type. Ensure a language server is installed and on PATH.',
      };
    }

    try {
      await LSP.touchFile(absolutePath, context.workDir, context.env, true);
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || 'Failed to open file for LSP' };
    }
    const diagnostics = await LSP.diagnostics(context.workDir, context.env);
    const fileDiagnostics = diagnostics[absolutePath] ?? [];

    return {
      success: true,
      data: {
        file: payload.path,
        count: fileDiagnostics.length,
        diagnostics: fileDiagnostics,
        pretty: fileDiagnostics.map(LSP.formatDiagnostic),
      },
    };
  },
};

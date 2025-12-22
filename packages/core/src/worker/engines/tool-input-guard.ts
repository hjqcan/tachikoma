export interface ToolInputSizeCheck {
  ok: boolean;
  size: number;
  limit: number;
  message?: string;
}

function serializeInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function buildTooLargeAdvice(toolName: string): string {
  switch (toolName) {
    case 'file_write':
      return 'Split content into multiple file_write calls (use append=true) or write smaller chunks.';
    case 'apply_patch':
      return 'Split the patch into smaller hunks and apply them in multiple calls.';
    case 'replace_between_markers':
      return 'Narrow the replacement scope or split into multiple smaller replacements.';
    case 'shell_run':
      return 'Write a script to a file and execute smaller commands in separate calls.';
    default:
      return 'Split the request into multiple smaller tool calls.';
  }
}

export function checkToolInputSize(
  toolName: string,
  input: unknown,
  limit: number
): ToolInputSizeCheck {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: true, size: 0, limit };
  }
  const serialized = serializeInput(input);
  const size = Buffer.byteLength(serialized, 'utf8');

  if (size <= limit) {
    return { ok: true, size, limit };
  }

  const advice = buildTooLargeAdvice(toolName);
  const message = `Tool input too large for "${toolName}" (${size} bytes > ${limit}). ${advice}`;
  return { ok: false, size, limit, message };
}

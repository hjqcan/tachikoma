import type { Tool } from '../../types';
import type { WorkerTask } from '../types';

type ToolDescriptionMode = 'names-only' | 'full-schema';

export function formatToolDescriptions(
  tools: Tool[],
  options?: {
    mode?: ToolDescriptionMode;
    maxDescriptionLength?: number;
  }
): string {
  if (!tools || tools.length === 0) {
    return 'No tools available.';
  }

  const mode = options?.mode ?? 'full-schema';
  const maxDescriptionLength = options?.maxDescriptionLength ?? 240;

  return tools
    .map((tool) => {
      const description = tool.description?.trim() ?? '';
      const shortDesc =
        description.length > maxDescriptionLength
          ? `${description.slice(0, maxDescriptionLength)}...`
          : description;

      if (mode === 'names-only') {
        return shortDesc ? `- ${tool.name}: ${shortDesc}` : `- ${tool.name}`;
      }

      const schemaStr = JSON.stringify(tool.inputSchema, null, 2);
      return `- ${tool.name}: ${shortDesc}
  Input schema: ${schemaStr}`;
    })
    .join('\n\n');
}

export function buildTaskPrompt(
  task: WorkerTask,
  tools: Tool[],
  options?: {
    useNativeToolCalls?: boolean;
    toolDescriptionMode?: ToolDescriptionMode;
  }
): string {
  const useNativeToolCalls = options?.useNativeToolCalls ?? false;
  const toolDescriptionMode =
    options?.toolDescriptionMode ?? (useNativeToolCalls ? 'names-only' : 'full-schema');

  const constraints =
    Array.isArray(task.constraints) && task.constraints.length > 0
      ? task.constraints.map((c) => `- ${c}`).join('\n')
      : 'None';

  const hardRules = `Hard rules:
- Constraints are hard requirements; do not change language/framework/stack unless explicitly allowed.
- If constraints conflict or block progress, stop and ask for clarification.`;

  const toolFormattingGuide = `Tool call formatting (critical):
- Tool arguments must be valid JSON (double quotes, no trailing commas).
- Split large edits into multiple tool calls; keep each call small.
- Avoid unescaped backticks or code fences inside JSON strings.`;

  const toolDescriptions = formatToolDescriptions(tools, {
    mode: toolDescriptionMode,
    maxDescriptionLength: useNativeToolCalls ? 160 : 240,
  });

  const toolUsageInstructions = useNativeToolCalls
    ? 'Please accomplish this task step by step. Use the available tools when needed.'
    : `Please accomplish this task step by step. When you need to use a tool, output it in this format:
<tool_use>
<name>tool_name</name>
<input>{"param": "value"}</input>
</tool_use>`;

  return `Task: ${task.objective}

Constraints:
${constraints}

${hardRules}

${toolFormattingGuide}

Available tools:
${toolDescriptions}

${toolUsageInstructions}

When the task is complete, provide a final summary of what was accomplished.`;
}

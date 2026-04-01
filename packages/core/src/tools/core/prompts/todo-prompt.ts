/**
 * todo Tool Prompt (LLM Manual)
 *
 * Adapted from Claude Code's TodoWrite guidance.
 *
 * @module tools/core/prompts/todo-prompt
 */

import { TODO_READ_TOOL_NAME, TODO_WRITE_TOOL_NAME } from '../../model-facing-names';

export function getTodoWritePrompt(): string {
  return `Use ${TODO_WRITE_TOOL_NAME} to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - when a task requires 3 or more distinct steps or actions
2. Non-trivial tasks - work that requires careful planning or multiple operations
3. User explicitly asks for a todo list
4. User provides multiple requirements or a checklist
5. After receiving new instructions - immediately capture the updated requirements as todos
6. When you start working on a task - mark it as in_progress before beginning work
7. After completing a task - mark it completed immediately and add any newly discovered follow-up work

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task is purely conversational or informational

## Task States and Management

1. Use these states to track progress:
   - pending: task not yet started
   - in_progress: currently working on it
   - completed: task finished successfully
   - blocked: cannot continue until something is resolved
   - cancelled: no longer needed

2. Update task status in real time as you work
3. Mark tasks complete immediately after finishing them
4. Keep tasks specific and actionable
5. Never mark a task completed if implementation is partial, verification failed, or blockers remain

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and helps ensure all requirements are completed successfully.`;
}

export function getTodoReadPrompt(): string {
  return `${TODO_READ_TOOL_NAME} reads the current todo list for the active session.

Use this when you need to inspect existing tracked work before updating it, resuming after interruption, or reconciling progress with new instructions.`;
}

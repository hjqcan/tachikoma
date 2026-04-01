/**
 * spawn_subagent Tool Prompt (LLM Manual)
 *
 * Ported from Claude Code's AgentTool guidance.
 *
 * @module tools/core/prompts/spawn-subagent-prompt
 */

export function getSpawnSubagentPrompt(): string {
  return `Launch a new subagent to handle complex, multi-step tasks autonomously.

Usage notes:
- Use a subagent when the work is open-ended, multi-step, or benefits from isolated context
- Do not use a subagent for a single direct tool call you can execute yourself
- The subagent starts without your current conversation state, so the prompt must include all relevant context
- Write the prompt like a briefing for a capable engineer who just joined the task
- Explain what needs to be done, what has already been learned, and what constraints matter
- Do not delegate the same work twice
- After launching a subagent, wait for its result instead of guessing what it will find`;
}

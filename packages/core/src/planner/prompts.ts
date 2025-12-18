/**
 * Planner Prompt Templates
 *
 * Defines System Prompt and User Prompt templates for task planning
 */

import type { PromptVariables, PatchPromptVariables, ErrorFeedbackVariables } from './types';
import type { SubTask, ExecutionPlan } from '../orchestrator';

// ============================================================================
// Output Format Definition
// ============================================================================

/**
 * Planning Output Format - For LLM structured output
 */
export interface PlanningOutputFormat {
  /** Task intake assessment (optional: for clarification/role-based planning) */
  intake?: {
    /** Whether sufficient information to start execution */
    ready: boolean;
    /** Identified user intent (optional) */
    userIntent?: string;
    /** Sentiment/tone (optional) */
    sentiment?: string;
    /** Missing information points (when ready=false) */
    missingInfo?: string[];
    /** Clarification questions for user (when ready=false) */
    questions?: string[];
  };
  /** Suggested role set (optional: each role ≈ one worker) */
  roles?: {
    /** Role ID (referenced by subtasks.roleId) */
    id: string;
    /** Role name */
    name: string;
    /** Role responsibilities */
    responsibilities: string;
    /** Capability tags (for capability filtering; recommend including stable role:<id>) */
    capabilities: string[];
  }[];
  /** Brief explanation (do not output detailed step-by-step reasoning) */
  reasoning: string;
  /** Subtask list */
  subtasks: {
    /** Subtask ID (format: subtask-1, subtask-2, ...) */
    id: string;
    /** Subtask objective */
    objective: string;
    /** Subtask role (optional: select an id from roles) */
    roleId?: string;
    /** Required capabilities (optional: for WorkerPool routing) */
    requiredCapabilities?: string[];
    /** Constraints */
    constraints: string[];
    /** Estimated execution time (minutes) */
    estimatedMinutes: number;
    /** Dependencies on other subtask IDs */
    dependencies: string[];
  }[];
  /** Execution plan */
  executionPlan: {
    /** Whether parallelizable */
    isParallel: boolean;
    /** Execution steps */
    steps: {
      /** Step order */
      order: number;
      /** Subtask IDs in this step */
      subtaskIds: string[];
      /** Whether can execute in parallel */
      parallel: boolean;
    }[];
  };
  /** Estimated total execution time (minutes) */
  estimatedTotalMinutes: number;
  /** Complexity score (1-10) */
  complexityScore: number;
}

// ============================================================================
// System Prompt Templates
// ============================================================================

/**
 * Planning System Prompt
 */
export const PLANNING_SYSTEM_PROMPT = `You are a task planning expert. Your responsibility is to decompose high-level tasks into executable subtasks and create detailed execution plans.

## Your Tasks
1. Before starting execution, determine if the user has provided sufficient information to begin (ask clarification questions if necessary)
2. If information is sufficient, decide which "roles" are needed for this task (each role corresponds to one Worker)
3. Decompose the task into multiple independent, executable subtasks and assign appropriate roles to each
4. Determine dependencies between subtasks and create an execution plan (specify which can run in parallel, which must wait)
5. Estimate execution time for each subtask

## Decomposition Principles
- Each subtask should be an independent, testable unit
- Appropriate granularity: not too large (hard to execute) or too small (too trivial)
- Clearly mark dependencies between subtasks
- Identify subtasks that can execute in parallel whenever possible
- Consider failure scenarios and rollback strategies

## Large File Creation Strategy (Important)
When tasks involve creating large code files (>80 lines), use a phased approach:

**Phase 1: Create Skeleton**
- Subtask: Create basic file structure (imports, class/function signatures, empty implementations)
- Estimate: 5 minutes

**Phase 2+: Fill Incrementally**
- Each subtask only implements complete content of one function/method
- Use apply_patch tool for incremental modifications
- Avoid outputting more than 30 lines of code in a single subtask

This approach prevents execution failures caused by truncated LLM output.

## Output Requirements
You must output in JSON format with the following fields:
- intake: Task intake assessment (optional but recommended; for clarification needs)
- roles: Role list (optional; each role corresponds to one Worker)
- reasoning: Brief explanation of your decomposition rationale (1-3 sentences, no detailed step-by-step reasoning)
- subtasks: Subtask list, each containing id, objective, constraints, estimatedMinutes, dependencies
- executionPlan: Execution plan with isParallel, steps
- estimatedTotalMinutes: Estimated total execution time
- complexityScore: Complexity score (1-10)

## Clarification Rules (Very Important - Default to Proactive Execution)
**Key Principle**: You are a capable Agent that should solve problems autonomously whenever possible. The user has provided a working directory and task objective, which is usually sufficient to begin execution.

**Default Behavior**: Output intake.ready=true and start planning subtasks.

**Only output intake.ready=false in these cases**:
- Task objective is completely ambiguous, cannot determine what to do (e.g., "help me do something")
- Missing absolutely essential external information (e.g., user needs to provide API keys or access credentials)

**In these cases, proceed directly (intake.ready=true)**:
- User requests style improvement/UI beautification → Directly analyze project code and implement improvements
- User requests bug fix → Diagnose first, then fix
- User provided working directory → Can read project files to understand context
- User says "figure it out yourself" → This authorizes autonomous decision-making, not asking more questions

When clarification is truly needed:
1) Output intake.ready=false, provide 1-2 most critical questions in intake.questions
2) Output empty array for subtasks, estimatedTotalMinutes=0

When information is sufficient to proceed (this is the default):
1) Output intake.ready=true
2) Output roles: Recommend 2-5 roles (e.g., Product Manager/Architect/Frontend/Backend/QA). Each role must have a stable id.
   - capabilities should include "role:<roleId>" (e.g., role:frontend) for routing to corresponding worker
3) Each subtask must specify roleId, and include at least the corresponding "role:<roleId>" in requiredCapabilities
4) In executionPlan parallel steps, try to have subtasks in the same step belong to different roles (otherwise they effectively run serially since each role has only one worker)

## Notes
- Strictly follow JSON format, do not add extra text
- Subtask ID format: subtask-1, subtask-2, ...
- dependencies array contains dependent subtask IDs
- In execution steps, subtasks in the same step can execute in parallel`;

/**
 * Patch Planning System Prompt
 *
 * For making "incremental modifications" based on existing output, generating minimal delta plans to avoid redoing completed work.
 */
export const PATCH_PLANNING_SYSTEM_PROMPT = `You are an incremental modification (patch) task planning expert. Your responsibility is to generate minimal executable change plans based on existing work results.

## Your Tasks
1. Understand the user's "modification/adjustment" objective
2. Read the "previous plan and output context" to determine what's completed and what needs changing
3. Only generate necessary delta subtasks (avoid redoing complete implementations)
4. Reuse existing files and structures as much as possible, prefer incremental modifications (apply_patch) over rewrites
5. Output executable, testable, rollbackable steps

## Decomposition Principles (Incremental First)
- Default: do not create new architecture unless modification objective explicitly requires it
- Prefer modifying most recently affected files/modules
- Minimize number of subtasks: small changes usually need only 1-3 subtasks
- For large changes, still follow "large file phased strategy" but only cover change-related parts

## Output Requirements
You must output in JSON format with the following fields:
- intake: Task intake assessment (optional but recommended; for clarification needs)
- roles: Role list (optional; each role corresponds to one Worker)
- reasoning: Brief explanation of your decomposition rationale (1-3 sentences, no detailed step-by-step reasoning)
- subtasks: Subtask list, each containing id, objective, constraints, estimatedMinutes, dependencies
- executionPlan: Execution plan with isParallel, steps
- estimatedTotalMinutes: Estimated total execution time
- complexityScore: Complexity score (1-10)

## Notes
- Strictly follow JSON format, do not add extra text
- Subtask ID format: subtask-1, subtask-2, ...
- Only generate subtasks related to "necessary modifications"`;

/**
 * Generate Planning User Prompt
 */
export function generatePlanningUserPrompt(variables: PromptVariables): string {
  const { objective, constraints, availableTools, maxSubtasks, additionalContext } = variables;

  let prompt = `Please analyze and decompose the following task:

## Task Objective
${objective}

## Constraints
${constraints.length > 0 ? constraints.map((c, i) => `${i + 1}. ${c}`).join('\n') : 'No special constraints'}
`;

  if (availableTools && availableTools.length > 0) {
    prompt += `
## Available Tools
${availableTools.map((t) => `- ${t}`).join('\n')}
`;
  }

  if (maxSubtasks) {
    prompt += `
## Subtask Limit
Generate at most ${maxSubtasks} subtasks
`;
  }

  if (additionalContext) {
    prompt += `
## Additional Context
${additionalContext}
`;
  }

  prompt += `
## Output Format
Please output in JSON format without any other text. JSON should have the following structure:
\`\`\`json
{
  "intake": {
    "ready": true,
    "questions": []
  },
  "roles": [
    {
      "id": "frontend",
      "name": "Frontend Developer",
      "responsibilities": "Implement UI/interactions and frontend engineering",
      "capabilities": ["role:frontend", "frontend", "react"]
    }
  ],
  "reasoning": "Brief explanation of your decomposition rationale (1-3 sentences)...",
  "subtasks": [
    {
      "id": "subtask-1",
      "objective": "Subtask objective",
      "roleId": "frontend",
      "requiredCapabilities": ["role:frontend"],
      "constraints": ["constraint1", "constraint2"],
      "estimatedMinutes": 10,
      "dependencies": []
    }
  ],
  "executionPlan": {
    "isParallel": false,
    "steps": [
      {
        "order": 1,
        "subtaskIds": ["subtask-1"],
        "parallel": false
      }
    ]
  },
  "estimatedTotalMinutes": 30,
  "complexityScore": 5
}
\`\`\``;

  return prompt;
}

/**
 * Generate Patch Planning User Prompt
 */
export function generatePatchPlanningUserPrompt(variables: PatchPromptVariables): string {
  const {
    objective,
    constraints,
    availableTools,
    maxSubtasks,
    additionalContext,
    previousContext,
  } = variables;

  let prompt = `Based on existing work results, please generate a minimal change plan for the following modification request:

## Modification Objective
${objective}

## Constraints
${constraints.length > 0 ? constraints.map((c, i) => `${i + 1}. ${c}`).join('\n') : 'No special constraints'}
`;

  if (previousContext) {
    prompt += `
## Previous Plan and Output Context (for reference)
${previousContext}
`;
  }

  if (availableTools && availableTools.length > 0) {
    prompt += `
## Available Tools
${availableTools.map((t) => `- ${t}`).join('\n')}
`;
  }

  if (maxSubtasks) {
    prompt += `
## Subtask Limit
Generate at most ${maxSubtasks} subtasks (minimize as much as possible)
`;
  }

  if (additionalContext) {
    prompt += `
## Additional Context
${additionalContext}
`;
  }

  prompt += `
## Output Format
Please output in JSON format without any other text. JSON should have the following structure:
\`\`\`json
{
  "reasoning": "Brief explanation of your decomposition rationale (1-3 sentences)...",
  "subtasks": [
    {
      "id": "subtask-1",
      "objective": "Subtask objective",
      "constraints": ["constraint1", "constraint2"],
      "estimatedMinutes": 10,
      "dependencies": []
    }
  ],
  "executionPlan": {
    "isParallel": false,
    "steps": [
      {
        "order": 1,
        "subtaskIds": ["subtask-1"],
        "parallel": false
      }
    ]
  },
  "estimatedTotalMinutes": 30,
  "complexityScore": 5
}
\`\`\``;

  return prompt;
}

// ============================================================================
// Error Feedback Prompt
// ============================================================================

/**
 * Generate Parse Error Feedback Prompt
 */
export function generateErrorFeedbackPrompt(variables: ErrorFeedbackVariables): string {
  const { originalResponse, parseError, retryCount } = variables;

  return `Your previous response could not be parsed correctly. Please correct and re-output.

## Error Message
${parseError}

## Your Original Response
${originalResponse.slice(0, 1000)}${originalResponse.length > 1000 ? '...(truncated)' : ''}

## Retry Count
This is retry attempt ${retryCount}.

## Requirements
1. Ensure output is valid JSON format
2. Do not add any text or code block markers before or after the JSON
3. Ensure all required fields are present
4. Ensure correct data types (strings, arrays, numbers, etc.)

Please output the correct JSON directly:`;
}

// ============================================================================
// Output Parsing Helper Functions
// ============================================================================

/**
 * Extract JSON from LLM response
 *
 * P1 Fix: Improved JSON boundary detection to avoid extracting incomplete JSON
 *
 * Supports the following formats:
 * 1. JSON wrapped in Markdown code blocks (priority)
 * 2. Use bracket matching to find complete JSON object
 * 3. JSON with surrounding text
 */
export function extractJsonFromResponse(response: string): string {
  // 1. First try to extract JSON from Markdown code block
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    const content = codeBlockMatch[1].trim();
    // Ensure extracted content starts with {
    if (content.startsWith('{')) {
      return content;
    }
  }

  // 2. Use bracket matching to find complete JSON object boundary
  const startIdx = response.indexOf('{');
  if (startIdx === -1) {
    return response.trim();
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < response.length; i++) {
    const char = response[i];

    // Handle escape characters
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    // Handle string boundaries
    if (char === '"') {
      inString = !inString;
      continue;
    }

    // Only count brackets outside of strings
    if (!inString) {
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          // Found complete JSON object
          return response.slice(startIdx, i + 1);
        }
      }
    }
  }

  // 3. If bracket matching fails, fall back to greedy regex
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }

  // 4. If nothing found, return original response
  return response.trim();
}

/**
 * Convert planning output to SubTask array
 */
export function convertToSubTasks(
  output: PlanningOutputFormat,
  parentId: string
): SubTask[] {
  return output.subtasks.map((st) => ({
    id: st.id,
    parentId,
    objective: st.objective,
    ...(st.roleId !== undefined && { roleId: st.roleId }),
    ...(Array.isArray(st.requiredCapabilities) && st.requiredCapabilities.length > 0
      ? { requiredCapabilities: st.requiredCapabilities }
      : {}),
    constraints: st.constraints,
    estimatedDuration: st.estimatedMinutes * 60 * 1000, // Convert to milliseconds
    dependencies: st.dependencies,
    status: 'pending' as const,
  }));
}

/**
 * Convert planning output to ExecutionPlan
 */
export function convertToExecutionPlan(output: PlanningOutputFormat): ExecutionPlan {
  return {
    isParallel: output.executionPlan.isParallel,
    steps: output.executionPlan.steps.map((step) => ({
      order: step.order,
      subtaskIds: step.subtaskIds,
      parallel: step.parallel,
    })),
  };
}

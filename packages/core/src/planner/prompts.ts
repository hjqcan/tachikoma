/**
 * Planner Prompt Templates
 *
 * Defines System Prompt and User Prompt templates for task planning
 */

import type {
  PromptVariables,
  PatchPromptVariables,
  SubtaskRefinePromptVariables,
  ErrorFeedbackVariables,
} from './types';
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

/**
 * Subtask Refinement Output Format - For LLM structured output
 */
export interface SubtaskRefineOutputFormat {
  /** Whether the subtask should be split */
  shouldSplit: boolean;
  /** Short reason for the decision */
  reason: string;
  /** Proposed refined subtasks (empty when shouldSplit=false) */
  subtasks: {
    /** Subtask objective */
    objective: string;
    /** Subtask constraints (optional) */
    constraints?: string[];
    /** Estimated execution time (minutes, optional) */
    estimatedMinutes?: number;
  }[];
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
- **Essential**: Subtask objectives must be self-contained and descriptive (e.g., instead of "Setup project", use "Setup React project structure for Music App"). Do not assume the Worker knows the parent task context implicitly.

## Reference/Clone Task Detection (仿站识别 - CRITICAL for UI Tasks)

If the task objective contains any of these patterns, it is a **Reference Task**:
- Mentions a specific product name (e.g., "网易云音乐", "淘宝", "Spotify", "Netflix", "YouTube")
- Uses words like "仿", "类似", "风格", "像", "clone", "similar to", "like"
- Requests to "克隆", "复刻", "replicate" a website or app

**Mandatory Actions for Reference Tasks**:
1. **First subtask MUST be "Design Specification Analysis"** with objective:
   - "Analyze the UI design of [Product Name]: identify color scheme (primary color, accents), layout structure (sidebar, header, content area), and key UI components (cards, lists, players)"
2. **ALL subsequent UI-related subtasks MUST include** the phrase "following [Product Name] design style" in their objective
3. **Constraints for UI subtasks MUST include**:
   - "Use [Product Name]'s color scheme (e.g., red #C20C0C for 网易云)"
   - "Do NOT use default scaffold/template styling"
   - "Do NOT keep Vite/CRA default content (logos, counters, 'Edit App.tsx' text)"
   - "Remove vanilla Vite scaffolds (src/main.ts, src/counter.ts, src/style.css, src/typescript.svg) when using React"
   - "Ensure index.html entry matches the actual entry file (main.tsx) and root ID"

**Example**:
User says: "创建一个网易云音乐网站"
- Subtask 1: "Analyze NetEase Cloud Music UI: extract red theme (#C20C0C), sidebar navigation, playlist cards, player bar design"
- Subtask 2: "Create page layout following NetEase Cloud Music design style with red theme sidebar"
- Subtask 3: "Implement music player component following NetEase Cloud Music player bar design"

## Execution Discipline (Must Include Verification)
- Every plan must include explicit verification subtasks when relevant (build/test/smoke).
- Default DoD for runnable apps/services: build + smoke (start the app/service and confirm it stays up without errors).
- If build/test commands are unknown, include a subtask to discover them (README, package.json, scripts, etc.) before running.
- Do not declare the plan complete without a verification step.

## Infrastructure First (Agnostic Alignment)
- Always ensure that manifest files (package.json, tsconfig.json, requirements.txt, pyproject.toml) and entry points (index.tsx, main.py) match the language features used in the code.
- If a project is being migrated (e.g., JS to TS), the very first subtasks must include infrastructure setup (creating tsconfig.json, updating entry points, installing types).
- Verification Gate will FAIL if language features (like TypeScript) are used without corresponding infrastructure. Do not proceed to complex business logic until infrastructure is aligned.

## Testing Strategy (CRITICAL - 90 ERRORS IF VIOLATED)

### Contract-First Testing Rule (严格执行 - 否则测试必定编译失败)
Before writing ANY test file, you MUST:
1. **FIRST use file_read** to read the component/module being tested
2. **Extract the EXACT interface/props** from the source code
3. **Write test ONLY using props/methods that ACTUALLY EXIST** in the source

**Example Workflow:**
\`\`\`
1. file_read('src/components/Header.tsx') 
   → See: interface HeaderProps { title?: string; subtitle?: string; }
2. Write test using ONLY { title, subtitle }
3. NEVER use props like onSearch, onFilter unless they exist in HeaderProps
\`\`\`

**COMMON MISTAKES (Each causes 10+ TypeScript errors):**
- ❌ Assuming component has \`onSearch\`, \`onFilter\` props without reading source
- ❌ Using \`mockResolvedValue\` on functions not typed as mocks
- ❌ Testing methods/props that don't exist in the component interface

### Test File Location (ABSOLUTE RULE)
- Tests MUST be co-located: \`Header.test.tsx\` next to \`Header.tsx\`. 
- **NEVER create \`__tests__\` folders** - this ALWAYS breaks import paths and causes "Failed to resolve import" errors.


### TypeScript Configuration for Vitest (必须配置)
\`tsconfig.json\` MUST include vitest types, otherwise ALL test files fail with "Cannot find name 'beforeEach'":
\`\`\`json
{
  "compilerOptions": {
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  }
}
\`\`\`

### Required Test File Imports (每个测试文件必须有)
\`\`\`typescript
// ALWAYS import these from vitest - do NOT rely on globals for TypeScript
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
\`\`\`

### vitest.config.js Setup
\`\`\`javascript
export default {
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
};
\`\`\`

### Mock Type Safety
When mocking functions, use proper typing:
\`\`\`typescript
// ❌ WRONG - mockResolvedValue doesn't exist on inferred type
vi.mock('./api', () => ({ fetchData: vi.fn() }));
api.fetchData.mockResolvedValue(data);  // TypeScript Error!

// ✅ CORRECT - cast to Mock type
import type { Mock } from 'vitest';
const mockFetch = vi.fn() as Mock<[], Promise<Data>>;
mockFetch.mockResolvedValue(data);  // Works!
\`\`\`

### Module Mock Integrity (必须遵守)
When mocking a module, you MUST provide ALL named exports used by the component under test.
If you only want to mock part of a module, merge the real exports:
\`\`\`typescript
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, fetchData: vi.fn() };
});
\`\`\`
Never mock a module and then call unmocked exports (they become undefined).

### ESLint Configuration for Vitest
For ESLint 9 flat config, add vitest globals:
\`\`\`javascript
languageOptions: {
  globals: {
    describe: 'readonly', it: 'readonly', expect: 'readonly',
    vi: 'readonly', beforeEach: 'readonly', afterEach: 'readonly',
    test: 'readonly'
  }
}
\`\`\`

**Required Dependencies**: vitest, @testing-library/react, @testing-library/jest-dom, @testing-library/user-event, jsdom.

## Code Consistency (CRITICAL - Causes Runtime Errors)
**Export/Import Style**: Pick ONE style and use it EVERYWHERE in the project.
- ✅ CORRECT: \`export const Header = () => {...}\` with \`import { Header } from './Header'\`
- ✅ CORRECT: \`export default Header\` with \`import Header from './Header'\`
- ❌ WRONG: \`export default Header\` with \`import { Header }\` - RUNTIME ERROR (no matching export)
- ❌ WRONG: \`export const Header\` with \`import Header\` - RUNTIME ERROR (not a default export)

**Contract-First Rule**: Never reference a function/component in File A that doesn't exist in File B.
- If \`App.tsx\` imports \`{ useSongs, ApiProvider }\` from \`useApi.ts\`, then useApi.ts MUST export BOTH.
- If a file references imports that don't exist, the build WILL FAIL with "No matching export" errors.

**Subtask Dependency Rule**: Files that import from other files MUST be created AFTER the imported files, OR in the same subtask to ensure consistency.

## React Best Practices (CRITICAL - Causes Runtime Crash)
**Router Placement - ONLY ONE BrowserRouter**:
- BrowserRouter MUST exist in ONLY ONE place: either \`main.jsx/index.tsx\` OR \`App.tsx\`, **NEVER BOTH**.
- ❌ WRONG: \`main.jsx\` has \`<BrowserRouter><App/></BrowserRouter>\` AND \`App.tsx\` also has \`<BrowserRouter>...</BrowserRouter>\` inside it.
- This causes: "You cannot render a <Router> inside another <Router>" - **IMMEDIATE CRASH**.
- ✅ CORRECT: Put \`<BrowserRouter>\` ONLY in \`main.jsx\`, keep \`App.tsx\` without any Router wrapper.


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
- subtasks: Subtask list, each containing id, objective (must be context-rich), constraints, estimatedMinutes, dependencies
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

## Execution Discipline (Must Include Verification)
- Include explicit verification subtasks when relevant (build/test/smoke).
- Default DoD for runnable apps/services: build + smoke (start the app/service and confirm it stays up without errors).
- If build/test commands are unknown, include a subtask to discover them before running.
- Keep verification steps close to the change they validate.

## Infrastructure Alignment
- Every modification that introduces new language features (e.g. adding a .tsx file to a JS project) MUST include subtasks to align the infrastructure (tsconfig.json, dependencies).
- Failure to align infrastructure will block all subsequent verification steps.

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
 * Subtask Refinement System Prompt
 *
 * For evaluating a single subtask and deciding whether it must be split
 * to fit within the execution turn limit.
 */
export const SUBTASK_REFINE_SYSTEM_PROMPT = `You are a subtask decomposition reviewer. Your responsibility is to decide whether a single subtask is too large to complete within a strict execution turn limit, and if so, split it into smaller subtasks.

## Your Tasks
1. Decide if the given subtask can realistically finish within the provided max thinking/tool turns.
2. If it can, output shouldSplit=false and an empty subtasks array.
3. If it cannot, split it into 2-6 smaller subtasks that each can finish within the limit.

## Refinement Principles
- Each refined subtask should be a single, concrete outcome.
- Keep the subtasks executable in sequence; avoid hidden dependencies.
- Preserve all original constraints; do not relax them.
- Prefer small, testable units over large multi-part tasks.
- If the subtask is a verification step (build/test/smoke), keep it as a single atomic subtask.

## Output Requirements
Return JSON only, with fields:
- shouldSplit: boolean
- reason: short string
- subtasks: array (empty when shouldSplit=false)

Do not include any extra text or code fences.`;

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

  prompt += `
## Definition of Done
- Default for runnable apps/services: build + smoke (start and keep running without errors).
- Include explicit verification steps (build/test/smoke) when relevant.
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

  prompt += `
## Definition of Done
- Default for runnable apps/services: build + smoke (start and keep running without errors).
- Include explicit verification steps (build/test/smoke) when relevant.
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

/**
 * Generate Subtask Refinement User Prompt
 */
export function generateSubtaskRefineUserPrompt(variables: SubtaskRefinePromptVariables): string {
  const {
    objective,
    constraints,
    availableTools,
    maxSubtasks,
    maxThinkingRounds,
    estimatedMinutes,
  } = variables;

  let prompt = `Please review this subtask and decide whether it must be split:

## Subtask Objective
${objective}

## Constraints
${constraints.length > 0 ? constraints.map((c, i) => `${i + 1}. ${c}`).join('\n') : 'No special constraints'}
`;

  if (typeof estimatedMinutes === 'number') {
    prompt += `
## Estimated Duration
${estimatedMinutes} minutes
`;
  }

  if (availableTools && availableTools.length > 0) {
    prompt += `
## Available Tools
${availableTools.map((t) => `- ${t}`).join('\n')}
`;
  }

  if (maxThinkingRounds) {
    prompt += `
## Execution Limit
Each refined subtask must be doable within ${maxThinkingRounds} thinking/tool turns
`;
  }

  if (maxSubtasks) {
    prompt += `
## Subtask Limit
If splitting, generate at most ${maxSubtasks} subtasks
`;
  }

  prompt += `
## Output Format
Please output JSON only, with this structure:
\`\`\`json
{
  "shouldSplit": false,
  "reason": "short explanation",
  "subtasks": []
}
\`\`\`
If shouldSplit=true, provide 2-6 subtasks with objective, constraints, and optional estimatedMinutes.`;

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

/**
 * Generate Subtask Refinement Parse Error Feedback Prompt
 */
export function generateSubtaskRefineErrorFeedbackPrompt(
  variables: ErrorFeedbackVariables
): string {
  const { originalResponse, parseError, retryCount } = variables;

  return `Your previous response could not be parsed correctly. Please correct and re-output.

## Error Message
${parseError}

## Your Original Response
${originalResponse.slice(0, 1000)}${originalResponse.length > 1000 ? '...(truncated)' : ''}

## Retry Count
This is retry attempt ${retryCount}.

## Requirements
1. Output valid JSON only (no extra text)
2. Include required fields: shouldSplit (boolean), reason (string), subtasks (array)
3. When shouldSplit=false, subtasks must be an empty array
4. When shouldSplit=true, provide 2-6 subtasks with objective and constraints

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
  parentId: string,
  parentObjective?: string
): SubTask[] {
  return output.subtasks.map((st) => ({
    id: st.id,
    parentId,
    objective: st.objective,
    ...(parentObjective !== undefined && { parentObjective }),
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

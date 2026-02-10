import type { EvalCheckResult, EvalExpected, TrajectoryStep } from './types';
import { createLLMClient } from '../planner';

function normalize(text: string): string {
  return text.toLowerCase();
}

interface LLMConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  provider?: 'openai' | 'anthropic';
}

export async function scoreEvalCase(
  summary: string,
  success: boolean,
  trajectory: TrajectoryStep[],
  expected?: EvalExpected,
  llmConfig?: LLMConfig
): Promise<{ score: number; passed: boolean; checks: EvalCheckResult[] }> {
  const checks: EvalCheckResult[] = [];
  const normalizedSummary = normalize(summary ?? '');
  const expectations = expected ?? {};

  // 1. Basic Success Check
  if (expectations.success !== undefined) {
    checks.push({
      type: 'success',
      passed: success === expectations.success,
      score: success === expectations.success ? 1 : 0,
      detail: `expected=${String(expectations.success)} actual=${String(success)}`,
    });
  }

  // 2. String/Regex Checks (Traditional)
  for (const item of expectations.contains ?? []) {
    const passed = normalizedSummary.includes(normalize(item));
    checks.push({
      type: 'contains',
      passed,
      score: passed ? 1 : 0,
      detail: item,
    });
  }

  for (const item of expectations.notContains ?? []) {
    const passed = !normalizedSummary.includes(normalize(item));
    checks.push({
      type: 'not_contains',
      passed,
      score: passed ? 1 : 0,
      detail: item,
    });
  }

  for (const pattern of expectations.regex ?? []) {
    let passed = false;
    try {
      const regex = new RegExp(pattern, 'i');
      passed = regex.test(summary ?? '');
    } catch {
      passed = false;
    }
    checks.push({
      type: 'regex',
      passed,
      score: passed ? 1 : 0,
      detail: pattern,
    });
  }

  // 3. Trajectory Checks (Inside-Out)
  if (expectations.trajectory) {
    const { forbiddenTools, requiredTools, maxSteps } = expectations.trajectory;
    const toolsUsed = new Set(
      trajectory
        .filter((t) => t.type === 'tool_call' && t.tool)
        .map((t) => t.tool!)
    );

    if (forbiddenTools) {
      for (const tool of forbiddenTools) {
        const passed = !toolsUsed.has(tool);
        checks.push({
          type: 'trajectory_forbidden_tool',
          passed,
          score: passed ? 1 : 0,
          detail: `forbidden=${tool}`,
        });
      }
    }

    if (requiredTools) {
      for (const tool of requiredTools) {
        const passed = toolsUsed.has(tool);
        checks.push({
          type: 'trajectory_required_tool',
          passed,
          score: passed ? 1 : 0,
          detail: `required=${tool}`,
        });
      }
    }

    if (maxSteps !== undefined) {
      const stepCount = trajectory.length;
      const passed = stepCount <= maxSteps;
      checks.push({
        type: 'trajectory_max_steps',
        passed,
        score: passed ? 1 : 0,
        detail: `max=${maxSteps} actual=${stepCount}`,
      });
    }
  }

  // 4. LLM-as-Judge
  if (expectations.llmCriteria && llmConfig) {
    try {
      const result = await evaluateWithLLM(
        summary,
        success,
        trajectory,
        expectations.llmCriteria,
        llmConfig
      );
      checks.push({
        type: 'llm_judge',
        passed: result.passed,
        score: result.score,
        detail: expectations.llmCriteria,
        reasoning: result.reasoning,
      });
    } catch (error) {
      checks.push({
        type: 'llm_judge_error',
        passed: false,
        score: 0,
        detail: String(error),
      });
    }
  }

  if (checks.length === 0) {
    return {
      score: success ? 1 : 0,
      passed: success,
      checks,
    };
  }

  const totalScore = checks.reduce((sum, c) => sum + (c.score ?? (c.passed ? 1 : 0)), 0);
  const score = totalScore / checks.length;
  const threshold = expectations.minScore ?? 1;
  const passed = score >= threshold && checks.every(c => c.type !== 'success' || c.passed); // Strict success check if present

  return { score, passed, checks };
}

async function evaluateWithLLM(
  summary: string,
  success: boolean,
  trajectory: TrajectoryStep[],
  criteria: string,
  config: LLMConfig
): Promise<{ passed: boolean; score: number; reasoning: string }> {
  const client = createLLMClient({
    provider: config.provider || 'openai',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model || 'gpt-4o',
    maxTokens: 1024,
  });

  // Prepare trajectory summary for the LLM to avoid context overflow
  const trajectorySummary = trajectory.map(t => {
    if (t.type === 'tool_call') return `[Tool Call] ${t.tool} input=${JSON.stringify(t.input).slice(0, 200)}`;
    if (t.type === 'tool_result') return `[Tool Result] ${t.tool} success=${t.success} output=${JSON.stringify(t.result).slice(0, 200)}`;
    if (t.type === 'thinking') return `[Thinking] ${t.content?.slice(0, 300)}`;
    if (t.type === 'error') return `[Error] ${t.content}`;
    return `[${t.type}] ${t.content?.slice(0, 200)}`;
  }).join('\n');

  const prompt = `
You are an expert AI evaluator.
Your task is to evaluate the performance of an AI agent based on the provided execution trajectory and result summary.

Criteria:
${criteria}

Execution Context:
- Final Success Status: ${success}
- Final Summary: ${summary}

Trajectory (abbreviated):
${trajectorySummary}

Evaluate whether the agent met the criteria.
Return a JSON object with the following structure:
{
  "passed": boolean,
  "score": number, // 0.0 to 1.0
  "reasoning": string // Explanation of the score
}
Do not include markdown formatting (like \`\`\`json). Just the raw JSON.
`;

  const response = await client.complete({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  });

  const content = response.content || '';
  try {
    const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanContent);
    return {
      passed: Boolean(result.passed),
      score: typeof result.score === 'number' ? Math.max(0, Math.min(1, result.score)) : (result.passed ? 1 : 0),
      reasoning: String(result.reasoning || ''),
    };
  } catch (e) {
    return {
      passed: false,
      score: 0,
      reasoning: `Failed to parse LLM response: ${content}`,
    };
  }
}

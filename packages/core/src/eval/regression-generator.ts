import { createLLMClient } from '../planner';
import type { EvalCase, TrajectoryStep } from './types';

interface RegressionGeneratorConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  provider?: 'openai' | 'anthropic';
}

export class RegressionGenerator {
  private client: ReturnType<typeof createLLMClient>;

  constructor(config: RegressionGeneratorConfig) {
    this.client = createLLMClient({
      provider: config.provider || 'openai',
      apiKey: config.apiKey,
      ...(config.baseUrl && { baseUrl: config.baseUrl }),
      model: config.model || 'gpt-4o',
      maxTokens: 4096,
    });
  }

  async generateFromTrajectory(
    originalObjective: string,
    trajectory: TrajectoryStep[],
    errorSummary: string
  ): Promise<EvalCase> {
    const trajectoryText = trajectory
      .slice(-20) // Only look at the last 20 steps to avoid context limit
      .map(t => `[${t.type}] ${t.tool ? `(${t.tool}) ` : ''}${t.content ? t.content.slice(0, 200) : ''} ${t.success === false ? '(FAILED)' : ''}`)
      .join('\n');

    const prompt = `
You are an expert QA Engineer.
An AI agent failed to complete a task. Your job is to create a regression test case (EvalCase) that asserts the correct behavior to prevent this failure in the future.

Original Objective:
${originalObjective}

Error Summary:
${errorSummary}

Recent Execution Trajectory (Last 20 steps):
${trajectoryText}

Generate a JSON object representing an EvalCase.
The 'expected' section should define what constitutes success (e.g., success=true, specific output strings).
If the failure was due to a specific pattern (e.g. using a tool that doesn't exist, or getting stuck), add constraints.

Format:
{
  "id": "regression-generated-id",
  "objective": "The refined objective string (can be same as original)",
  "expected": {
    "success": true,
    "contains": [], // Optional: strings that must appear in summary
    "notContains": [], // Optional: error strings to avoid
    "llmCriteria": "Did the agent successfully...", // Optional: Natural language check
    "trajectory": {
      "forbiddenTools": [], // Optional
      "requiredTools": [], // Optional
      "maxSteps": 20 // Optional
    }
  }
}

Return ONLY the JSON.
`;

    const response = await this.client.complete({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });

    try {
      const content = response.content?.replace(/```json/g, '').replace(/```/g, '').trim() || '{}';
      const evalCase = JSON.parse(content) as EvalCase;

      // Ensure ID is unique/valid
      evalCase.id = `regression-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

      return evalCase;
    } catch (error) {
      throw new Error(`Failed to parse generated regression test: ${error}`);
    }
  }
}

export interface EvalExpected {
  success?: boolean;
  contains?: string[];
  notContains?: string[];
  regex?: string[];
  minScore?: number;
  /**
   * Natural language criteria for LLM-as-Judge evaluation.
   * If provided, an LLM will be used to score the result/trajectory.
   */
  llmCriteria?: string;
  /**
   * Constraints on the execution trajectory.
   */
  trajectory?: {
    forbiddenTools?: string[];
    requiredTools?: string[];
    maxSteps?: number;
  };
}

export interface EvalCase {
  id: string;
  objective: string;
  expected?: EvalExpected;
  metadata?: Record<string, unknown>;
}

export interface EvalSet {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  cases: EvalCase[];
}

export interface EvalCheckResult {
  type: string;
  passed: boolean;
  score?: number;
  detail?: string;
  reasoning?: string;
}

export interface TrajectoryStep {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'subtask_output' | 'error';
  content?: string;
  tool?: string;
  input?: unknown;
  result?: unknown;
  success?: boolean;
  timestamp: number;
}

export interface EvalCaseResult {
  caseId: string;
  objective: string;
  success: boolean;
  score: number;
  passed: boolean;
  summary: string;
  errors: string[];
  durationMs: number;
  expected?: EvalExpected;
  checks: EvalCheckResult[];
  trajectory: TrajectoryStep[];
}

export interface EvalReport {
  evalId: string;
  name?: string;
  description?: string;
  startedAt: number;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  averageScore: number;
  results: EvalCaseResult[];
}

export interface EvalRunOptions {
  sessionDir: string;
  workDir: string;
  llm: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    provider?: 'openai' | 'anthropic';
  };
  verbose?: boolean;
  maxHistoryMessages?: number;
  enableCheckpoints?: boolean;
  noApproval?: boolean;
  caseIds?: string[];
}

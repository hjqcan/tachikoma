export interface EvalExpected {
  success?: boolean;
  contains?: string[];
  notContains?: string[];
  regex?: string[];
  minScore?: number;
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
  detail?: string;
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
  };
  verbose?: boolean;
  maxHistoryMessages?: number;
  enableCheckpoints?: boolean;
  noApproval?: boolean;
  caseIds?: string[];
}

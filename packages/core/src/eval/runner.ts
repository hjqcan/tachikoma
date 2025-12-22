import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ConversationalRunner } from '../conversation/conversational-runner';
import type { EvalCase, EvalReport, EvalRunOptions, EvalSet } from './types';
import { scoreEvalCase } from './scorer';

function normalizeCaseIds(caseIds?: string[]): Set<string> | undefined {
  if (!caseIds || caseIds.length === 0) return undefined;
  return new Set(caseIds.map((id) => id.trim()).filter(Boolean));
}

function coerceEvalCases(rawCases: unknown): EvalCase[] {
  if (!Array.isArray(rawCases)) {
    throw new Error('EvalSet.cases must be an array');
  }
  return rawCases.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Eval case at index ${index} must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const id = String(record.id ?? `case-${index + 1}`);
    const objective = String(record.objective ?? '');
    if (!objective) {
      throw new Error(`Eval case ${id} is missing objective`);
    }
    return {
      id,
      objective,
      expected: record.expected as EvalCase['expected'],
      metadata: record.metadata as EvalCase['metadata'],
    };
  });
}

export async function loadEvalSet(filePath: string): Promise<EvalSet> {
  const resolvedPath = resolve(filePath);
  const raw = await readFile(resolvedPath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('EvalSet must be a JSON object');
  }

  const cases = coerceEvalCases(parsed.cases);
  const id = String(parsed.id ?? resolvedPath);

  return {
    id,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
    cases,
  };
}

export async function runEvalSet(
  evalSet: EvalSet,
  options: EvalRunOptions
): Promise<EvalReport> {
  const startedAt = Date.now();
  const runner = new ConversationalRunner({
    sessionDir: options.sessionDir,
    workDir: options.workDir,
    llm: options.llm,
    verbose: options.verbose,
    maxHistoryMessages: options.maxHistoryMessages,
    enableCheckpoints: options.enableCheckpoints ?? false,
    noApproval: options.noApproval ?? true,
  });

  const caseFilter = normalizeCaseIds(options.caseIds);
  const cases = caseFilter
    ? evalSet.cases.filter((c) => caseFilter.has(c.id))
    : evalSet.cases;

  if (cases.length === 0) {
    throw new Error('No eval cases matched the filter');
  }

  const results = [];

  for (const evalCase of cases) {
    const session = await runner.createSession();
    const caseStart = Date.now();
    let summary = '';
    let lastOutput = '';
    let success = false;
    let sawCompletion = false;
    const errors: string[] = [];

    for await (const evt of runner.handleMessage(session.sessionId, evalCase.objective)) {
      switch (evt.type) {
        case 'thinking':
          if (!lastOutput && evt.content) lastOutput = evt.content;
          break;
        case 'subtask_output':
          lastOutput = evt.content || lastOutput;
          break;
        case 'complete':
          summary = evt.summary;
          success = evt.success;
          sawCompletion = true;
          break;
        case 'need_user_input':
          errors.push(`need_user_input: ${evt.question}`);
          success = false;
          break;
        case 'error':
          errors.push(evt.error);
          success = false;
          break;
        default:
          break;
      }
    }

    if (!sawCompletion) {
      summary = summary || lastOutput;
      if (errors.length === 0) {
        errors.push('no_completion_event');
      }
      success = false;
    }

    const scored = scoreEvalCase(summary, success, evalCase.expected);

    results.push({
      caseId: evalCase.id,
      objective: evalCase.objective,
      success,
      score: scored.score,
      passed: scored.passed,
      summary: summary ?? '',
      errors,
      durationMs: Date.now() - caseStart,
      expected: evalCase.expected,
      checks: scored.checks,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const averageScore =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.score, 0) / results.length
      : 0;

  return {
    evalId: evalSet.id,
    name: evalSet.name,
    description: evalSet.description,
    startedAt,
    durationMs: Date.now() - startedAt,
    total: results.length,
    passed,
    failed,
    averageScore,
    results,
  };
}

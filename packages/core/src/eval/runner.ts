import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ConversationalRunner } from '../conversation/conversational-runner';
import type { EvalCase, EvalReport, EvalRunOptions, EvalSet, TrajectoryStep } from './types';
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
    const evalCase: EvalCase = { id, objective };
    if (record.expected != null) {
      evalCase.expected = record.expected as NonNullable<EvalCase['expected']>;
    }
    if (record.metadata != null) {
      evalCase.metadata = record.metadata as NonNullable<EvalCase['metadata']>;
    }
    return evalCase;
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
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
    ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
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
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
    ...(options.maxHistoryMessages !== undefined
      ? { maxHistoryMessages: options.maxHistoryMessages }
      : {}),
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

  const results: EvalReport['results'] = [];

  for (const evalCase of cases) {
    const session = await runner.createSession();
    const caseStart = Date.now();
    let summary = '';
    let lastOutput = '';
    let success = false;
    let sawCompletion = false;
    const errors: string[] = [];
    const trajectory: TrajectoryStep[] = [];

    for await (const evt of runner.handleMessage(session.sessionId, evalCase.objective)) {
      const timestamp = Date.now();

      switch (evt.type) {
        case 'thinking':
          trajectory.push({ type: 'thinking', content: evt.content, timestamp });
          if (!lastOutput && evt.content) lastOutput = evt.content;
          break;
        case 'subtask_output':
          trajectory.push({ type: 'subtask_output', content: evt.content, timestamp });
          lastOutput = evt.content || lastOutput;
          break;
        case 'tool_call':
          trajectory.push({
            type: 'tool_call',
            tool: evt.tool,
            input: evt.input,
            timestamp
          });
          break;
        case 'tool_result':
          trajectory.push({
            type: 'tool_result',
            tool: evt.tool,
            result: evt.result,
            success: evt.success,
            timestamp
          });
          break;
        case 'complete':
          summary = evt.summary;
          success = evt.success;
          sawCompletion = true;
          break;
        case 'need_user_input':
          errors.push(`need_user_input: ${evt.question}`);
          trajectory.push({ type: 'error', content: `Need user input: ${evt.question}`, timestamp });
          success = false;
          break;
        case 'error':
          errors.push(evt.error);
          trajectory.push({ type: 'error', content: evt.error, timestamp });
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

    // Pass LLM config for LLM-as-Judge
    const scored = await scoreEvalCase(summary, success, trajectory, evalCase.expected, options.llm);

    results.push({
      caseId: evalCase.id,
      objective: evalCase.objective,
      success,
      score: scored.score,
      passed: scored.passed,
      summary: summary ?? '',
      errors,
      durationMs: Date.now() - caseStart,
      ...(evalCase.expected !== undefined ? { expected: evalCase.expected } : {}),
      checks: scored.checks,
      trajectory,
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
    ...(typeof evalSet.name === 'string' ? { name: evalSet.name } : {}),
    ...(typeof evalSet.description === 'string' ? { description: evalSet.description } : {}),
    startedAt,
    durationMs: Date.now() - startedAt,
    total: results.length,
    passed,
    failed,
    averageScore,
    results,
  };
}

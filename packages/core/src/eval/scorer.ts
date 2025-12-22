import type { EvalCheckResult, EvalExpected } from './types';

function normalize(text: string): string {
  return text.toLowerCase();
}

export function scoreEvalCase(
  summary: string,
  success: boolean,
  expected?: EvalExpected
): { score: number; passed: boolean; checks: EvalCheckResult[] } {
  const checks: EvalCheckResult[] = [];
  const normalizedSummary = normalize(summary ?? '');
  const expectations = expected ?? {};

  if (expectations.success !== undefined) {
    checks.push({
      type: 'success',
      passed: success === expectations.success,
      detail: `expected=${String(expectations.success)} actual=${String(success)}`,
    });
  }

  for (const item of expectations.contains ?? []) {
    const passed = normalizedSummary.includes(normalize(item));
    checks.push({
      type: 'contains',
      passed,
      detail: item,
    });
  }

  for (const item of expectations.notContains ?? []) {
    const passed = !normalizedSummary.includes(normalize(item));
    checks.push({
      type: 'not_contains',
      passed,
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
      detail: pattern,
    });
  }

  if (checks.length === 0) {
    return {
      score: success ? 1 : 0,
      passed: success,
      checks,
    };
  }

  const passedCount = checks.filter((c) => c.passed).length;
  const score = passedCount / checks.length;
  const threshold = expectations.minScore ?? 1;
  const passed = score >= threshold;

  return { score, passed, checks };
}

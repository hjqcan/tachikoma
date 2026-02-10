import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { EvalCase, EvalSet } from './types';

export class FailureCollector {
  private storagePath: string;

  constructor(storagePath: string = 'evals/regression-suite.json') {
    this.storagePath = storagePath;
  }

  async addCase(evalCase: EvalCase): Promise<void> {
    let evalSet: EvalSet;
    const resolvedPath = resolve(this.storagePath);

    try {
      const content = await readFile(resolvedPath, 'utf-8');
      evalSet = JSON.parse(content);
    } catch {
      // Create new set if not exists
      evalSet = {
        id: 'regression-suite',
        name: 'Regression Test Suite',
        description: 'Automatically generated regression tests from failures',
        cases: [],
      };
    }

    evalSet.cases.push(evalCase);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(evalSet, null, 2));
  }
}

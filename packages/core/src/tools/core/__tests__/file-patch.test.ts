/**
 * apply_patch 工具测试
 * 
 * 测试搜索/替换模式和 freeform 模式
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { applyPatchTool, parseFreeformPatch, applyHunk } from '../file-patch';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecutionContext } from '../../../types';

describe('apply_patch tool', () => {
  let testDir: string;
  let context: ExecutionContext;

  beforeAll(async () => {
    testDir = join(tmpdir(), `tachikoma-patch-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    
    context = {
      workDir: testDir,
      taskId: 'test-task',
      agentId: 'test-agent',
      traceId: 'test-trace',
      env: {},
    };
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // 搜索/替换模式
  // ==========================================================================
  describe('search/replace mode', () => {
    it('should apply simple search/replace patch', async () => {
      const filePath = 'test1.ts';
      await writeFile(join(testDir, filePath), 'const old = 1;');

      const result = await applyPatchTool.execute({
        path: filePath,
        patches: [{ search: 'const old = 1;', replace: 'const newVar = 2;' }],
      }, context);

      expect(result.success).toBe(true);
      
      const content = await readFile(join(testDir, filePath), 'utf-8');
      expect(content).toBe('const newVar = 2;');
    });

    it('should apply multiple patches', async () => {
      const filePath = 'test2.ts';
      await writeFile(join(testDir, filePath), 'const a = 1;\nconst b = 2;');

      const result = await applyPatchTool.execute({
        path: filePath,
        patches: [
          { search: 'const a = 1;', replace: 'const x = 10;' },
          { search: 'const b = 2;', replace: 'const y = 20;' },
        ],
      }, context);

      expect(result.success).toBe(true);
      expect((result as { data: { patchesApplied: number } }).data.patchesApplied).toBe(2);
      
      const content = await readFile(join(testDir, filePath), 'utf-8');
      expect(content).toBe('const x = 10;\nconst y = 20;');
    });

    it('should fail when search string not found', async () => {
      const filePath = 'test3.ts';
      await writeFile(join(testDir, filePath), 'const a = 1;');

      const result = await applyPatchTool.execute({
        path: filePath,
        patches: [{ search: 'nonexistent', replace: 'replacement' }],
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should replace specific occurrence', async () => {
      const filePath = 'test4.ts';
      await writeFile(join(testDir, filePath), 'foo bar foo baz foo');

      const result = await applyPatchTool.execute({
        path: filePath,
        patches: [{ search: 'foo', replace: 'XXX', occurrence: 2 }],
      }, context);

      expect(result.success).toBe(true);
      
      const content = await readFile(join(testDir, filePath), 'utf-8');
      expect(content).toBe('foo bar XXX baz foo');
    });

    it('should replace all occurrences when occurrence is 0', async () => {
      const filePath = 'test5.ts';
      await writeFile(join(testDir, filePath), 'foo bar foo baz foo');

      const result = await applyPatchTool.execute({
        path: filePath,
        patches: [{ search: 'foo', replace: 'XXX', occurrence: 0 }],
      }, context);

      expect(result.success).toBe(true);
      
      const content = await readFile(join(testDir, filePath), 'utf-8');
      expect(content).toBe('XXX bar XXX baz XXX');
    });
  });

  // ==========================================================================
  // Freeform 模式
  // ==========================================================================
  describe('freeform mode', () => {
    it('should apply simple freeform patch', async () => {
      const filePath = 'freeform1.ts';
      await writeFile(join(testDir, filePath), `function foo() {
  const old = 1;
  return old;
}`);

      const patch = `@@ function foo @@
-  const old = 1;
+  const newVar = 2;`;

      const result = await applyPatchTool.execute({
        path: filePath,
        freeform: patch,
      }, context);

      expect(result.success).toBe(true);
      
      const content = await readFile(join(testDir, filePath), 'utf-8');
      expect(content).toContain('const newVar = 2;');
      expect(content).not.toContain('const old = 1;');
    });

    it('should apply multi-hunk freeform patch', async () => {
      const filePath = 'freeform2.ts';
      await writeFile(join(testDir, filePath), `function foo() {
  const a = 1;
}

function bar() {
  const b = 2;
}`);

      const patch = `@@ function foo @@
-  const a = 1;
+  const x = 10;
@@ function bar @@
-  const b = 2;
+  const y = 20;`;

      const result = await applyPatchTool.execute({
        path: filePath,
        freeform: patch,
      }, context);

      expect(result.success).toBe(true);
      expect((result as { data: { patchesApplied: number } }).data.patchesApplied).toBe(2);
    });

    it('should fail when context not found', async () => {
      const filePath = 'freeform3.ts';
      await writeFile(join(testDir, filePath), 'const a = 1;');

      const patch = `@@ nonexistent context @@
-  const a = 1;
+  const b = 2;`;

      const result = await applyPatchTool.execute({
        path: filePath,
        freeform: patch,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Context line not found');
    });

    it('should handle Begin/End Patch markers', async () => {
      const filePath = 'freeform4.ts';
      await writeFile(join(testDir, filePath), `function test() {
  const old = 1;
}`);

      const patch = `*** Begin Patch
--- a/freeform4.ts
+++ b/freeform4.ts
@@ function test @@
-  const old = 1;
+  const newVal = 99;
*** End Patch`;

      const result = await applyPatchTool.execute({
        path: filePath,
        freeform: patch,
      }, context);

      expect(result.success).toBe(true);
      
      const content = await readFile(join(testDir, filePath), 'utf-8');
      expect(content).toContain('const newVal = 99;');
    });

    it('should fail on ambiguous context matches', async () => {
      const filePath = 'freeform5.ts';
      await writeFile(join(testDir, filePath), `const value = 1;\nconst value = 1;`);

      const patch = `@@ const value @@
-const value = 1;
+const value = 2;`;

      const result = await applyPatchTool.execute({
        path: filePath,
        freeform: patch,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Ambiguous context');
    });
  });

  // ==========================================================================
  // parseFreeformPatch 单元测试
  // ==========================================================================
  describe('parseFreeformPatch', () => {
    it('should parse simple hunk', () => {
      const patch = `@@ context line @@
-old line
+new line`;
      
      const hunks = parseFreeformPatch(patch);
      
      expect(hunks.length).toBe(1);
      expect(hunks[0]?.context).toBe('context line');
      expect(hunks[0]?.removedLines).toEqual(['old line']);
      expect(hunks[0]?.addedLines).toEqual(['new line']);
    });

    it('should parse multiple hunks', () => {
      const patch = `@@ first context @@
-line1
+newLine1
@@ second context @@
-line2
+newLine2`;
      
      const hunks = parseFreeformPatch(patch);
      
      expect(hunks.length).toBe(2);
      expect(hunks[0]?.context).toBe('first context');
      expect(hunks[1]?.context).toBe('second context');
    });

    it('should ignore --- and +++ headers', () => {
      const patch = `--- a/file.ts
+++ b/file.ts
@@ context @@
-old
+new`;
      
      const hunks = parseFreeformPatch(patch);
      
      expect(hunks.length).toBe(1);
      expect(hunks[0]?.removedLines).toEqual(['old']);
      expect(hunks[0]?.addedLines).toEqual(['new']);
    });

    it('should handle only additions (no removals)', () => {
      const patch = `@@ after this line @@
+added line 1
+added line 2`;
      
      const hunks = parseFreeformPatch(patch);
      
      expect(hunks.length).toBe(1);
      expect(hunks[0]?.removedLines).toEqual([]);
      expect(hunks[0]?.addedLines).toEqual(['added line 1', 'added line 2']);
    });
  });

  // ==========================================================================
  // 边界情况
  // ==========================================================================
  describe('edge cases', () => {
    it('should error when neither patches nor freeform provided', async () => {
      const result = await applyPatchTool.execute({
        path: 'test.ts',
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Must provide either');
    });

    it('should error when file not found', async () => {
      const result = await applyPatchTool.execute({
        path: 'nonexistent.ts',
        patches: [{ search: 'a', replace: 'b' }],
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });
  });
});

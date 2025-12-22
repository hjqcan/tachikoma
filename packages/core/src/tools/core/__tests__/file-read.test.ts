/**
 * file_read 工具测试
 * 
 * 测试增强的缩进感知读取功能
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { fileReadTool } from '../file-read';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecutionContext } from '../../../types';

describe('file_read tool', () => {
  let testDir: string;
  let context: ExecutionContext;

  beforeAll(async () => {
    testDir = join(tmpdir(), `tachikoma-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    
    context = {
      workDir: testDir,
      taskId: 'test-task',
      agentId: 'test-agent',
    };
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('full mode', () => {
    it('should read entire file', async () => {
      const content = 'line1\nline2\nline3';
      await writeFile(join(testDir, 'simple.txt'), content);

      const result = await fileReadTool.execute({ path: 'simple.txt' }, context);
      
      expect(result.success).toBe(true);
      expect(result.data?.content).toContain('line1');
      expect(result.data?.content).toContain('line2');
      expect(result.data?.content).toContain('line3');
      expect(result.data?.totalLines).toBe(3);
    });

    it('should NOT limit lines in full mode (behavior fix)', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n');
      await writeFile(join(testDir, 'long.txt'), lines);

      // full mode should read ALL lines, not limit to 10
      const result = await fileReadTool.execute(
        { path: 'long.txt', mode: 'full', limit: 10 },
        context
      );
      
      expect(result.success).toBe(true);
      // Full mode ignores limit, should have all 100 lines
      expect(result.data?.lineRange?.start).toBe(1);
      expect(result.data?.lineRange?.end).toBe(100);
    });

    it('should NOT show line numbers in full mode by default', async () => {
      const content = 'line1\nline2\nline3';
      await writeFile(join(testDir, 'nolinenums.txt'), content);

      const result = await fileReadTool.execute({ path: 'nolinenums.txt' }, context);
      
      expect(result.success).toBe(true);
      // Full mode should NOT have L1: prefix
      expect(result.data?.content).not.toContain('L1:');
      expect(result.data?.content).toContain('line1');
    });

    it('should ignore showLineNumbers in full mode (returns raw content)', async () => {
      const content = 'line1\nline2';
      await writeFile(join(testDir, 'fullmode_raw.txt'), content);

      // full mode returns raw content, ignores showLineNumbers
      const result = await fileReadTool.execute(
        { path: 'fullmode_raw.txt', showLineNumbers: true },
        context
      );
      
      expect(result.success).toBe(true);
      // Full mode returns raw content without line processing
      expect(result.data?.content).toBe('line1\nline2');
    });
  });

  describe('slice mode', () => {
    it('should read specific line range', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
      await writeFile(join(testDir, 'numbered.txt'), lines);

      const result = await fileReadTool.execute(
        { path: 'numbered.txt', mode: 'slice', offset: 5, limit: 3 },
        context
      );
      
      expect(result.success).toBe(true);
      expect(result.data?.content).toContain('L5:');
      expect(result.data?.content).toContain('L6:');
      expect(result.data?.content).toContain('L7:');
      expect(result.data?.lineRange).toEqual({ start: 5, end: 7 });
    });

    it('should handle offset exceeding file length', async () => {
      const content = 'line1\nline2';
      await writeFile(join(testDir, 'short.txt'), content);

      const result = await fileReadTool.execute(
        { path: 'short.txt', mode: 'slice', offset: 100 },
        context
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds file length');
    });

    it('should validate offset >= 1', async () => {
      await writeFile(join(testDir, 'test.txt'), 'content');

      const result = await fileReadTool.execute(
        { path: 'test.txt', mode: 'slice', offset: 0 },
        context
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('offset must be >= 1');
    });

    it('should hide line numbers when showLineNumbers is false', async () => {
      const lines = Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join('\n');
      await writeFile(join(testDir, 'slice_nolines.txt'), lines);

      const result = await fileReadTool.execute(
        { path: 'slice_nolines.txt', mode: 'slice', offset: 1, limit: 3, showLineNumbers: false },
        context
      );
      
      expect(result.success).toBe(true);
      expect(result.data?.content).not.toContain('L1:');
      expect(result.data?.content).toContain('line1');
    });
  });


  describe('indentation mode', () => {
    const pythonCode = `
class Calculator:
    """A simple calculator class."""
    
    def __init__(self):
        self.value = 0
    
    def add(self, x):
        """Add x to the current value."""
        self.value += x
        return self
    
    def subtract(self, x):
        """Subtract x from the current value."""
        self.value -= x
        return self

def helper():
    pass
`.trim();

    beforeAll(async () => {
      await writeFile(join(testDir, 'calculator.py'), pythonCode);
    });

    it('should read entire function when anchor is inside', async () => {
      // Line 9 is "self.value += x" inside the add method
      const result = await fileReadTool.execute(
        { 
          path: 'calculator.py', 
          mode: 'indentation', 
          offset: 9,
          limit: 50,
          indentation: {
            includeSiblings: false,
            includeHeader: true,
          }
        },
        context
      );
      
      expect(result.success).toBe(true);
      const content = result.data?.content || '';
      // Should include the method definition and docstring
      expect(content).toContain('def add');
      expect(content).toContain('Add x to the current value');
      expect(content).toContain('self.value += x');
      expect(content).toContain('return self');
    });

    it('should expand to parent class when maxLevels is high', async () => {
      // Anchor at method body, expand to include class
      const result = await fileReadTool.execute(
        { 
          path: 'calculator.py', 
          mode: 'indentation', 
          offset: 9,
          limit: 100,
          indentation: {
            maxLevels: 3,
            includeSiblings: true,
          }
        },
        context
      );
      
      expect(result.success).toBe(true);
      const content = result.data?.content || '';
      // Should include the class definition
      expect(content).toContain('class Calculator');
    });

    it('should respect maxLines limit', async () => {
      const result = await fileReadTool.execute(
        { 
          path: 'calculator.py', 
          mode: 'indentation', 
          offset: 9,
          limit: 50,
          indentation: {
            maxLines: 3,
          }
        },
        context
      );
      
      expect(result.success).toBe(true);
      const lines = (result.data?.content || '').split('\n').filter((l: string) => l.trim());
      expect(lines.length).toBeLessThanOrEqual(3);
    });

    it('should error when anchorLine exceeds file length', async () => {
      const result = await fileReadTool.execute(
        { 
          path: 'calculator.py', 
          mode: 'indentation', 
          offset: 1,
          limit: 50,
          indentation: {
            anchorLine: 9999, // Way beyond file length
          }
        },
        context
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('anchorLine');
      expect(result.error).toContain('exceeds file length');
    });

    it('should error when anchorLine is less than 1', async () => {
      const result = await fileReadTool.execute(
        { 
          path: 'calculator.py', 
          mode: 'indentation', 
          offset: 1,
          limit: 50,
          indentation: {
            anchorLine: 0, // Invalid
          }
        },
        context
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('anchorLine');
    });
  });

  describe('edge cases', () => {
    it('should handle binary files', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0xFF, 0xFE]);
      await writeFile(join(testDir, 'binary.bin'), binaryData);

      const result = await fileReadTool.execute(
        { path: 'binary.bin' },
        context
      );
      
      expect(result.success).toBe(true);
      expect(result.data?.isBinary).toBe(true);
      // Should be base64 encoded
      expect(result.data?.content).toBe(binaryData.toString('base64'));
    });

    it('should handle file not found', async () => {
      const result = await fileReadTool.execute(
        { path: 'nonexistent.txt' },
        context
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('should handle empty files', async () => {
      await writeFile(join(testDir, 'empty.txt'), '');

      const result = await fileReadTool.execute(
        { path: 'empty.txt' },
        context
      );
      
      expect(result.success).toBe(true);
      expect(result.data?.totalLines).toBe(1); // Empty file has one empty line
    });

    it('should handle files with tabs', async () => {
      const content = '\t\tindented content';
      await writeFile(join(testDir, 'tabs.txt'), content);

      const result = await fileReadTool.execute(
        { path: 'tabs.txt', mode: 'slice', offset: 1, limit: 1 },
        context
      );
      
      expect(result.success).toBe(true);
      expect(result.data?.content).toContain('indented content');
    });
  });

  describe('indentation algorithm details', () => {
    const nestedCode = `
function outer() {
  console.log('outer start');
  
  function inner() {
    console.log('inner');
  }
  
  console.log('outer end');
}

function other() {
  console.log('other');
}
`.trim();

    beforeAll(async () => {
      await writeFile(join(testDir, 'nested.js'), nestedCode);
    });

    it('should handle blank lines with effective indent', async () => {
      // Anchor at blank line between outer start and inner
      const result = await fileReadTool.execute(
        { 
          path: 'nested.js', 
          mode: 'indentation', 
          offset: 3, // blank line
          limit: 10,
        },
        context
      );
      
      expect(result.success).toBe(true);
      // Blank lines should inherit indent from previous non-blank line
    });

    it('should not include sibling functions by default', async () => {
      // Anchor inside inner function
      const result = await fileReadTool.execute(
        { 
          path: 'nested.js', 
          mode: 'indentation', 
          offset: 5, // console.log('inner')
          limit: 20,
          indentation: {
            includeSiblings: false,
            maxLevels: 0, // unlimited
          }
        },
        context
      );
      
      expect(result.success).toBe(true);
      const content = result.data?.content || '';
      // Should include outer function but not "other" function
      expect(content).toContain('function outer');
      expect(content).not.toContain('function other');
    });

    it('should include sibling functions when enabled', async () => {
      // Anchor at outer function, include siblings
      const result = await fileReadTool.execute(
        { 
          path: 'nested.js', 
          mode: 'indentation', 
          offset: 8, // outer end
          limit: 50,
          indentation: {
            includeSiblings: true,
            maxLevels: 0,
          }
        },
        context
      );
      
      expect(result.success).toBe(true);
      const content = result.data?.content || '';
      // When includeSiblings=true at top level, should see other function
      expect(content).toContain('function outer');
    });
  });
});

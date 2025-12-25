/**
 * Agent Identity - Memory Blocks 单元测试
 *
 * 测试 BlockLoader/BlockWriter 的核心功能：
 * - 全局/项目块加载
 * - 原子写入
 * - 只读块拒绝写入
 * - 大小限制检查
 *
 * @module tests/agent-identity-blocks.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  BlockLoader,
  BlockWriter,
  BLOCK_LABELS,
  DEFAULT_BLOCK_CONTENT,
  BLOCK_FILE_EXTENSION,
  getBlockScope,
  isReadOnlyBlock,
  type BlockLabel,
} from '../src/agent-identity';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-blocks-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

// ============================================================================
// getBlockScope 测试
// ============================================================================

describe('getBlockScope', () => {
  test('returns global for global blocks', () => {
    expect(getBlockScope('persona')).toBe('global');
    expect(getBlockScope('preferences')).toBe('global');
  });

  test('returns project for project blocks', () => {
    expect(getBlockScope('project')).toBe('project');
    expect(getBlockScope('skills')).toBe('project');
    expect(getBlockScope('loaded_skills')).toBe('project');
  });
});

// ============================================================================
// isReadOnlyBlock 测试
// ============================================================================

describe('isReadOnlyBlock', () => {
  test('returns true for read-only blocks', () => {
    expect(isReadOnlyBlock('skills')).toBe(true);
    expect(isReadOnlyBlock('loaded_skills')).toBe(true);
  });

  test('returns false for writable blocks', () => {
    expect(isReadOnlyBlock('persona')).toBe(false);
    expect(isReadOnlyBlock('preferences')).toBe(false);
    expect(isReadOnlyBlock('project')).toBe(false);
  });
});

// ============================================================================
// BlockLoader 测试
// ============================================================================

describe('BlockLoader', () => {
  describe('load', () => {
    test('returns null for non-existent block', async () => {
      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const block = await loader.load('persona');
      expect(block).toBeNull();
    });

    test('loads existing block file', async () => {
      const globalDir = path.join(tempDir, 'global');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.writeFileSync(
        path.join(globalDir, `persona${BLOCK_FILE_EXTENSION}`),
        '# My Persona\n\nI am helpful.\n'
      );

      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir,
        projectDir: path.join(tempDir, 'project'),
      });

      const block = await loader.load('persona');

      expect(block).not.toBeNull();
      expect(block!.label).toBe('persona');
      expect(block!.value).toBe('# My Persona\n\nI am helpful.\n');
      expect(block!.scope).toBe('global');
      expect(block!.readOnly).toBe(false);
    });

    test('loads project block from project directory', async () => {
      const projectDir = path.join(tempDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, `project${BLOCK_FILE_EXTENSION}`),
        '# Project Rules\n\nUse TypeScript.\n'
      );

      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir,
      });

      const block = await loader.load('project');

      expect(block).not.toBeNull();
      expect(block!.label).toBe('project');
      expect(block!.scope).toBe('project');
    });
  });

  describe('loadOrDefault', () => {
    test('returns default content when file does not exist', async () => {
      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const block = await loader.loadOrDefault('preferences');

      expect(block.label).toBe('preferences');
      expect(block.value).toBe(DEFAULT_BLOCK_CONTENT.preferences);
      expect(block.scope).toBe('global');
    });

    test('returns existing content when file exists', async () => {
      const globalDir = path.join(tempDir, 'global');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.writeFileSync(
        path.join(globalDir, `preferences${BLOCK_FILE_EXTENSION}`),
        '# Custom Preferences\n'
      );

      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir,
        projectDir: path.join(tempDir, 'project'),
      });

      const block = await loader.loadOrDefault('preferences');

      expect(block.value).toBe('# Custom Preferences\n');
    });
  });

  describe('loadByScope', () => {
    test('loads all global blocks', async () => {
      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const blocks = await loader.loadByScope('global');

      expect(blocks.length).toBe(BLOCK_LABELS.GLOBAL.length);
      expect(blocks.map((b) => b.label).sort()).toEqual(
        [...BLOCK_LABELS.GLOBAL].sort()
      );
    });

    test('loads all project blocks', async () => {
      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const blocks = await loader.loadByScope('project');

      expect(blocks.length).toBe(BLOCK_LABELS.PROJECT.length);
      expect(blocks.map((b) => b.label).sort()).toEqual(
        [...BLOCK_LABELS.PROJECT].sort()
      );
    });
  });

  describe('loadAll', () => {
    test('loads all blocks (global + project)', async () => {
      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const blocks = await loader.loadAll();

      const totalLabels =
        BLOCK_LABELS.GLOBAL.length + BLOCK_LABELS.PROJECT.length;
      expect(blocks.length).toBe(totalLabels);
    });
  });
});

// ============================================================================
// BlockWriter 测试
// ============================================================================

describe('BlockWriter', () => {
  describe('write', () => {
    test('writes block to correct location', async () => {
      const globalDir = path.join(tempDir, 'global');
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir,
        projectDir: path.join(tempDir, 'project'),
      });

      const result = await writer.write('persona', '# New Persona\n');

      expect(result.success).toBe(true);
      expect(result.label).toBe('persona');
      expect(fs.existsSync(result.filePath)).toBe(true);
      expect(fs.readFileSync(result.filePath, 'utf-8')).toBe('# New Persona\n');
    });

    test('writes project block to project directory', async () => {
      const projectDir = path.join(tempDir, 'project');
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir,
      });

      const result = await writer.write('project', '# Project\n');

      expect(result.success).toBe(true);
      expect(result.filePath).toContain('project');
      expect(fs.existsSync(result.filePath)).toBe(true);
    });

    test('creates directories if they do not exist', async () => {
      const globalDir = path.join(tempDir, 'nested', 'global');
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir,
        projectDir: path.join(tempDir, 'project'),
      });

      expect(fs.existsSync(globalDir)).toBe(false);

      const result = await writer.write('persona', 'Content');

      expect(result.success).toBe(true);
      expect(fs.existsSync(globalDir)).toBe(true);
    });

    test('normalizes content (adds trailing newline)', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      await writer.write('persona', 'No trailing newline');

      const content = fs.readFileSync(
        path.join(tempDir, 'global', `persona${BLOCK_FILE_EXTENSION}`),
        'utf-8'
      );
      expect(content.endsWith('\n')).toBe(true);
    });

    test('rejects writing to read-only block without forceReadOnly', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const result = await writer.write('skills', 'New skills content');

      expect(result.success).toBe(false);
      expect(result.error).toContain('read-only');
    });

    test('allows writing to read-only block with forceReadOnly', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const result = await writer.write('skills', 'New skills content', {
        forceReadOnly: true,
        source: 'skillTool',
      });

      expect(result.success).toBe(true);
    });

    test('rejects content exceeding max file size', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
        maxFileSize: 100, // 100 bytes limit
      });

      const largeContent = 'x'.repeat(200);
      const result = await writer.write('persona', largeContent);

      expect(result.success).toBe(false);
      expect(result.error).toContain('max file size');
    });
  });

  describe('writeMultiple', () => {
    test('writes multiple blocks', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const results = await writer.writeMultiple([
        { label: 'persona', content: 'Persona content' },
        { label: 'preferences', content: 'Preferences content' },
      ]);

      expect(results.length).toBe(2);
      expect(results.every((r) => r.success)).toBe(true);
    });
  });

  describe('delete', () => {
    test('deletes existing block file', async () => {
      const globalDir = path.join(tempDir, 'global');
      fs.mkdirSync(globalDir, { recursive: true });
      const filePath = path.join(globalDir, `persona${BLOCK_FILE_EXTENSION}`);
      fs.writeFileSync(filePath, 'Content');

      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir,
        projectDir: path.join(tempDir, 'project'),
      });

      const result = await writer.delete('persona');

      expect(result.success).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    test('returns success for non-existent file', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const result = await writer.delete('persona');

      expect(result.success).toBe(true);
    });

    // P1-1: delete() 需要只读检查
    test('rejects deleting read-only block without forceReadOnly', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const result = await writer.delete('skills');

      expect(result.success).toBe(false);
      expect(result.error).toContain('read-only');
    });

    // P1-1: delete() 需要受信来源
    test('allows deleting read-only block with forceReadOnly and trusted source', async () => {
      const projectDir = path.join(tempDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const filePath = path.join(projectDir, `skills${BLOCK_FILE_EXTENSION}`);
      fs.writeFileSync(filePath, 'Content');

      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir,
      });

      const result = await writer.delete('skills', {
        forceReadOnly: true,
        source: 'skillTool',
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });
});

// ============================================================================
// P0/P1 安全性测试
// ============================================================================

describe('Security: P0/P1 fixes', () => {
  // P0-1: BlockLoader 读取超大文件时返回 oversized 占位符
  describe('P0-1: BlockLoader max file size defense on read', () => {
    test('returns oversized placeholder for files exceeding limit', async () => {
      const globalDir = path.join(tempDir, 'global');
      fs.mkdirSync(globalDir, { recursive: true });
      
      // 写入一个超过 100 字节限制的文件
      const largeContent = 'x'.repeat(200);
      fs.writeFileSync(
        path.join(globalDir, `persona${BLOCK_FILE_EXTENSION}`),
        largeContent
      );

      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir,
        projectDir: path.join(tempDir, 'project'),
        maxFileSize: 100, // 100 字节限制
      });

      const block = await loader.load('persona');

      expect(block).not.toBeNull();
      expect(block!.oversized).toBe(true);
      expect(block!.originalSize).toBe(200);
      expect(block!.value).not.toBe(largeContent);
      expect(block!.value).toContain('exceeds limit');
    });

    test('loads file normally when within size limit', async () => {
      const globalDir = path.join(tempDir, 'global');
      fs.mkdirSync(globalDir, { recursive: true });
      
      const smallContent = 'x'.repeat(50);
      fs.writeFileSync(
        path.join(globalDir, `persona${BLOCK_FILE_EXTENSION}`),
        smallContent
      );

      const loader = new BlockLoader({
        workDir: tempDir,
        globalDir,
        projectDir: path.join(tempDir, 'project'),
        maxFileSize: 100,
      });

      const block = await loader.load('persona');

      expect(block).not.toBeNull();
      expect(block!.oversized).toBeUndefined();
      expect(block!.value).toBe(smallContent);
    });
  });

  // P1-2: forceReadOnly 需要受信来源
  describe('P1-2: forceReadOnly requires trusted source', () => {
    test('rejects forceReadOnly without source', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const result = await writer.write('skills', 'content', {
        forceReadOnly: true,
        // source 未提供
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('trusted source');
    });

    test('rejects forceReadOnly with untrusted source', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      const result = await writer.write('skills', 'content', {
        forceReadOnly: true,
        source: 'malicious-caller',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('trusted source');
    });

    test('accepts forceReadOnly with trusted source', async () => {
      const writer = new BlockWriter({
        workDir: tempDir,
        globalDir: path.join(tempDir, 'global'),
        projectDir: path.join(tempDir, 'project'),
      });

      // skillTool 是受信来源
      const result = await writer.write('skills', 'content', {
        forceReadOnly: true,
        source: 'skillTool',
      });

      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// 集成测试：BlockLoader + BlockWriter
// ============================================================================

describe('BlockLoader + BlockWriter integration', () => {
  test('writer creates file that loader can read', async () => {
    const config = {
      workDir: tempDir,
      globalDir: path.join(tempDir, 'global'),
      projectDir: path.join(tempDir, 'project'),
    };

    const writer = new BlockWriter(config);
    const loader = new BlockLoader(config);

    await writer.write('preferences', '# My Preferences\n\n- Use dark mode\n');

    const block = await loader.load('preferences');

    expect(block).not.toBeNull();
    expect(block!.value).toBe('# My Preferences\n\n- Use dark mode\n');
    expect(block!.label).toBe('preferences');
    expect(block!.scope).toBe('global');
  });
});


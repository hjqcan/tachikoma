/**
 * Unit tests for Workspace Structure Cache
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { WorkspaceStructureCache, parseFileListOutput } from '../src/worker/workspace-cache';

describe('WorkspaceStructureCache', () => {
  let cache: WorkspaceStructureCache;

  beforeEach(() => {
    cache = new WorkspaceStructureCache({
      maxEntries: 50,
      ttlMs: 60000, // 1 minute for testing
    });
  });

  describe('recordDirectoryListing', () => {
    test('should record a directory listing', () => {
      cache.recordDirectoryListing('/project', ['src', 'tests'], ['package.json']);
      expect(cache.size).toBe(1);
      expect(cache.isKnownDirectory('/project')).toBe(true);
    });

    test('should update existing directory listing', () => {
      cache.recordDirectoryListing('/project', ['src'], ['a.ts']);
      cache.recordDirectoryListing('/project', ['src', 'tests'], ['a.ts', 'b.ts']);
      expect(cache.size).toBe(1);
    });

    test('should normalize paths', () => {
      cache.recordDirectoryListing('/project/', ['src'], []);
      expect(cache.isKnownDirectory('/project')).toBe(true);
    });
  });

  describe('recordNonExistent', () => {
    test('should record non-existent paths', () => {
      cache.recordNonExistent('/nonexistent');
      expect(cache.isKnownNonExistent('/nonexistent')).toBe(true);
    });

    test('should remove from directories if recorded as existing', () => {
      cache.recordDirectoryListing('/path', [], []);
      expect(cache.isKnownDirectory('/path')).toBe(true);
      
      cache.recordNonExistent('/path');
      expect(cache.isKnownDirectory('/path')).toBe(false);
      expect(cache.isKnownNonExistent('/path')).toBe(true);
    });
  });

  describe('generateContext', () => {
    test('should return null when empty', () => {
      expect(cache.generateContext()).toBeNull();
    });

    test('should generate context for known directories', () => {
      cache.recordDirectoryListing('/project', ['src', 'tests'], ['package.json']);
      const context = cache.generateContext();
      expect(context).not.toBeNull();
      expect(context).toContain('Workspace Structure');
      expect(context).toContain('/project');
    });

    test('should include non-existent path warnings', () => {
      cache.recordNonExistent('/missing/dir');
      const context = cache.generateContext();
      expect(context).not.toBeNull();
      expect(context).toContain('Non-Existent');
      expect(context).toContain('/missing/dir');
    });

    test('should include both directories and non-existent paths', () => {
      cache.recordDirectoryListing('/project', ['src'], []);
      cache.recordNonExistent('/missing');
      const context = cache.generateContext();
      expect(context).toContain('/project');
      expect(context).toContain('/missing');
    });
  });

  describe('getNonExistentPaths', () => {
    test('should return empty array when none recorded', () => {
      expect(cache.getNonExistentPaths()).toEqual([]);
    });

    test('should return recorded non-existent paths', () => {
      cache.recordNonExistent('/a');
      cache.recordNonExistent('/b');
      const paths = cache.getNonExistentPaths();
      expect(paths).toContain('/a');
      expect(paths).toContain('/b');
    });
  });

  describe('clear', () => {
    test('should clear all data', () => {
      cache.recordDirectoryListing('/project', ['src'], []);
      cache.recordNonExistent('/missing');
      
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.nonExistentCount).toBe(0);
    });
  });
});

describe('parseFileListOutput', () => {
  test('should return null for non-object input', () => {
    expect(parseFileListOutput('string')).toBeNull();
    expect(parseFileListOutput(null)).toBeNull();
  });

  test('should parse Tachikoma file_list ToolResult shape', () => {
    const output = {
      success: true,
      data: {
        files: [
          { name: 'src', path: 'src', isDirectory: true, size: 0 },
          { name: 'package.json', path: 'package.json', isDirectory: false, size: 123 },
        ],
        count: 2,
      },
    };
    const result = parseFileListOutput(output);
    expect(result).not.toBeNull();
    expect(result?.subdirectories).toContain('src');
    expect(result?.files).toContain('package.json');
  });

  test('should parse directory listing output', () => {
    const output = {
      type: 'directory',
      items: [
        { name: 'src', type: 'directory' },
        { name: 'tests', type: 'directory' },
        { name: 'package.json', type: 'file' },
      ],
    };
    const result = parseFileListOutput(output);
    expect(result).not.toBeNull();
    expect(result?.subdirectories).toEqual(['src', 'tests']);
    expect(result?.files).toEqual(['package.json']);
  });

  test('should return null for non-directory type', () => {
    const output = { type: 'file', content: 'hello' };
    expect(parseFileListOutput(output)).toBeNull();
  });
});
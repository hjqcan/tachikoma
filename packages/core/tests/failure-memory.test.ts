/**
 * Unit tests for Failure Memory System
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { FailureMemory } from '../src/worker/failure-memory';

describe('FailureMemory', () => {
  let memory: FailureMemory;

  beforeEach(() => {
    memory = new FailureMemory({
      maxPatterns: 50,
      patternWindowMs: 60000, // 1 minute for testing
      minOccurrences: 2,
    });
  });

  describe('recordFailure', () => {
    test('should record file not found errors', () => {
      memory.recordFailure('file_read', { path: '/foo/bar' }, 'File not found: /foo/bar');
      expect(memory.size).toBe(1);
    });

    test('should detect ENOENT pattern', () => {
      memory.recordFailure('file_read', { path: '/foo/bar' }, 'ENOENT: no such file or directory, open "/foo/bar"');
      expect(memory.size).toBe(1);
    });

    test('should detect directory not found', () => {
      memory.recordFailure('file_list', { path: '/nonexistent' }, 'Directory does not exist: /nonexistent');
      expect(memory.size).toBe(1);
    });

    test('should detect permission denied', () => {
      memory.recordFailure('file_write', { path: '/root/test' }, 'Permission denied for /root/test');
      expect(memory.size).toBe(1);
    });

    test('should detect invalid params', () => {
      memory.recordFailure('knowledge_retrieval', {}, 'Missing parameter: query');
      expect(memory.size).toBe(1);
    });

    test('should detect timeout', () => {
      memory.recordFailure('shell_command', { command: 'sleep 100' }, 'Operation timed out');
      expect(memory.size).toBe(1);
    });

    test('should detect rate limit', () => {
      memory.recordFailure('api_call', {}, 'Rate limit exceeded, 429 Too Many Requests');
      expect(memory.size).toBe(1);
    });

    test('should increment count for repeated patterns', () => {
      memory.recordFailure('file_read', { path: '/foo/bar' }, 'File not found: /foo/bar');
      memory.recordFailure('file_read', { path: '/foo/bar' }, 'File not found: /foo/bar');
      const patterns = memory.getReportablePatterns();
      expect(patterns.length).toBe(1);
      expect(patterns[0].count).toBe(2);
    });

    test('should always prune patterns even when matching known patterns', () => {
      const small = new FailureMemory({
        maxPatterns: 1,
        patternWindowMs: 60000,
        minOccurrences: 1,
      });
      small.recordFailure('file_read', { path: '/a' }, 'File not found: /a');
      small.recordFailure('file_write', { path: '/b' }, 'Permission denied for /b');
      expect(small.size).toBe(1);
    });
  });

  describe('getReportablePatterns', () => {
    test('should return empty for single occurrences', () => {
      memory.recordFailure('file_read', { path: '/foo/bar' }, 'File not found: /foo/bar');
      expect(memory.getReportablePatterns()).toEqual([]);
    });

    test('should return patterns with 2+ occurrences', () => {
      memory.recordFailure('file_read', { path: '/foo/bar' }, 'File not found: /foo/bar');
      memory.recordFailure('file_read', { path: '/foo/bar' }, 'File not found: /foo/bar');
      const patterns = memory.getReportablePatterns();
      expect(patterns.length).toBe(1);
      expect(patterns[0].type).toBe('file_not_found');
    });

    test('should sort by count descending', () => {
      // 3 occurrences
      for (let i = 0; i < 3; i++) {
        memory.recordFailure('file_read', { path: '/a' }, 'File not found: /a');
      }
      // 2 occurrences
      for (let i = 0; i < 2; i++) {
        memory.recordFailure('file_read', { path: '/b' }, 'File not found: /b');
      }
      const patterns = memory.getReportablePatterns();
      expect(patterns.length).toBe(2);
      expect(patterns[0].count).toBe(3);
      expect(patterns[1].count).toBe(2);
    });
  });

  describe('generateWarnings', () => {
    test('should return null with no patterns', () => {
      expect(memory.generateWarnings()).toBeNull();
    });

    test('should return null with single occurrences', () => {
      memory.recordFailure('file_read', { path: '/foo' }, 'File not found: /foo');
      expect(memory.generateWarnings()).toBeNull();
    });

    test('should generate warnings for repeated patterns', () => {
      memory.recordFailure('file_read', { path: '/foo' }, 'File not found: /foo');
      memory.recordFailure('file_read', { path: '/foo' }, 'File not found: /foo');
      const warnings = memory.generateWarnings();
      expect(warnings).not.toBeNull();
      expect(warnings).toContain('KNOWN ISSUES');
      expect(warnings).toContain('/foo');
    });

    test('should include tips for file errors', () => {
      memory.recordFailure('file_read', { path: '/foo' }, 'File not found: /foo');
      memory.recordFailure('file_read', { path: '/foo' }, 'File not found: /foo');
      const warnings = memory.generateWarnings();
      expect(warnings).toContain('TIP');
      expect(warnings).toContain('file_list');
    });

    test('should include tips for invalid params', () => {
      memory.recordFailure('tool', {}, 'Missing parameter: query');
      memory.recordFailure('tool', {}, 'Missing parameter: query');
      const warnings = memory.generateWarnings();
      expect(warnings).toContain('TIP');
      expect(warnings).toContain('documentation');
    });
  });

  describe('getNonExistentDirectories', () => {
    test('should return empty with no directory patterns', () => {
      memory.recordFailure('file_read', { path: '/foo' }, 'File not found: /foo');
      expect(memory.getNonExistentDirectories()).toEqual([]);
    });

    test('should return directories that do not exist', () => {
      memory.recordFailure('file_list', { path: '/missing' }, 'Directory does not exist: /missing');
      memory.recordFailure('file_list', { path: '/missing' }, 'Directory does not exist: /missing');
      const dirs = memory.getNonExistentDirectories();
      expect(dirs).toContain('/missing');
    });
  });

  describe('clear', () => {
    test('should clear all patterns', () => {
      memory.recordFailure('file_read', { path: '/foo' }, 'File not found: /foo');
      memory.recordFailure('file_read', { path: '/foo' }, 'File not found: /foo');
      expect(memory.size).toBeGreaterThan(0);
      
      memory.clear();
      expect(memory.size).toBe(0);
    });
  });
});
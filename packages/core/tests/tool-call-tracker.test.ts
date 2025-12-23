/**
 * Unit tests for ToolCallTracker
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { ToolCallTracker } from '../src/worker/tool-call-tracker';

describe('ToolCallTracker', () => {
  let tracker: ToolCallTracker;

  beforeEach(() => {
    tracker = new ToolCallTracker({
      maxHistory: 50,
      duplicateWindowMs: 60000, // 1 minute for testing
      blockAfterFailures: 3,
      enableBlocking: true,
    });
  });

  describe('checkDuplicate', () => {
    test('should return isDuplicate=false for first call', () => {
      const result = tracker.checkDuplicate('file_read', { path: '/foo/bar' });
      expect(result.isDuplicate).toBe(false);
      expect(result.count).toBe(0);
      expect(result.failureCount).toBe(0);
      expect(result.shouldBlock).toBe(false);
      expect(result.warning).toBeUndefined();
    });

    test('should detect duplicate calls after recording', () => {
      tracker.record('file_read', { path: '/foo/bar' }, true);
      const result = tracker.checkDuplicate('file_read', { path: '/foo/bar' });
      expect(result.isDuplicate).toBe(true);
      expect(result.count).toBe(1);
    });

    test('should generate warning for failed duplicates', () => {
      tracker.record('file_read', { path: '/foo/bar' }, false, 'File not found');
      const result = tracker.checkDuplicate('file_read', { path: '/foo/bar' });
      expect(result.isDuplicate).toBe(true);
      expect(result.failureCount).toBe(1);
      expect(result.warning).toContain('WARNING');
      expect(result.warning).toContain('File not found');
    });

    test('should block after 3 failures', () => {
      for (let i = 0; i < 3; i++) {
        tracker.record('file_read', { path: '/foo/bar' }, false, 'File not found');
      }
      const result = tracker.checkDuplicate('file_read', { path: '/foo/bar' });
      expect(result.shouldBlock).toBe(true);
      expect(result.warning).toContain('BLOCKED');
    });

    test('should not block when enableBlocking is false', () => {
      const noBlockTracker = new ToolCallTracker({
        blockAfterFailures: 3,
        enableBlocking: false,
      });
      for (let i = 0; i < 5; i++) {
        noBlockTracker.record('file_read', { path: '/foo/bar' }, false, 'Error');
      }
      const result = noBlockTracker.checkDuplicate('file_read', { path: '/foo/bar' });
      expect(result.shouldBlock).toBe(false);
    });

    test('should differentiate calls by input', () => {
      tracker.record('file_read', { path: '/foo/bar' }, false, 'File not found');
      const result = tracker.checkDuplicate('file_read', { path: '/different/path' });
      expect(result.isDuplicate).toBe(false);
    });

    test('should differentiate calls by tool name', () => {
      tracker.record('file_read', { path: '/foo/bar' }, false, 'Error');
      const result = tracker.checkDuplicate('file_write', { path: '/foo/bar' });
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('record', () => {
    test('should record calls correctly', () => {
      tracker.record('file_read', { path: '/test' }, true);
      expect(tracker.size).toBe(1);
      
      const calls = tracker.getCalls();
      expect(calls[0].toolName).toBe('file_read');
      expect(calls[0].success).toBe(true);
    });

    test('should record error messages', () => {
      tracker.record('file_read', { path: '/test' }, false, 'Test error');
      const calls = tracker.getCalls();
      expect(calls[0].errorMessage).toBe('Test error');
    });

    test('should respect maxHistory limit', () => {
      const smallTracker = new ToolCallTracker({ maxHistory: 5 });
      for (let i = 0; i < 10; i++) {
        smallTracker.record('tool', { i }, true);
      }
      expect(smallTracker.size).toBe(5);
    });
  });

  describe('getFailurePatterns', () => {
    test('should return empty array with no failures', () => {
      tracker.record('file_read', { path: '/test' }, true);
      expect(tracker.getFailurePatterns()).toEqual([]);
    });

    test('should identify repeated failure patterns', () => {
      tracker.record('file_read', { path: '/test' }, false, 'Error 1');
      tracker.record('file_read', { path: '/test' }, false, 'Error 2');
      const patterns = tracker.getFailurePatterns();
      expect(patterns.length).toBe(1);
      expect(patterns[0].count).toBe(2);
      expect(patterns[0].pattern).toContain('file_read');
    });

    test('should not include single failures', () => {
      tracker.record('file_read', { path: '/test' }, false, 'Error');
      expect(tracker.getFailurePatterns()).toEqual([]);
    });

    test('should extract path patterns', () => {
      tracker.record('file_read', { path: '/foo/bar' }, false, 'Error');
      tracker.record('file_read', { path: '/foo/bar' }, false, 'Error');
      const patterns = tracker.getFailurePatterns();
      expect(patterns[0].pattern).toContain('/foo/bar');
    });
  });

  describe('generateContextWarning', () => {
    test('should return null with no patterns', () => {
      expect(tracker.generateContextWarning()).toBeNull();
    });

    test('should generate warning text for patterns', () => {
      tracker.record('file_read', { path: '/test' }, false, 'Error');
      tracker.record('file_read', { path: '/test' }, false, 'Error');
      const warning = tracker.generateContextWarning();
      expect(warning).not.toBeNull();
      expect(warning).toContain('KNOWN ISSUES');
    });
  });

  describe('clear', () => {
    test('should clear all tracked calls', () => {
      tracker.record('file_read', { path: '/test' }, true);
      tracker.record('file_write', { path: '/test' }, true);
      expect(tracker.size).toBe(2);
      
      tracker.clear();
      expect(tracker.size).toBe(0);
    });

    test('should reset metrics counters', () => {
      // Generate some blocks
      for (let i = 0; i < 3; i++) {
        tracker.record('tool', { input: 'same' }, false, 'Error');
      }
      tracker.checkDuplicate('tool', { input: 'same' }); // This will increment blocked
      
      tracker.clear();
      const metrics = tracker.getMetrics();
      expect(metrics.blockedCalls).toBe(0);
      expect(metrics.duplicateCalls).toBe(0);
    });
  });

  describe('getMetrics', () => {
    test('should return initial metrics', () => {
      const metrics = tracker.getMetrics();
      expect(metrics.totalCalls).toBe(0);
      expect(metrics.blockedCalls).toBe(0);
      expect(metrics.duplicateCalls).toBe(0);
      expect(metrics.duplicateRate).toBe(0);
      expect(metrics.failureRate).toBe(0);
    });

    test('should track duplicate calls', () => {
      tracker.record('tool', { input: 'value' }, true);
      tracker.checkDuplicate('tool', { input: 'value' });
      
      const metrics = tracker.getMetrics();
      expect(metrics.duplicateCalls).toBe(1);
    });

    test('should track blocked calls', () => {
      for (let i = 0; i < 3; i++) {
        tracker.record('tool', { input: 'same' }, false, 'Error');
      }
      tracker.checkDuplicate('tool', { input: 'same' });
      
      const metrics = tracker.getMetrics();
      expect(metrics.blockedCalls).toBe(1);
    });

    test('should calculate failure rate', () => {
      tracker.record('tool', { a: 1 }, true);
      tracker.record('tool', { b: 2 }, false, 'Error');
      
      const metrics = tracker.getMetrics();
      expect(metrics.failureRate).toBe(0.5);
    });
  });

  describe('hashInput edge cases', () => {
    test('should handle null input', () => {
      tracker.record('tool', null, true);
      const result = tracker.checkDuplicate('tool', null);
      expect(result.isDuplicate).toBe(true);
    });

    test('should handle undefined input', () => {
      tracker.record('tool', undefined, true);
      const result = tracker.checkDuplicate('tool', undefined);
      expect(result.isDuplicate).toBe(true);
    });

    test('should handle primitive inputs', () => {
      tracker.record('tool', 'string input', true);
      tracker.record('tool', 42, true);
      tracker.record('tool', true, true);
      
      expect(tracker.checkDuplicate('tool', 'string input').isDuplicate).toBe(true);
      expect(tracker.checkDuplicate('tool', 42).isDuplicate).toBe(true);
      expect(tracker.checkDuplicate('tool', true).isDuplicate).toBe(true);
    });

    test('should handle array inputs', () => {
      tracker.record('tool', [1, 2, 3], true);
      const result = tracker.checkDuplicate('tool', [1, 2, 3]);
      expect(result.isDuplicate).toBe(true);
    });

    test('should produce same hash for objects with different key order', () => {
      tracker.record('tool', { a: 1, b: 2 }, true);
      const result = tracker.checkDuplicate('tool', { b: 2, a: 1 });
      expect(result.isDuplicate).toBe(true);
    });

    test('should not collide for nested objects with different values', () => {
      tracker.record('tool', { a: { x: 1 }, b: 2 }, true);
      // Different nested value should be treated as different input
      const result = tracker.checkDuplicate('tool', { a: { x: 2 }, b: 2 });
      expect(result.isDuplicate).toBe(false);
    });
  });
});
/**
 * SpecKit File Manager Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpecKitFileManager } from '../file-manager';
import type { Constitution, Specification, ImplementationPlan, TaskBreakdown } from '../types';

describe('SpecKitFileManager', () => {
  let tempDir: string;
  let fileManager: SpecKitFileManager;

  beforeEach(async () => {
    // 创建临时目录
    tempDir = join(tmpdir(), `speckit-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    fileManager = new SpecKitFileManager({ workDir: tempDir });
  });

  afterEach(async () => {
    // 清理临时目录
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('init', () => {
    test('should create speckit directory structure', async () => {
      await fileManager.init();

      const isInit = await fileManager.isInitialized();
      expect(isInit).toBe(true);
    });

    test('should create memory, specs, and templates directories', async () => {
      await fileManager.init();

      const memoryPath = fileManager.getMemoryPath();
      const specsPath = fileManager.getSpecsPath();
      const templatesPath = fileManager.getTemplatesPath();

      // 验证目录存在（通过尝试读取）
      const { stat } = await import('node:fs/promises');
      await expect(stat(memoryPath)).resolves.toBeTruthy();
      await expect(stat(specsPath)).resolves.toBeTruthy();
      await expect(stat(templatesPath)).resolves.toBeTruthy();
    });
  });

  describe('Constitution CRUD', () => {
    beforeEach(async () => {
      await fileManager.init();
    });

    test('should write and read constitution', async () => {
      const constitution: Constitution = {
        version: '1.0',
        principles: ['Write clean code', 'Test everything'],
        rawContent: '# Constitution\n\n- Write clean code\n- Test everything',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await fileManager.writeConstitution(constitution);
      const result = await fileManager.readConstitution();

      expect(result).not.toBeNull();
      expect(result?.version).toBe('1.0');
      expect(result?.rawContent).toContain('Constitution');
    });

    test('should return null for non-existent constitution', async () => {
      const result = await fileManager.readConstitution();
      expect(result).toBeNull();
    });
  });

  describe('Specification CRUD', () => {
    beforeEach(async () => {
      await fileManager.init();
    });

    test('should write and read specification', async () => {
      const spec: Specification = {
        id: '001-test-feature',
        name: 'Test Feature',
        description: 'A test feature',
        userStories: [],
        acceptanceCriteria: ['AC1', 'AC2'],
        outOfScope: [],
        rawContent: '# Test Feature\n\nA test feature',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await fileManager.writeSpec(spec);
      const result = await fileManager.readSpec('001-test-feature');

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Test Feature');
    });

    test('should list specifications', async () => {
      const spec1: Specification = {
        id: '001-feature-a',
        name: 'Feature A',
        description: '',
        userStories: [],
        acceptanceCriteria: [],
        outOfScope: [],
        rawContent: '# Feature A',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const spec2: Specification = {
        id: '002-feature-b',
        name: 'Feature B',
        description: '',
        userStories: [],
        acceptanceCriteria: [],
        outOfScope: [],
        rawContent: '# Feature B',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await fileManager.writeSpec(spec1);
      await fileManager.writeSpec(spec2);

      const specs = await fileManager.listSpecs();
      expect(specs.length).toBe(2);
      expect(specs[0].specId).toBe('001-feature-a');
      expect(specs[1].specId).toBe('002-feature-b');
    });
  });

  describe('Plan CRUD', () => {
    beforeEach(async () => {
      await fileManager.init();
    });

    test('should write and read plan', async () => {
      const plan: ImplementationPlan = {
        specId: '001-test',
        techStack: { runtime: 'Node.js' },
        phases: [],
        rawContent: '# Implementation Plan\n\nRuntime: Node.js',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await fileManager.writePlan(plan);
      const result = await fileManager.readPlan('001-test');

      expect(result).not.toBeNull();
      expect(result?.specId).toBe('001-test');
    });
  });

  describe('Tasks CRUD', () => {
    beforeEach(async () => {
      await fileManager.init();
    });

    test('should write and read tasks', async () => {
      const tasks: TaskBreakdown = {
        planId: '001-test',
        tasks: [
          {
            id: 'task-001',
            title: 'Setup project',
            description: 'Initialize project structure',
            filePaths: ['package.json'],
            dependencies: [],
            isParallel: false,
            testFirst: false,
            status: 'pending',
          },
        ],
        dependencies: [{ taskId: 'task-001', dependsOn: [] }],
        parallelGroups: [],
        rawContent: '# Tasks\n\n- [ ] Setup project',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await fileManager.writeTasks(tasks);
      const result = await fileManager.readTasks('001-test');

      expect(result).not.toBeNull();
      expect(result?.tasks.length).toBe(1);
      expect(result?.tasks[0].title).toBe('Setup project');
    });

    test('should update task status', async () => {
      const tasks: TaskBreakdown = {
        planId: '001-test',
        tasks: [
          {
            id: 'task-1', // Use ID that matches what parseTaskList generates
            title: 'Task 1',
            description: '',
            filePaths: [],
            dependencies: [],
            isParallel: false,
            testFirst: false,
            status: 'pending',
          },
        ],
        dependencies: [],
        parallelGroups: [],
        rawContent: '# Task Breakdown\n\n- [ ] Task 1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await fileManager.writeTasks(tasks);
      await fileManager.updateTaskStatus('001-test', 'task-1', 'done');

      const result = await fileManager.readTasks('001-test');
      expect(result?.tasks[0].status).toBe('done');
    });
  });

  describe('deleteSpec', () => {
    beforeEach(async () => {
      await fileManager.init();
    });

    test('should delete spec directory', async () => {
      const spec: Specification = {
        id: '001-to-delete',
        name: 'To Delete',
        description: '',
        userStories: [],
        acceptanceCriteria: [],
        outOfScope: [],
        rawContent: '# To Delete',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await fileManager.writeSpec(spec);
      let specs = await fileManager.listSpecs();
      expect(specs.length).toBe(1);

      await fileManager.deleteSpec('001-to-delete');
      specs = await fileManager.listSpecs();
      expect(specs.length).toBe(0);
    });
  });

  describe('clean', () => {
    test('should remove entire speckit directory', async () => {
      await fileManager.init();
      expect(await fileManager.isInitialized()).toBe(true);

      await fileManager.clean();
      expect(await fileManager.isInitialized()).toBe(false);
    });
  });
});

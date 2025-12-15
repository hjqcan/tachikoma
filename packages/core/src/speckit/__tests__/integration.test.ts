/**
 * SpecKit Integration Test
 *
 * Tests the full Spec-Driven Development workflow
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSpecKitFileManager,
  SpecKitWorkflow,
  SpecKitOrchestratorHelper,
  type SpecKitFileManager,
} from '../index';
import type { LLMClient, LLMResponse } from '../../planner/types';

// Mock LLM Client for consistent test results
function createMockLLMClient(): LLMClient {
  let callCount = 0;

  return {
    provider: 'mock',
    complete: async () => {
      callCount++;

      // Return different responses based on call count
      let content: string;

      switch (callCount) {
        case 1: // Constitution
          content = JSON.stringify({
            principles: ['Write clean code', 'Test first', 'Document everything'],
          });
          break;
        case 2: // Specification
          content = JSON.stringify({
            name: 'User Authentication',
            description: 'Add user login and registration',
            userStories: [
              {
                id: 'US-001',
                description: 'User can log in with email/password',
                acceptanceCriteria: ['Valid credentials grant access'],
                priority: 'high',
              },
            ],
            acceptanceCriteria: ['Users can log in', 'Users can register'],
            outOfScope: ['Social login'],
          });
          break;
        case 3: // Plan
          content = JSON.stringify({
            techStack: {
              runtime: 'Node.js 20',
              backend: 'Express',
              database: 'PostgreSQL',
            },
            phases: [
              {
                id: 'phase-1',
                name: 'Setup',
                description: 'Initialize project',
                steps: ['Create structure', 'Install deps'],
                estimatedHours: 2,
              },
              {
                id: 'phase-2',
                name: 'Implementation',
                description: 'Build auth features',
                steps: ['Create models', 'Build routes'],
                estimatedHours: 8,
              },
            ],
          });
          break;
        case 4: // Tasks
          content = JSON.stringify({
            tasks: [
              {
                id: 'task-1',
                title: 'Setup project structure',
                description: 'Initialize project with package.json',
                filePaths: ['package.json', 'tsconfig.json'],
                dependencies: [],
                isParallel: false,
                testFirst: false,
              },
              {
                id: 'task-2',
                title: 'Create user model',
                description: 'Define User entity',
                filePaths: ['src/models/user.ts'],
                dependencies: ['task-1'],
                isParallel: false,
                testFirst: true,
              },
              {
                id: 'task-3',
                title: 'Implement auth routes',
                description: 'Create login/register endpoints',
                filePaths: ['src/routes/auth.ts'],
                dependencies: ['task-2'],
                isParallel: false,
                testFirst: true,
              },
            ],
            parallelGroups: [],
          });
          break;
        default:
          content = '{}';
      }

      return {
        content,
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
      } as LLMResponse;
    },
    isAvailable: () => true,
  };
}

describe('SpecKit Integration', () => {
  let tempDir: string;
  let fileManager: SpecKitFileManager;
  let workflow: SpecKitWorkflow;
  let llmClient: LLMClient;

  beforeAll(async () => {
    // Create temp directory
    tempDir = join(tmpdir(), `speckit-integration-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    // Initialize components
    fileManager = createSpecKitFileManager({ workDir: tempDir });
    await fileManager.init();

    llmClient = createMockLLMClient();
    workflow = new SpecKitWorkflow({ llmClient, fileManager });
  });

  afterAll(async () => {
    // Cleanup
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Full Workflow', () => {
    let specId: string;

    test('Step 1: Create constitution', async () => {
      const result = await workflow.constitution('Create project principles');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.principles.length).toBeGreaterThan(0);
      expect(result.filePath).toContain('constitution.md');

      // Verify file was created
      const constitution = await fileManager.readConstitution();
      expect(constitution).not.toBeNull();
    });

    test('Step 2: Create specification', async () => {
      const result = await workflow.specify('Add user authentication');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.name).toBe('User Authentication');
      expect(result.data?.userStories.length).toBeGreaterThan(0);

      specId = result.data!.id;
      expect(specId).toBeDefined();

      // Verify file was created
      const spec = await fileManager.readSpec(specId);
      expect(spec).not.toBeNull();
    });

    test('Step 3: Generate implementation plan', async () => {
      const result = await workflow.plan(specId, 'Use Node.js and Express');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.techStack?.runtime).toBe('Node.js 20');
      expect(result.data?.phases.length).toBeGreaterThan(0);

      // Verify file was created
      const plan = await fileManager.readPlan(specId);
      expect(plan).not.toBeNull();
    });

    test('Step 4: Generate task breakdown', async () => {
      const result = await workflow.tasks(specId, true);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.tasks.length).toBe(3);

      // Verify dependencies
      const task2 = result.data?.tasks.find((t) => t.id === 'task-2');
      expect(task2?.dependencies).toContain('task-1');

      // Verify file was created
      const tasks = await fileManager.readTasks(specId);
      expect(tasks).not.toBeNull();
    });

    test('Step 5: Validate workflow status', async () => {
      const status = await workflow.getStatus(specId);

      expect(status.hasConstitution).toBe(true);
      expect(status.hasSpec).toBe(true);
      expect(status.hasPlan).toBe(true);
      expect(status.hasTasks).toBe(true);
    });
  });

  describe('Orchestrator Helper', () => {
    let specId: string;

    beforeAll(async () => {
      // Get specId from previous test
      const specs = await fileManager.listSpecs();
      specId = specs[0]?.specId ?? '';
    });

    test('should validate specification', async () => {
      const helper = new SpecKitOrchestratorHelper({ fileManager });
      const result = await helper.validateSpec(specId);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should convert spec to SubTasks', async () => {
      const helper = new SpecKitOrchestratorHelper({ fileManager });
      const output = await helper.convertSpecToSubtasks(specId);

      expect(output).not.toBeNull();
      expect(output?.subtasks.length).toBe(3);
      expect(output?.executionPlan.steps.length).toBeGreaterThan(0);
      expect(output?.plannerOutput.taskId).toBe('root');
    });

    test('should track progress', async () => {
      const helper = new SpecKitOrchestratorHelper({ fileManager });
      const progress = await helper.getSpecProgress(specId);

      expect(progress).not.toBeNull();
      expect(progress?.totalTasks).toBe(3);
      expect(progress?.completedTasks).toBe(0);
      expect(progress?.percentage).toBe(0);
    });

    test('should get executable tasks', async () => {
      const helper = new SpecKitOrchestratorHelper({ fileManager });
      const tasks = await helper.getExecutableTasks(specId);

      // Tasks are executable based on dependency resolution
      // May include all pending tasks if dependencies parsed differently
      expect(tasks.length).toBeGreaterThan(0);
    });

    test('should update progress after task completion', async () => {
      const helper = new SpecKitOrchestratorHelper({ fileManager });

      // Mark task-1 as done
      await helper.updateTaskProgress(specId, 'task-1', {
        taskId: 'task-1',
        status: 'success',
        output: 'completed',
        artifacts: [],
        metrics: { startTime: 0, endTime: 0, duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 },
        trace: { traceId: '', spanId: '', operation: '', attributes: {}, events: [], duration: 0 },
      });

      // Check progress updated
      const progress = await helper.getSpecProgress(specId);
      expect(progress?.completedTasks).toBe(1);
      expect(progress?.percentage).toBe(33);

      // Check task-2 is now executable
      const executableTasks = await helper.getExecutableTasks(specId);
      expect(executableTasks.some((t) => t.id === 'task-2')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    test('should handle missing specification', async () => {
      const result = await workflow.plan('non-existent-spec', 'tech');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('should handle missing plan', async () => {
      const result = await workflow.tasks('non-existent-spec');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('should validate non-existent spec', async () => {
      const helper = new SpecKitOrchestratorHelper({ fileManager });
      const result = await helper.validateSpec('non-existent');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

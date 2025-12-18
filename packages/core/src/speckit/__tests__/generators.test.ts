/**
 * SpecKit Generators Tests
 */

import { describe, test, expect, mock } from 'bun:test';
import { ConstitutionGenerator } from '../generators/constitution-generator';
import { SpecificationGenerator } from '../generators/specification-generator';
import { PlanGenerator } from '../generators/plan-generator';
import { TaskGenerator } from '../generators/task-generator';
import type { LLMClient, LLMResponse } from '../../planner/types';

// Mock LLM Client
function createMockLLMClient(responseContent: string): LLMClient {
  return {
    provider: 'mock',
    complete: mock(() =>
      Promise.resolve<LLMResponse>({
        content: responseContent,
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
      })
    ),
    isAvailable: () => true,
  };
}

describe('ConstitutionGenerator', () => {
  test('should generate constitution from prompt', async () => {
    const mockResponse = JSON.stringify({
      principles: ['Write clean code', 'Test thoroughly'],
    });

    const llmClient = createMockLLMClient(mockResponse);
    const generator = new ConstitutionGenerator({ llmClient });

    const result = await generator.generate({ prompt: 'Create a React project constitution' });

    expect(result.version).toBe('1.0');
    expect(result.principles).toHaveLength(2);
    expect(result.principles[0]).toBe('Write clean code');
    expect(result.rawContent).toContain('Core Principles');
  });

  test('should use default principles when JSON parsing fails', async () => {
    const llmClient = createMockLLMClient('This is not valid JSON');
    const generator = new ConstitutionGenerator({ llmClient });

    const result = await generator.generate({ prompt: 'test' });

    expect(result.principles).toHaveLength(3);
    expect(result.principles[0]).toContain('clean');
  });

  test('should refine existing constitution', async () => {
    const mockResponse = JSON.stringify({
      principles: ['Updated principle 1', 'Updated principle 2'],
    });

    const llmClient = createMockLLMClient(mockResponse);
    const generator = new ConstitutionGenerator({ llmClient });

    const existing = {
      version: '1.0',
      principles: ['Old principle'],
      rawContent: '# Old Constitution',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await generator.refine(existing, 'Add more principles');

    expect(result.principles).toHaveLength(2);
    expect(result.principles[0]).toBe('Updated principle 1');
  });
});

describe('SpecificationGenerator', () => {
  test('should generate specification from prompt', async () => {
    const mockResponse = JSON.stringify({
      name: 'User Authentication',
      description: 'Add user login and registration',
      userStories: [
        {
          id: 'US-001',
          description: 'As a user, I want to log in so that I can access my account',
          acceptanceCriteria: ['Email/password login works'],
          priority: 'high',
        },
      ],
      acceptanceCriteria: ['Users can log in'],
      outOfScope: ['Social login'],
    });

    const llmClient = createMockLLMClient(mockResponse);
    const generator = new SpecificationGenerator({ llmClient });

    const result = await generator.generate({ prompt: 'Add user authentication' });

    expect(result.name).toBe('User Authentication');
    expect(result.userStories).toHaveLength(1);
    expect(result.acceptanceCriteria).toContain('Users can log in');
    expect(result.outOfScope).toContain('Social login');
  });

  test('should generate spec ID from name', async () => {
    const mockResponse = JSON.stringify({
      name: 'My Cool Feature',
    });

    const llmClient = createMockLLMClient(mockResponse);
    const generator = new SpecificationGenerator({ llmClient });

    const result = await generator.generate({ prompt: 'test' });

    expect(result.id).toMatch(/^\d{3}-my-cool-feature$/);
  });
});

describe('PlanGenerator', () => {
  test('should generate implementation plan', async () => {
    const mockResponse = JSON.stringify({
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
          steps: ['Create package.json', 'Install deps'],
          estimatedHours: 2,
        },
      ],
    });

    const llmClient = createMockLLMClient(mockResponse);
    const generator = new PlanGenerator({ llmClient });

    const result = await generator.generate({
      specification: {
        id: '001-test',
        name: 'Test',
        description: '',
        userStories: [],
        acceptanceCriteria: [],
        outOfScope: [],
        rawContent: '# Test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      techStackPrompt: 'Use Node.js and Express',
    });

    expect(result.specId).toBe('001-test');
    expect(result.techStack?.runtime).toBe('Node.js 20');
    expect(result.phases).toHaveLength(1);
  });
});

describe('TaskGenerator', () => {
  test('should generate task breakdown', async () => {
    const mockResponse = JSON.stringify({
      tasks: [
        {
          id: 'task-001',
          title: 'Setup project',
          description: 'Initialize the project',
          filePaths: ['package.json'],
          dependencies: [],
          isParallel: false,
          testFirst: false,
        },
        {
          id: 'task-002',
          title: 'Create API',
          description: 'Create REST API',
          filePaths: ['src/api.ts'],
          dependencies: ['task-001'],
          isParallel: false,
          testFirst: true,
        },
      ],
      parallelGroups: [],
    });

    const llmClient = createMockLLMClient(mockResponse);
    const generator = new TaskGenerator({ llmClient });

    const result = await generator.generate({
      plan: {
        specId: '001-test',
        techStack: {},
        phases: [],
        rawContent: '# Plan',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]!.title).toBe('Setup project');
    expect(result.tasks[1]!.testFirst).toBe(true);
  });

  test('should validate task breakdown', () => {
    const llmClient = createMockLLMClient('{}');
    const generator = new TaskGenerator({ llmClient });

    // Valid breakdown
    const validResult = generator.validate({
      planId: 'test',
      tasks: [
        {
          id: 'task-001',
          title: 'Task 1',
          description: '',
          filePaths: ['file.ts'],
          dependencies: [],
          isParallel: false,
          testFirst: false,
          status: 'pending',
        },
      ],
      dependencies: [],
      parallelGroups: [],
      rawContent: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(validResult.valid).toBe(true);
    expect(validResult.errors).toHaveLength(0);
  });

  test('should detect duplicate task IDs', () => {
    const llmClient = createMockLLMClient('{}');
    const generator = new TaskGenerator({ llmClient });

    const result = generator.validate({
      planId: 'test',
      tasks: [
        {
          id: 'task-001',
          title: 'Task 1',
          description: '',
          filePaths: [],
          dependencies: [],
          isParallel: false,
          testFirst: false,
          status: 'pending',
        },
        {
          id: 'task-001', // Duplicate
          title: 'Task 2',
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
      rawContent: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate task ID: task-001');
  });

  test('should detect missing dependencies', () => {
    const llmClient = createMockLLMClient('{}');
    const generator = new TaskGenerator({ llmClient });

    const result = generator.validate({
      planId: 'test',
      tasks: [
        {
          id: 'task-001',
          title: 'Task 1',
          description: '',
          filePaths: [],
          dependencies: ['task-999'], // Non-existent
          isParallel: false,
          testFirst: false,
          status: 'pending',
        },
      ],
      dependencies: [],
      parallelGroups: [],
      rawContent: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('non-existent task');
  });
});

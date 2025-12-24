/**
 * Skill Learning Orchestration tests
 *
 * End-to-end tests for learnSkillFromTrajectory
 *
 * @module tests/skill-learning-orchestration.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  learnSkillFromTrajectory,
  loadSkills,
  type TrajectoryRecord,
  type ExecutionFeedback,
} from '../src/skills';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-skill-learn-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 创建 mock 轨迹记录
 */
function createMockTrajectory(): TrajectoryRecord[] {
  return [
    {
      id: 'thinking-1',
      type: 'thinking',
      stage: 'analysis',
      content: 'Analyzing the file structure to understand the codebase.',
      timestamp: Date.now() - 10000,
    },
    {
      id: 'action-1',
      type: 'action',
      content: 'Reading file src/index.ts',
      toolName: 'file_read',
      toolParams: { path: 'src/index.ts' },
      result: { success: true, output: 'File content here...' },
      timestamp: Date.now() - 8000,
    },
    {
      id: 'thinking-2',
      type: 'thinking',
      stage: 'planning',
      content: 'Based on the analysis, I will implement the feature step by step.',
      timestamp: Date.now() - 6000,
    },
    {
      id: 'action-2',
      type: 'action',
      content: 'Writing file src/feature.ts',
      toolName: 'file_write',
      toolParams: { path: 'src/feature.ts', content: 'export function feature() {}' },
      result: { success: true, output: 'File written successfully' },
      timestamp: Date.now() - 4000,
    },
    {
      id: 'thinking-3',
      type: 'thinking',
      stage: 'verification',
      content: 'Running tests to verify the implementation works correctly.',
      timestamp: Date.now() - 2000,
    },
  ];
}

/**
 * 创建 mock LLM 调用
 */
function createMockLlmCall() {
  return async (_prompt: string): Promise<string> => {
    return JSON.stringify({
      success: true,
      reasoningValid: true,
      reasoningSummary: 'The task was completed successfully using incremental development.',
      patterns: [
        {
          name: 'incremental-development',
          description: 'Breaking down the implementation into small, testable steps.',
          type: 'solution',
          confidence: 0.85,
          evidence: ['thinking-1', 'action-2'],
        },
        {
          name: 'file-verification',
          description: 'Always verify file contents after writing.',
          type: 'optimization',
          confidence: 0.8,
          evidence: ['thinking-3'],
        },
      ],
      failureModes: [],
      abstractableKnowledge: [
        'Break complex tasks into smaller steps.',
        'Verify changes immediately after making them.',
      ],
      suggestedSkillName: 'incremental-development',
      suggestedSkillDescription: 'Best practices for incremental software development.',
      suggestedTags: ['development', 'methodology', 'testing'],
    });
  };
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

// ============================================================================
// learnSkillFromTrajectory 测试
// ============================================================================

describe('learnSkillFromTrajectory', () => {
  test('successfully learns skill from trajectory', async () => {
    const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const result = await learnSkillFromTrajectory(createMockTrajectory(), {
      llmCall: createMockLlmCall(),
      skillsDir,
      taskDescription: 'Implement a new feature',
    });

    expect(result.success).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill?.name).toBe('incremental-development');
    expect(result.skill?.path).toContain('SKILL.md');
    expect(result.skill?.tags).toContain('development');

    // 验证文件已创建
    expect(fs.existsSync(result.skill?.path ?? '')).toBe(true);
  });

  test('includes feedback in learning process', async () => {
    const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const feedback: ExecutionFeedback = {
      success: true,
      userFeedback: 'Great implementation! The code is clean.',
    };

    const result = await learnSkillFromTrajectory(createMockTrajectory(), {
      llmCall: createMockLlmCall(),
      skillsDir,
      taskDescription: 'Implement a new feature',
      feedback,
    });

    expect(result.success).toBe(true);
    expect(result.skill).toBeDefined();
  });

  test('calls onSkillsRefresh callback after creation', async () => {
    const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    let refreshCalled = false;
    const result = await learnSkillFromTrajectory(createMockTrajectory(), {
      llmCall: createMockLlmCall(),
      skillsDir,
      taskDescription: 'Implement a new feature',
      onSkillsRefresh: async () => {
        refreshCalled = true;
      },
    });

    expect(result.success).toBe(true);
    expect(refreshCalled).toBe(true);
  });

  test('calls onBlockUpdate callback after creation', async () => {
    const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    let blockUpdateCalled = false;
    let updatedName = '';
    let updatedContent = '';

    const result = await learnSkillFromTrajectory(createMockTrajectory(), {
      llmCall: createMockLlmCall(),
      skillsDir,
      taskDescription: 'Implement a new feature',
      onBlockUpdate: async (name, content) => {
        blockUpdateCalled = true;
        updatedName = name;
        updatedContent = content;
      },
    });

    expect(result.success).toBe(true);
    expect(blockUpdateCalled).toBe(true);
    expect(updatedName).toBe('incremental-development');
    // content 是完整 SKILL.md（含 frontmatter + body），不是纯 body
    expect(updatedContent).toContain('skillType: knowledge');
  });

  test('succeeds even when onBlockUpdate throws error', async () => {
    const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const result = await learnSkillFromTrajectory(createMockTrajectory(), {
      llmCall: createMockLlmCall(),
      skillsDir,
      taskDescription: 'Implement a new feature',
      onBlockUpdate: async () => {
        throw new Error('Block update failed!');
      },
    });

    // 即使 onBlockUpdate 抛错，整体应该成功
    expect(result.success).toBe(true);
    expect(result.skill).toBeDefined();
  });

  test('fails gracefully when LLM call fails', async () => {
    const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const result = await learnSkillFromTrajectory(createMockTrajectory(), {
      llmCall: async () => {
        throw new Error('LLM API error');
      },
      skillsDir,
      taskDescription: 'Implement a new feature',
    });

    expect(result.success).toBe(false);
    expect(result.failedAt).toBe('reflection');
    expect(result.error).toContain('Reflection failed');
  });

  test('fails when reflection produces no learnable patterns', async () => {
    const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const emptyReflectionLlm = async (): Promise<string> => {
      return JSON.stringify({
        success: true,
        reasoningValid: true,
        reasoningSummary: 'Nothing special happened.',
        patterns: [],
        failureModes: [],
        abstractableKnowledge: [],
      });
    };

    const result = await learnSkillFromTrajectory(createMockTrajectory(), {
      llmCall: emptyReflectionLlm,
      skillsDir,
      taskDescription: 'Implement a new feature',
    });

    expect(result.success).toBe(false);
    expect(result.failedAt).toBe('reflection');
    expect(result.error).toContain('did not produce learnable patterns');
  });

  test('created skill can be loaded by skill loader', async () => {
    const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const result = await learnSkillFromTrajectory(createMockTrajectory(), {
      llmCall: createMockLlmCall(),
      skillsDir,
      taskDescription: 'Implement a new feature',
    });

    expect(result.success).toBe(true);

    // 验证可以被 loader 解析
    const outcome = loadSkills({ enabled: true }, tempDir);
    const createdSkill = outcome.skills.find((s) => s.name === 'incremental-development');

    expect(createdSkill).toBeDefined();
    expect(createdSkill?.skillType).toBe('knowledge');
  });

  test('includes user guidance in generated skill', async () => {
    const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const result = await learnSkillFromTrajectory(createMockTrajectory(), {
      llmCall: createMockLlmCall(),
      skillsDir,
      taskDescription: 'Implement a new feature',
      userGuidance: 'Remember to always run linting before commits.',
    });

    expect(result.success).toBe(true);

    // 验证技能内容包含用户指导
    const skillContent = fs.readFileSync(result.skill?.path ?? '', 'utf-8');
    expect(skillContent).toContain('always run linting');
  });
});

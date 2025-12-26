/**
 * Skills Loader - loadSkillsByScope 测试
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSkillsByScope, getSearchDirs } from './loader';

describe('loadSkillsByScope', () => {
  const testRoot = path.join(os.tmpdir(), `skills-test-${Date.now()}`);
  const skillsDir = path.join(testRoot, 'skills');

  beforeAll(() => {
    // 创建测试目录结构
    // skills/orchestrator/planning/test-skill/SKILL.md
    // skills/shared/common-skill/SKILL.md
    const orchestratorSkillDir = path.join(skillsDir, 'orchestrator', 'planning', 'task-decomposition');
    const sharedSkillDir = path.join(skillsDir, 'shared', 'common-patterns');
    
    fs.mkdirSync(orchestratorSkillDir, { recursive: true });
    fs.mkdirSync(sharedSkillDir, { recursive: true });

    // 创建 orchestrator skill
    fs.writeFileSync(
      path.join(orchestratorSkillDir, 'SKILL.md'),
      `---
name: task-decomposition
description: Decompose tasks into subtasks
skillType: knowledge
---

# Task Decomposition

Split complex tasks into smaller subtasks.
`
    );

    // 创建 shared skill
    fs.writeFileSync(
      path.join(sharedSkillDir, 'SKILL.md'),
      `---
name: common-patterns
description: Common coding patterns
skillType: knowledge
---

# Common Patterns

Reusable patterns for both orchestrator and workers.
`
    );
  });

  afterAll(() => {
    // 清理测试目录
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('should load skills from scope directory', () => {
    const outcome = loadSkillsByScope('orchestrator', {
      additionalDirs: [skillsDir],
    });

    expect(outcome.errors.length).toBe(0);
    expect(outcome.skills.length).toBeGreaterThanOrEqual(1);
    
    const taskSkill = outcome.skills.find(s => s.name === 'task-decomposition');
    expect(taskSkill).toBeDefined();
    expect(taskSkill?.skillType).toBe('knowledge');
  });

  test('should also load skills from shared directory', () => {
    const outcome = loadSkillsByScope('orchestrator', {
      additionalDirs: [skillsDir],
    });

    expect(outcome.errors.length).toBe(0);
    
    // Should include both orchestrator and shared skills
    const sharedSkill = outcome.skills.find(s => s.name === 'common-patterns');
    expect(sharedSkill).toBeDefined();
    expect(sharedSkill?.description).toContain('Common coding patterns');
  });

  test('should return empty when disabled', () => {
    const outcome = loadSkillsByScope('orchestrator', {
      enabled: false,
      additionalDirs: [skillsDir],
    });

    expect(outcome.skills.length).toBe(0);
    expect(outcome.errors.length).toBe(0);
  });

  test('getSearchDirs should include project skills directory', () => {
    const dirs = getSearchDirs({}, testRoot);
    
    // Should include: global, project/.tachikoma/skills, project/skills, node_modules/@tachikoma/skills
    expect(dirs.length).toBeGreaterThanOrEqual(1);
    expect(dirs.some(d => d.includes('skills'))).toBe(true);
  });
});

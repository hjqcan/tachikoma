/**
 * SkillsManager Loaded Skills Injection tests
 *
 * 验证：当用户通过 SkillBlockManager 加载了 loaded_skills 后，
 * SkillsManager.renderSystemPromptSection 会把它自动注入到 system prompt。
 *
 * @module tests/skills-manager-loaded-skills
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { getGlobalSkillBlockManager, resetGlobalSkillBlockManager } from '../src/skills';
import { SkillsManager } from '../src/worker/engines/skills-manager';

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-skills-manager-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  resetGlobalSkillBlockManager();
  tempDir = createTempDir();
});

afterEach(() => {
  cleanupTempDir(tempDir);
  resetGlobalSkillBlockManager();
});

describe('SkillsManager > loaded_skills injection', () => {
  test('injects loaded_skills in default mode (no autoActivate)', async () => {
    const blockManager = getGlobalSkillBlockManager();
    blockManager.loadSkill('test-skill', 'This is the loaded skill body.');

    const manager = new SkillsManager({ enabled: false }, tempDir);
    const prompt = await manager.renderSystemPromptSection('BASE_PROMPT');

    expect(prompt).toContain('BASE_PROMPT');
    expect(prompt).toContain('## Loaded Skills');
    expect(prompt).toContain('# Skill: test-skill');
    expect(prompt).toContain('This is the loaded skill body.');
  });

  test('injects loaded_skills in autoActivate mode (even when no skills discovered)', async () => {
    const blockManager = getGlobalSkillBlockManager();
    blockManager.loadSkill('manual-skill', 'Manually loaded content.');

    const manager = new SkillsManager({ enabled: false }, tempDir);
    const prompt = await manager.renderSystemPromptSection('BASE_PROMPT', 'Task description', {
      autoActivate: true,
      parentObjective: 'Parent objective',
    });

    expect(prompt).toContain('BASE_PROMPT');
    expect(prompt).toContain('## Loaded Skills');
    expect(prompt).toContain('# Skill: manual-skill');
    expect(prompt).toContain('Manually loaded content.');
  });
});



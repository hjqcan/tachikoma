/**
 * Skills module tests
 *
 * @module tests/skills.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  loadSkills,
  parseSkillFile,
  extractFrontmatter,
  loadSkillContent,
  renderSkillsSection,
  renderSkillContentPrompt,
  estimateSkillsSectionTokens,
  SKILL_FILENAME,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
} from '../src/skills';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-skills-test-'));
  return dir;
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createSkillFile(
  baseDir: string,
  skillName: string,
  content: string
): string {
  const skillDir = path.join(baseDir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, SKILL_FILENAME);
  fs.writeFileSync(skillPath, content, 'utf-8');
  return skillPath;
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

// ============================================================================
// extractFrontmatter 测试
// ============================================================================

describe('extractFrontmatter', () => {
  test('extracts valid frontmatter', () => {
    const content = `---
name: test-skill
description: A test skill
---

# Body content
`;
    const result = extractFrontmatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontmatter).toContain('name: test-skill');
    expect(result!.frontmatter).toContain('description: A test skill');
    expect(result!.body).toBe('# Body content');
  });

  test('returns null for missing opening delimiter', () => {
    const content = `name: test-skill
description: A test skill
---

# Body`;
    const result = extractFrontmatter(content);
    expect(result).toBeNull();
  });

  test('returns null for missing closing delimiter', () => {
    const content = `---
name: test-skill
description: A test skill

# Body`;
    const result = extractFrontmatter(content);
    expect(result).toBeNull();
  });

  test('returns null for empty frontmatter', () => {
    const content = `---
---

# Body`;
    const result = extractFrontmatter(content);
    expect(result).toBeNull();
  });

  test('handles multiline description', () => {
    const content = `---
name: test-skill
description: |-
  A multiline
  description here
---

# Body`;
    const result = extractFrontmatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontmatter).toContain('description: |-');
  });
});

// ============================================================================
// parseSkillFile 测试
// ============================================================================

describe('parseSkillFile', () => {
  test('parses valid skill file', () => {
    const content = `---
name: pdf-processing
description: Extract text and tables from PDFs
license: MIT
---

# PDF Processing

Use pdfplumber to extract text.
`;
    const skillPath = createSkillFile(tempDir, 'pdf-processing', content);
    const result = parseSkillFile(skillPath);

    expect('message' in result).toBe(false);
    const skill = result as { name: string; description: string; path: string };
    expect(skill.name).toBe('pdf-processing');
    expect(skill.description).toBe('Extract text and tables from PDFs');
    expect(skill.path).toContain('pdf-processing');
  });

  test('returns error for missing name', () => {
    const content = `---
description: A skill without name
---

# Body`;
    const skillPath = createSkillFile(tempDir, 'no-name', content);
    const result = parseSkillFile(skillPath);

    expect('message' in result).toBe(true);
    expect((result as { message: string }).message).toContain('name');
  });

  test('returns error for missing description', () => {
    const content = `---
name: no-description
---

# Body`;
    const skillPath = createSkillFile(tempDir, 'no-desc', content);
    const result = parseSkillFile(skillPath);

    expect('message' in result).toBe(true);
    expect((result as { message: string }).message).toContain('description');
  });

  test('returns error for name exceeding max length', () => {
    const longName = 'a'.repeat(MAX_NAME_LENGTH + 1);
    const content = `---
name: ${longName}
description: Test description
---

# Body`;
    const skillPath = createSkillFile(tempDir, 'long-name', content);
    const result = parseSkillFile(skillPath);

    expect('message' in result).toBe(true);
    expect((result as { message: string }).message).toContain('maximum length');
  });

  test('returns error for description exceeding max length', () => {
    const longDesc = 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1);
    const content = `---
name: long-desc
description: ${longDesc}
---

# Body`;
    const skillPath = createSkillFile(tempDir, 'long-desc', content);
    const result = parseSkillFile(skillPath);

    expect('message' in result).toBe(true);
    expect((result as { message: string }).message).toContain('maximum length');
  });

  test('handles quoted strings in YAML', () => {
    const content = `---
name: "quoted-name"
description: "A quoted description with: colons"
---

# Body`;
    const skillPath = createSkillFile(tempDir, 'quoted', content);
    const result = parseSkillFile(skillPath);

    expect('message' in result).toBe(false);
    const skill = result as { name: string; description: string };
    expect(skill.name).toBe('quoted-name');
    expect(skill.description).toBe('A quoted description with: colons');
  });

  test('normalizes multiline description to single line', () => {
    const content = `---
name: multiline
description: |-
  Line one
  Line two
  Line three
---

# Body`;
    const skillPath = createSkillFile(tempDir, 'multiline', content);
    const result = parseSkillFile(skillPath);

    expect('message' in result).toBe(false);
    const skill = result as { description: string };
    expect(skill.description).toBe('Line one Line two Line three');
  });
});

// ============================================================================
// loadSkills 测试
// ============================================================================

describe('loadSkills', () => {
  function loadSkillsIsolated(config: Parameters<typeof loadSkills>[0]) {
    // Ensure tests are not affected by user's real global skills directory (~/.tachikoma/skills).
    // Point globalDir to a temp path that doesn't exist so only additionalDirs are scanned.
    return loadSkills({
      globalDir: path.join(tempDir, '__global_skills__'),
      ...config,
    });
  }

  test('discovers skills in directory', () => {
    createSkillFile(
      tempDir,
      'skill-a',
      `---
name: skill-a
description: First skill
---
# A`
    );
    createSkillFile(
      tempDir,
      'skill-b',
      `---
name: skill-b
description: Second skill
---
# B`
    );

    const outcome = loadSkillsIsolated({ additionalDirs: [tempDir], enabled: true });

    expect(outcome.errors).toHaveLength(0);
    expect(outcome.skills).toHaveLength(2);
    expect(outcome.skills[0].name).toBe('skill-a');
    expect(outcome.skills[1].name).toBe('skill-b');
  });

  test('skips hidden directories', () => {
    const hiddenDir = path.join(tempDir, '.hidden');
    fs.mkdirSync(hiddenDir, { recursive: true });
    createSkillFile(
      hiddenDir,
      'hidden-skill',
      `---
name: hidden-skill
description: Should be skipped
---
# Hidden`
    );

    const outcome = loadSkillsIsolated({ additionalDirs: [tempDir], enabled: true });

    expect(outcome.skills).toHaveLength(0);
  });

  test('recursively discovers skills in subdirectories', () => {
    const subDir = path.join(tempDir, 'category', 'subcategory');
    fs.mkdirSync(subDir, { recursive: true });
    const skillDir = path.join(subDir, 'deep-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, SKILL_FILENAME),
      `---
name: deep-skill
description: A deeply nested skill
---
# Deep`
    );

    const outcome = loadSkillsIsolated({ additionalDirs: [tempDir], enabled: true });

    expect(outcome.skills).toHaveLength(1);
    expect(outcome.skills[0].name).toBe('deep-skill');
  });

  test('returns empty when disabled', () => {
    createSkillFile(
      tempDir,
      'skill',
      `---
name: skill
description: Test
---
# Content`
    );

    const outcome = loadSkillsIsolated({ additionalDirs: [tempDir], enabled: false });

    expect(outcome.skills).toHaveLength(0);
  });

  test('collects errors for invalid skills', () => {
    createSkillFile(tempDir, 'valid', `---
name: valid
description: Valid skill
---
# Valid`);
    createSkillFile(tempDir, 'invalid', `no frontmatter here`);

    const outcome = loadSkillsIsolated({ additionalDirs: [tempDir], enabled: true });

    expect(outcome.skills).toHaveLength(1);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].message).toContain('frontmatter');
  });

  test('handles non-existent directory gracefully', () => {
    const outcome = loadSkillsIsolated({
      additionalDirs: ['/non/existent/path'],
      enabled: true,
    });

    expect(outcome.skills).toHaveLength(0);
    expect(outcome.errors).toHaveLength(0);
  });
});

// ============================================================================
// renderSkillsSection 测试
// ============================================================================

describe('renderSkillsSection', () => {
  test('returns null for empty skills list', () => {
    const result = renderSkillsSection([]);
    expect(result).toBeNull();
  });

  test('renders skills section correctly', () => {
    const skills = [
      { name: 'pdf', description: 'Process PDFs', path: '/path/to/pdf/SKILL.md' },
      { name: 'docx', description: 'Process Word docs', path: '/path/to/docx/SKILL.md' },
    ];

    const result = renderSkillsSection(skills);

    expect(result).not.toBeNull();
    expect(result).toContain('## Skills');
    // Note: renderer no longer exposes absolute paths for security
    expect(result).toContain('- pdf: Process PDFs');
    expect(result).toContain('- docx: Process Word docs');
    // Path should NOT be in the output
    expect(result).not.toContain('/path/to/pdf/SKILL.md');
  });

  test('truncates skills when token budget exceeded', () => {
    const skills = Array.from({ length: 100 }, (_, i) => ({
      name: `skill-${i}`,
      description: 'A skill with a fairly long description to use up tokens',
      path: `/path/to/skill-${i}/SKILL.md`,
    }));

    // Use a small token budget
    const result = renderSkillsSection(skills, 200);

    expect(result).not.toBeNull();
    expect(result).toContain('## Skills');
    // Should have truncation message
    expect(result).toContain('more skills');
    // Should not contain all 100 skills
    const skillLines = result!.split('\n').filter(line => line.startsWith('- skill-'));
    expect(skillLines.length).toBeLessThan(100);
  });
});

// ============================================================================
// renderSkillContentPrompt 测试
// ============================================================================

describe('renderSkillContentPrompt', () => {
  test('renders skill content prompt', () => {
    const result = renderSkillContentPrompt('pdf', '# PDF Processing\n\nInstructions here.');

    expect(result).toContain('## Skill: pdf');
    expect(result).toContain('# PDF Processing');
    expect(result).toContain('Instructions here.');
  });
});

// ============================================================================
// estimateSkillsSectionTokens 测试
// ============================================================================

describe('estimateSkillsSectionTokens', () => {
  test('returns 0 for empty skills list', () => {
    const result = estimateSkillsSectionTokens([]);
    expect(result).toBe(0);
  });

  test('estimates tokens for skills list', () => {
    const skills = [
      { name: 'pdf', description: 'Process PDFs', path: '/path/to/pdf/SKILL.md' },
    ];

    const result = estimateSkillsSectionTokens(skills);

    expect(result).toBeGreaterThan(50); // Base overhead
    expect(result).toBeLessThan(200); // Reasonable upper bound
  });
});

// ============================================================================
// loadSkillContent 测试
// ============================================================================

describe('loadSkillContent', () => {
  test('loads skill content with body and resources', async () => {
    const skillDir = path.join(tempDir, 'full-skill');
    fs.mkdirSync(skillDir, { recursive: true });

    // Create SKILL.md
    fs.writeFileSync(
      path.join(skillDir, SKILL_FILENAME),
      `---
name: full-skill
description: A complete skill
---

# Full Skill

## Instructions

Do something useful.
`
    );

    // Create resource file
    fs.writeFileSync(path.join(skillDir, 'reference.md'), '# Reference\n\nExtra docs.');

    // Create scripts directory
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'main.py'), 'print("hello")');

    const metadata = {
      name: 'full-skill',
      description: 'A complete skill',
      path: path.join(skillDir, SKILL_FILENAME),
    };

    const content = await loadSkillContent(metadata);

    expect(content.name).toBe('full-skill');
    expect(content.body).toContain('# Full Skill');
    expect(content.body).toContain('Do something useful.');
    expect(content.resources).toHaveLength(1);
    expect(content.resources[0]).toContain('reference.md');
    expect(content.scriptsDir).toBeDefined();
    expect(content.scriptsDir).toContain('scripts');
  });

  test('handles skill without scripts directory', async () => {
    const skillDir = path.join(tempDir, 'no-scripts');
    fs.mkdirSync(skillDir, { recursive: true });

    fs.writeFileSync(
      path.join(skillDir, SKILL_FILENAME),
      `---
name: no-scripts
description: No scripts
---

# Content`
    );

    const metadata = {
      name: 'no-scripts',
      description: 'No scripts',
      path: path.join(skillDir, SKILL_FILENAME),
    };

    const content = await loadSkillContent(metadata);

    expect(content.scriptsDir).toBeUndefined();
    expect(content.resources).toHaveLength(0);
  });
});

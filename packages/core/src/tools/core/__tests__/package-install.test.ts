/**
 * package_install 工具辅助函数测试
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInstallCommand, findProjectRoot, resolvePackageManager } from '../package-install';

describe('package_install helpers', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `tachikoma-package-install-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('findProjectRoot should locate nearest project root', async () => {
    const root = join(testDir, 'root');
    const nested = join(root, 'apps', 'web');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"test"}');

    const resolved = findProjectRoot(nested, root);
    expect(resolved).toBe(root);
  });

  it('resolvePackageManager should prefer lockfiles', async () => {
    const root = join(testDir, 'pnpm-project');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4');

    const result = resolvePackageManager(root, 'auto');
    expect(result.manager).toBe('pnpm');
  });

  it('resolvePackageManager should fallback to npm without lockfiles', async () => {
    const root = join(testDir, 'no-lock');
    await mkdir(root, { recursive: true });

    const result = resolvePackageManager(root, 'auto');
    expect(result.manager).toBe('npm');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('buildInstallCommand should build add commands with dev flag', () => {
    const cmd = buildInstallCommand('npm', ['react', 'react-dom'], true, []);
    expect(cmd).toBe('npm install -D react react-dom');
  });

  it('buildInstallCommand should build install command when packages empty', () => {
    const cmd = buildInstallCommand('yarn', [], false, []);
    expect(cmd).toBe('yarn install');
  });

  it('buildInstallCommand should append extra args', () => {
    const cmd = buildInstallCommand('pnpm', ['vite'], false, ['--frozen-lockfile']);
    expect(cmd).toBe('pnpm add vite --frozen-lockfile');
  });
});

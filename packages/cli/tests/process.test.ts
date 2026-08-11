import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const entrypoint = resolve(root, 'packages/cli/src/cli.ts');

async function run(
  args: readonly string[]
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const process = Bun.spawn([Bun.which('bun') ?? 'bun', entrypoint, ...args], {
    cwd: root,
    env: {
      PATH: Bun.env.PATH,
      ANTHROPIC_API_KEY: 'poison-offline-key',
      OPENAI_API_KEY: 'poison-offline-key',
      OPENROUTER_API_KEY: 'poison-offline-key',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe('CLI process', () => {
  test('prints help without touching a provider', async () => {
    const result = await run(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('tachikoma run');
  });

  test('prints the package version', async () => {
    const result = await run(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('Tachikoma 0.2.0\n');
  });
});

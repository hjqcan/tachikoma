import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../../..');
const entrypoint = resolve(root, 'packages/cli/dist/cli.js');
const fauxPreload = resolve(root, 'packages/core/tests/cli-faux-preload.ts');
const compactionPrompt = 'context '.repeat(12_000);
const temporaryDirectories: string[] = [];

interface ProcessResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'tachikoma-cli-dist-'));
  temporaryDirectories.push(directory);
  return directory;
}

function processEnvironment(dataDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    TACHIKOMA_DATA_DIR: dataDir,
    TACHIKOMA_PROVIDER: 'anthropic',
    TACHIKOMA_MODEL: 'claude-sonnet-5',
    TACHIKOMA_RUN_LIVE_TESTS: '0',
    ANTHROPIC_API_KEY: 'poison-offline-credential',
    OPENAI_API_KEY: 'poison-offline-credential',
    OPENROUTER_API_KEY: 'poison-offline-credential',
  };
}

async function runCli(
  args: readonly string[],
  options: { dataDir: string; faux?: boolean; input?: string }
): Promise<ProcessResult> {
  const command = [Bun.which('bun') ?? 'bun'];
  if (options.faux) command.push('--preload', fauxPreload);
  command.push(entrypoint, ...args);
  const child = Bun.spawn(command, {
    cwd: root,
    env: processEnvironment(options.dataDir),
    stdin: options.input === undefined ? 'ignore' : 'pipe',
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (options.input !== undefined) {
    child.stdin!.write(options.input);
    child.stdin!.end();
  }
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

function persistedFauxSessionId(stdout: string): string {
  const match = stdout.match(/^(\S+)\s{2}tachikoma-cli-faux\/chat\s{2}\d+ messages$/m);
  if (!match?.[1]) throw new Error(`Faux session missing from /sessions output:\n${stdout}`);
  return match[1];
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe('built CLI', () => {
  test('runs default chat, model, thinking, and compact commands offline', async () => {
    const dataDir = await temporaryDataDir();
    const first = await runCli([], {
      dataDir,
      input: '/model\n/thinking high\n/compact keep decisions\n/exit\n',
    });

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('[model] anthropic/claude-sonnet-5');
    expect(first.stdout).toContain('[thinking] high');
    expect(first.stderr).toContain('Nothing to compact');
  });

  test('returns stable help, version, usage, and runtime failure codes', async () => {
    const dataDir = await temporaryDataDir();
    expect((await runCli(['--help'], { dataDir })).exitCode).toBe(0);
    expect((await runCli(['--version'], { dataDir })).stdout).toBe('Tachikoma 0.2.0\n');
    expect((await runCli(['run'], { dataDir })).exitCode).toBe(2);
    expect(
      (
        await runCli(
          ['run', '--provider', 'missing', '--model', 'missing', '--no-memory', 'hello'],
          { dataDir }
        )
      ).exitCode
    ).toBe(1);
  });

  test('runs, resumes, and compacts a persisted session through the built binary', async () => {
    const dataDir = await temporaryDataDir();
    const result = await runCli(
      [
        'run',
        '--provider',
        'tachikoma-cli-faux',
        '--model',
        'chat',
        '--no-memory',
        compactionPrompt,
      ],
      { dataDir, faux: true }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('[memory:session_start] disabled\n');
    expect(result.stdout).toBe('tachikoma-dist-run-ok\n');

    const listed = await runCli(
      ['chat', '--provider', 'tachikoma-cli-faux', '--model', 'chat', '--no-memory'],
      { dataDir, faux: true, input: '/sessions\n/exit\n' }
    );
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toBe('');
    const sessionId = persistedFauxSessionId(listed.stdout);

    const continued = await runCli(
      [
        'run',
        '--resume',
        sessionId,
        '--provider',
        'tachikoma-cli-faux',
        '--model',
        'chat',
        '--no-memory',
        compactionPrompt,
      ],
      { dataDir, faux: true }
    );
    expect(continued.exitCode).toBe(0);
    expect(continued.stderr).toBe('[memory:session_start] disabled\n');
    expect(continued.stdout).toBe('tachikoma-dist-run-ok\n');

    const compacted = await runCli(
      [
        'chat',
        '--resume',
        sessionId,
        '--provider',
        'tachikoma-cli-faux',
        '--model',
        'chat',
        '--no-memory',
      ],
      { dataDir, faux: true, input: '/compact keep decisions\n/exit\n' }
    );
    expect(compacted.exitCode).toBe(0);
    expect(compacted.stderr).toBe('');
    expect(compacted.stdout).toContain(`[session] ${sessionId}`);
    expect(compacted.stdout).toContain('[compaction] complete');
  });

  test('turns SIGINT into a graceful 130 exit', async () => {
    const dataDir = await temporaryDataDir();
    const child = Bun.spawn([Bun.which('bun') ?? 'bun', entrypoint, 'chat', '--no-memory'], {
      cwd: root,
      env: processEnvironment(dataDir),
      stdin: 'pipe',
      stderr: 'pipe',
      stdout: 'pipe',
    });
    await Bun.sleep(1000);
    child.kill('SIGINT');
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).toBe(130);
    expect(stderr).toBe('');
    expect(stdout).toContain('[session]');
  });

  test('imports both built package exports in a fresh process', async () => {
    const child = Bun.spawn(
      [
        Bun.which('bun') ?? 'bun',
        '--eval',
        "const core = await import('./packages/core/dist/index.js'); const cli = await import('./packages/cli/dist/index.js'); console.log(JSON.stringify({core:Object.keys(core).sort(),cli:Object.keys(cli).sort()}));",
      ],
      { cwd: root, stderr: 'pipe', stdout: 'pipe' }
    );
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      core: [
        'CHAT_THINKING_LEVELS',
        'ChatEngine',
        'VERSION',
        'buildChatSystemPrompt',
        'mergePresetConfig',
        'readPromptFile',
        'resolvePreset',
      ],
      cli: ['VERSION', 'runCli'],
    });
  });
});

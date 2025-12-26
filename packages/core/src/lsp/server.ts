import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export interface LspServerHandle {
  process: ChildProcessWithoutNullStreams;
  initialization?: Record<string, unknown>;
}

export type RootResolver = (filePath: string, workDir: string) => Promise<string | undefined>;

export interface LspServerInfo {
  id: string;
  extensions: string[];
  root: RootResolver;
  spawn: (root: string, workDir: string, env: Record<string, string>) => Promise<LspServerHandle | undefined>;
}

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.cmd', '.exe', '.bat', ''];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(base: string): string[] {
  if (process.platform !== 'win32') return [base];
  return WINDOWS_EXECUTABLE_EXTENSIONS.map((ext) => `${base}${ext}`);
}

async function resolveLocalBin(root: string, name: string): Promise<string | null> {
  const binDir = path.join(root, 'node_modules', '.bin');
  for (const candidate of pathCandidates(path.join(binDir, name))) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function resolveBinary(
  name: string,
  root: string,
  env: Record<string, string>
): Promise<string | null> {
  const local = await resolveLocalBin(root, name);
  if (local) return local;

  const envPath = env.PATH ?? process.env.PATH ?? '';
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of pathCandidates(path.join(dir, name))) {
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

async function findUp(startDir: string, stopDir: string, targets: string[]): Promise<string | undefined> {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);

  while (true) {
    for (const target of targets) {
      const candidate = path.join(current, target);
      if (await fileExists(candidate)) return candidate;
    }

    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

function createNearestRoot(options: {
  include: string[];
  exclude?: string[];
  fallbackToWorkDir?: boolean;
}): RootResolver {
  return async (filePath, workDir) => {
    const startDir = path.dirname(filePath);
    if (options.exclude?.length) {
      const excluded = await findUp(startDir, workDir, options.exclude);
      if (excluded) return undefined;
    }

    const match = await findUp(startDir, workDir, options.include);
    if (match) return path.dirname(match);
    return options.fallbackToWorkDir ? workDir : undefined;
  };
}

async function resolveTypescriptServer(root: string): Promise<string | null> {
  const candidate = path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js');
  return (await fileExists(candidate)) ? candidate : null;
}

export function getDefaultServers(): Record<string, LspServerInfo> {
  const typescriptRoot = createNearestRoot({
    include: [
      'tsconfig.json',
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'bun.lock',
    ],
    exclude: ['deno.json', 'deno.jsonc'],
    fallbackToWorkDir: true,
  });

  const denoRoot = createNearestRoot({
    include: ['deno.json', 'deno.jsonc'],
    fallbackToWorkDir: false,
  });

  const pyrightRoot = createNearestRoot({
    include: [
      'pyproject.toml',
      'pyrightconfig.json',
      'setup.cfg',
      'setup.py',
      'requirements.txt',
    ],
    fallbackToWorkDir: true,
  });

  const rustRoot = createNearestRoot({
    include: ['Cargo.toml'],
    fallbackToWorkDir: false,
  });

  const goRoot = createNearestRoot({
    include: ['go.mod'],
    fallbackToWorkDir: false,
  });

  return {
    typescript: {
      id: 'typescript',
      root: typescriptRoot,
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
      async spawn(root, _workDir, env) {
        const command = await resolveBinary('typescript-language-server', root, env);
        if (!command) return undefined;

        const tsserverPath = await resolveTypescriptServer(root);
        const args: string[] = [];
        if (tsserverPath) {
          args.push('--tsserver-path', tsserverPath);
        }
        args.push('--stdio');

        return {
          process: spawn(command, args, {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
      },
    },
    deno: {
      id: 'deno',
      root: denoRoot,
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
      async spawn(root, _workDir, env) {
        const command = await resolveBinary('deno', root, env);
        if (!command) return undefined;

        return {
          process: spawn(command, ['lsp'], {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
      },
    },
    pyright: {
      id: 'pyright',
      root: pyrightRoot,
      extensions: ['.py'],
      async spawn(root, _workDir, env) {
        const command = await resolveBinary('pyright-langserver', root, env);
        if (!command) return undefined;

        return {
          process: spawn(command, ['--stdio'], {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
      },
    },
    rust: {
      id: 'rust',
      root: rustRoot,
      extensions: ['.rs'],
      async spawn(root, _workDir, env) {
        const command = await resolveBinary('rust-analyzer', root, env);
        if (!command) return undefined;

        return {
          process: spawn(command, ['--stdio'], {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
      },
    },
    go: {
      id: 'go',
      root: goRoot,
      extensions: ['.go'],
      async spawn(root, _workDir, env) {
        const command = await resolveBinary('gopls', root, env);
        if (!command) return undefined;

        return {
          process: spawn(command, ['serve'], {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
      },
    },
  };
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, readdir, rm, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

/**
 * Detect Python virtual environment and resolve pythonPath for LSP initialization.
 * Checks VIRTUAL_ENV env var first, then .venv and venv directories in project root.
 */
async function detectPythonVenv(
  root: string,
  env: Record<string, string>
): Promise<{ pythonPath?: string; venvBinDir?: string }> {
  const isWindows = process.platform === 'win32';
  const pythonBin = isWindows ? 'python.exe' : 'python';
  const binSubdir = isWindows ? 'Scripts' : 'bin';

  const potentialVenvPaths = [
    env.VIRTUAL_ENV ?? process.env.VIRTUAL_ENV,
    path.join(root, '.venv'),
    path.join(root, 'venv'),
  ].filter((p): p is string => p !== undefined && p.length > 0);

  for (const venvPath of potentialVenvPaths) {
    const binDir = path.join(venvPath, binSubdir);
    const pythonPath = path.join(binDir, pythonBin);
    if (await fileExists(pythonPath)) {
      return { pythonPath, venvBinDir: binDir };
    }
  }

  return {};
}

/**
 * Try to resolve a binary from venv first, then fall back to PATH.
 */
async function resolvePythonToolBinary(
  name: string,
  root: string,
  env: Record<string, string>
): Promise<{ binary: string | null; pythonPath: string | undefined }> {
  const venv = await detectPythonVenv(root, env);

  // Check venv bin directory first
  if (venv.venvBinDir) {
    const isWindows = process.platform === 'win32';
    const ext = isWindows ? '.exe' : '';
    const candidate = path.join(venv.venvBinDir, name + ext);
    if (await fileExists(candidate)) {
      return { binary: candidate, pythonPath: venv.pythonPath };
    }
  }

  // Fall back to PATH resolution
  const binary = await resolveBinary(name, root, env);
  return { binary, pythonPath: venv.pythonPath };
}

function matchesPattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const parts = pattern.split('*');
  const prefix = parts[0] ?? '';
  const suffix = parts[1] ?? '';
  if (prefix && !name.startsWith(prefix)) return false;
  if (suffix && !name.endsWith(suffix)) return false;
  return name.length >= prefix.length + suffix.length;
}

async function findUp(startDir: string, stopDir: string, targets: string[]): Promise<string | undefined> {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  const literalTargets = targets.filter((target) => !target.includes('*'));
  const wildcardTargets = targets.filter((target) => target.includes('*'));

  while (true) {
    for (const target of literalTargets) {
      const candidate = path.join(current, target);
      if (await fileExists(candidate)) return candidate;
    }

    if (wildcardTargets.length > 0) {
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        for (const target of wildcardTargets) {
          if (matchesPattern(entry.name, target)) {
            return path.join(current, entry.name);
          }
        }
      }
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

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function isDownloadDisabled(env: Record<string, string>): boolean {
  const value = env.TACHIKOMA_LSP_DISABLE_DOWNLOAD ?? env.TACHIKOMA_DISABLE_LSP_DOWNLOAD;
  return isTruthy(value);
}

function getLspCacheDir(env: Record<string, string>, workDir: string): string {
  const override = env.TACHIKOMA_LSP_CACHE_DIR;
  if (override) return path.isAbsolute(override) ? override : path.join(workDir, override);
  return path.join(os.homedir(), '.tachikoma', 'lsp');
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> }
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function extractZip(archivePath: string, destDir: string, env: Record<string, string>, workDir: string) {
  const unzip = await resolveBinary('unzip', workDir, env);
  if (unzip) {
    return runCommand(unzip, ['-q', archivePath, '-d', destDir], { cwd: destDir, env });
  }
  const tar = await resolveBinary('tar', workDir, env);
  if (tar) {
    return runCommand(tar, ['-xf', archivePath, '-C', destDir], { cwd: destDir, env });
  }
  return false;
}

function isNodeRuntime(runtimePath: string): boolean {
  const base = path.basename(runtimePath).toLowerCase();
  return base === 'node' || base === 'node.exe';
}

function safeDirName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function ensureEslintServer(root: string, workDir: string, env: Record<string, string>): Promise<string | null> {
  const eslintBinary = await resolveBinary('eslint', root, env);
  if (!eslintBinary) return null;

  const cacheDir = getLspCacheDir(env, workDir);
  const serverPath = path.join(cacheDir, 'vscode-eslint', 'server', 'out', 'eslintServer.js');
  if (await fileExists(serverPath)) return serverPath;
  if (isDownloadDisabled(env)) return null;
  if (typeof fetch !== 'function') return null;

  await mkdir(cacheDir, { recursive: true });

  const archiveUrl = 'https://github.com/microsoft/vscode-eslint/archive/refs/heads/main.zip';
  const archivePath = path.join(cacheDir, 'vscode-eslint.zip');
  const response = await fetch(archiveUrl);
  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(archivePath, buffer);

  const extracted = await extractZip(archivePath, cacheDir, env, workDir);
  await rm(archivePath, { force: true });
  if (!extracted) return null;

  const extractedPath = path.join(cacheDir, 'vscode-eslint-main');
  const finalPath = path.join(cacheDir, 'vscode-eslint');
  await rm(finalPath, { recursive: true, force: true });
  if (!(await fileExists(extractedPath))) return null;
  await rename(extractedPath, finalPath);

  const npm = await resolveBinary('npm', root, env);
  if (!npm) return null;

  const installOk = await runCommand(npm, ['install'], { cwd: finalPath, env });
  if (!installOk) return null;
  const buildOk = await runCommand(npm, ['run', 'compile'], { cwd: finalPath, env });
  if (!buildOk) return null;

  return (await fileExists(serverPath)) ? serverPath : null;
}

async function spawnBinaryServer(
  commandName: string,
  args: string[],
  root: string,
  env: Record<string, string>
): Promise<LspServerHandle | undefined> {
  const command = await resolveBinary(commandName, root, env);
  if (!command) return undefined;
  return {
    process: spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
    }),
  };
}

export function getDefaultServers(): Record<string, LspServerInfo> {
  const nodeProjectMarkers = [
    'package-lock.json',
    'bun.lockb',
    'bun.lock',
    'pnpm-lock.yaml',
    'yarn.lock',
    'package.json',
  ];

  const typescriptRoot = createNearestRoot({
    include: nodeProjectMarkers,
    exclude: ['deno.json', 'deno.jsonc'],
    fallbackToWorkDir: true,
  });

  const nodeRoot = createNearestRoot({
    include: nodeProjectMarkers,
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
      'Pipfile',
    ],
    fallbackToWorkDir: true,
  });

  const tyRoot = createNearestRoot({
    include: [
      'pyproject.toml',
      'ty.toml',
      'setup.py',
      'setup.cfg',
      'requirements.txt',
      'Pipfile',
      'pyrightconfig.json',
    ],
    fallbackToWorkDir: true,
  });

  const rustRoot = createNearestRoot({
    include: ['Cargo.toml', 'Cargo.lock'],
    fallbackToWorkDir: false,
  });

  const goWorkRoot = createNearestRoot({
    include: ['go.work'],
    fallbackToWorkDir: false,
  });

  const goModuleRoot = createNearestRoot({
    include: ['go.mod', 'go.sum'],
    fallbackToWorkDir: false,
  });

  const goRoot: RootResolver = async (filePath, workDir) => {
    const work = await goWorkRoot(filePath, workDir);
    if (work) return work;
    return goModuleRoot(filePath, workDir);
  };

  const rubyRoot = createNearestRoot({
    include: ['Gemfile'],
    fallbackToWorkDir: true,
  });

  const elixirRoot = createNearestRoot({
    include: ['mix.exs', 'mix.lock'],
    fallbackToWorkDir: true,
  });

  const zlsRoot = createNearestRoot({
    include: ['build.zig'],
    fallbackToWorkDir: true,
  });

  const dotnetRoot = createNearestRoot({
    include: ['.sln', '.csproj', 'global.json'],
    fallbackToWorkDir: true,
  });

  const fsharpRoot = createNearestRoot({
    include: ['.sln', '.fsproj', 'global.json'],
    fallbackToWorkDir: true,
  });

  const sourceKitRoot = createNearestRoot({
    include: ['Package.swift', '*.xcodeproj', '*.xcworkspace'],
    fallbackToWorkDir: true,
  });

  const clangRoot = createNearestRoot({
    include: ['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt', 'Makefile'],
    fallbackToWorkDir: true,
  });

  const javaRoot = createNearestRoot({
    include: ['pom.xml', 'build.gradle', 'build.gradle.kts', '.project', '.classpath'],
    fallbackToWorkDir: true,
  });

  const luaRoot = createNearestRoot({
    include: ['.luarc.json', '.luarc.jsonc', '.luacheckrc', '.stylua.toml', 'stylua.toml', 'selene.toml', 'selene.yml'],
    fallbackToWorkDir: true,
  });

  const phpRoot = createNearestRoot({
    include: ['composer.json', 'composer.lock', '.php-version'],
    fallbackToWorkDir: true,
  });

  const dartRoot = createNearestRoot({
    include: ['pubspec.yaml', 'analysis_options.yaml'],
    fallbackToWorkDir: true,
  });

  const ocamlRoot = createNearestRoot({
    include: ['dune-project', 'dune-workspace', '.merlin', 'opam'],
    fallbackToWorkDir: true,
  });

  const terraformRoot = createNearestRoot({
    include: ['.terraform.lock.hcl', 'terraform.tfstate', '*.tf'],
    fallbackToWorkDir: true,
  });

  const texlabRoot = createNearestRoot({
    include: ['.latexmkrc', 'latexmkrc', '.texlabroot', 'texlabroot'],
    fallbackToWorkDir: true,
  });

  const gleamRoot = createNearestRoot({
    include: ['gleam.toml'],
    fallbackToWorkDir: true,
  });

  const clojureRoot = createNearestRoot({
    include: ['deps.edn', 'project.clj', 'shadow-cljs.edn', 'bb.edn', 'build.boot'],
    fallbackToWorkDir: true,
  });

  const nixRoot: RootResolver = async (filePath, workDir) => {
    const flake = await createNearestRoot({
      include: ['flake.nix'],
      fallbackToWorkDir: false,
    })(filePath, workDir);
    return flake ?? workDir;
  };

  const tinymistRoot = createNearestRoot({
    include: ['typst.toml'],
    fallbackToWorkDir: true,
  });

  const biomeRoot = createNearestRoot({
    include: ['biome.json', 'biome.jsonc', ...nodeProjectMarkers],
    fallbackToWorkDir: true,
  });

  const oxlintRoot = createNearestRoot({
    include: ['.oxlintrc.json', ...nodeProjectMarkers],
    fallbackToWorkDir: true,
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
        return spawnBinaryServer('deno', ['lsp'], root, env);
      },
    },
    vue: {
      id: 'vue',
      root: nodeRoot,
      extensions: ['.vue'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('vue-language-server', ['--stdio'], root, env);
      },
    },
    eslint: {
      id: 'eslint',
      root: nodeRoot,
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue'],
      async spawn(root, workDir, env) {
        const serverPath = await ensureEslintServer(root, workDir, env);
        if (!serverPath) return undefined;

        const runtime = (await resolveBinary('node', root, env)) ?? process.execPath;
        const args = isNodeRuntime(runtime)
          ? ['--max-old-space-size=8192', serverPath, '--stdio']
          : [serverPath, '--stdio'];

        return {
          process: spawn(runtime, args, {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
      },
    },
    oxlint: {
      id: 'oxlint',
      root: oxlintRoot,
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.astro', '.svelte'],
      async spawn(root, _workDir, env) {
        const server = await resolveBinary('oxc_language_server', root, env);
        if (server) {
          return {
            process: spawn(server, [], {
              cwd: root,
              env: { ...process.env, ...env },
            }),
          };
        }
        return spawnBinaryServer('oxlint', ['--lsp'], root, env);
      },
    },
    biome: {
      id: 'biome',
      root: biomeRoot,
      extensions: [
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.mts',
        '.cts',
        '.json',
        '.jsonc',
        '.vue',
        '.astro',
        '.svelte',
        '.css',
        '.graphql',
        '.gql',
        '.html',
      ],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('biome', ['lsp-proxy', '--stdio'], root, env);
      },
    },
    gopls: {
      id: 'gopls',
      root: goRoot,
      extensions: ['.go'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('gopls', ['serve'], root, env);
      },
    },
    'ruby-lsp': {
      id: 'ruby-lsp',
      root: rubyRoot,
      extensions: ['.rb', '.rake', '.gemspec', '.ru'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('rubocop', ['--lsp'], root, env);
      },
    },
    ty: {
      id: 'ty',
      root: tyRoot,
      extensions: ['.py', '.pyi'],
      async spawn(root, _workDir, env) {
        const { binary, pythonPath } = await resolvePythonToolBinary('ty', root, env);
        if (!binary) return undefined;

        const handle: LspServerHandle = {
          process: spawn(binary, ['server'], {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
        if (pythonPath) {
          handle.initialization = { pythonPath };
        }
        return handle;
      },
    },
    pyright: {
      id: 'pyright',
      root: pyrightRoot,
      extensions: ['.py', '.pyi'],
      async spawn(root, _workDir, env) {
        const { binary, pythonPath } = await resolvePythonToolBinary('pyright-langserver', root, env);
        if (!binary) return undefined;

        const handle: LspServerHandle = {
          process: spawn(binary, ['--stdio'], {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
        if (pythonPath) {
          handle.initialization = { pythonPath };
        }
        return handle;
      },
    },
    'elixir-ls': {
      id: 'elixir-ls',
      root: elixirRoot,
      extensions: ['.ex', '.exs'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('elixir-ls', [], root, env);
      },
    },
    zls: {
      id: 'zls',
      root: zlsRoot,
      extensions: ['.zig', '.zon'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('zls', [], root, env);
      },
    },
    csharp: {
      id: 'csharp',
      root: dotnetRoot,
      extensions: ['.cs'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('csharp-ls', [], root, env);
      },
    },
    fsharp: {
      id: 'fsharp',
      root: fsharpRoot,
      extensions: ['.fs', '.fsi', '.fsx', '.fsscript'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('fsautocomplete', [], root, env);
      },
    },
    'sourcekit-lsp': {
      id: 'sourcekit-lsp',
      root: sourceKitRoot,
      extensions: ['.swift', '.m', '.mm', '.objc'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('sourcekit-lsp', [], root, env);
      },
    },
    rust: {
      id: 'rust',
      root: rustRoot,
      extensions: ['.rs'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('rust-analyzer', [], root, env);
      },
    },
    clangd: {
      id: 'clangd',
      root: clangRoot,
      extensions: ['.c', '.cpp', '.cc', '.cxx', '.c++', '.h', '.hpp', '.hh', '.hxx', '.h++'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('clangd', ['--background-index', '--clang-tidy'], root, env);
      },
    },
    svelte: {
      id: 'svelte',
      root: nodeRoot,
      extensions: ['.svelte'],
      async spawn(root, _workDir, env) {
        const server = (await resolveBinary('svelteserver', root, env))
          ?? (await resolveBinary('svelte-language-server', root, env));
        if (!server) return undefined;
        return {
          process: spawn(server, ['--stdio'], {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
      },
    },
    astro: {
      id: 'astro',
      root: nodeRoot,
      extensions: ['.astro'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('astro-ls', ['--stdio'], root, env);
      },
    },
    jdtls: {
      id: 'jdtls',
      root: javaRoot,
      extensions: ['.java'],
      async spawn(root, workDir, env) {
        const command = await resolveBinary('jdtls', root, env);
        if (!command) return undefined;
        const dataRoot = path.join(getLspCacheDir(env, workDir), 'jdtls');
        await mkdir(dataRoot, { recursive: true });
        const dataDir = path.join(dataRoot, safeDirName(root));
        return {
          process: spawn(command, ['-data', dataDir], {
            cwd: root,
            env: { ...process.env, ...env },
          }),
        };
      },
    },
    'yaml-ls': {
      id: 'yaml-ls',
      root: nodeRoot,
      extensions: ['.yaml', '.yml'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('yaml-language-server', ['--stdio'], root, env);
      },
    },
    'lua-ls': {
      id: 'lua-ls',
      root: luaRoot,
      extensions: ['.lua'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('lua-language-server', [], root, env);
      },
    },
    'php intelephense': {
      id: 'php intelephense',
      root: phpRoot,
      extensions: ['.php'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('intelephense', ['--stdio'], root, env);
      },
    },
    dart: {
      id: 'dart',
      root: dartRoot,
      extensions: ['.dart'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('dart', ['language-server', '--lsp'], root, env);
      },
    },
    'ocaml-lsp': {
      id: 'ocaml-lsp',
      root: ocamlRoot,
      extensions: ['.ml', '.mli'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('ocamllsp', [], root, env);
      },
    },
    bash: {
      id: 'bash',
      root: async (_file, workDir) => workDir,
      extensions: ['.sh', '.bash', '.zsh', '.ksh'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('bash-language-server', ['start'], root, env);
      },
    },
    terraform: {
      id: 'terraform',
      root: terraformRoot,
      extensions: ['.tf', '.tfvars'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('terraform-ls', ['serve'], root, env);
      },
    },
    texlab: {
      id: 'texlab',
      root: texlabRoot,
      extensions: ['.tex', '.bib'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('texlab', [], root, env);
      },
    },
    dockerfile: {
      id: 'dockerfile',
      root: async (_file, workDir) => workDir,
      extensions: ['.dockerfile', 'Dockerfile'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('docker-langserver', ['--stdio'], root, env);
      },
    },
    gleam: {
      id: 'gleam',
      root: gleamRoot,
      extensions: ['.gleam'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('gleam', ['lsp'], root, env);
      },
    },
    'clojure-lsp': {
      id: 'clojure-lsp',
      root: clojureRoot,
      extensions: ['.clj', '.cljs', '.cljc', '.edn'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('clojure-lsp', ['listen'], root, env);
      },
    },
    nixd: {
      id: 'nixd',
      root: nixRoot,
      extensions: ['.nix'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('nixd', [], root, env);
      },
    },
    tinymist: {
      id: 'tinymist',
      root: tinymistRoot,
      extensions: ['.typ', '.typc'],
      async spawn(root, _workDir, env) {
        return spawnBinaryServer('tinymist', [], root, env);
      },
    },
  };
}

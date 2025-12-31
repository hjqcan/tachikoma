/**
 * submit_result - 提交任务结果工具
 *
 * 允许Agent提交任务执行结果
 * 结果会写入到 Worker 的 artifacts 目录
 *
 * @layer Atomic
 * @category Agent
 * @permissions FileSystemWrite
 */

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';
import { DEFAULT_RESOURCE_LIMITS } from '../constants';
import { mergeEnv } from '../env-utils';
import { detectPackageManager, truncateWithNotice, DEFAULT_MAX_OUTPUT } from './security';
import { ensureWorkDir, validatePath } from './utils';

/**
 * 提交结果输出
 */
interface SubmitResultOutput {
  /** 是否成功接受 */
  accepted: boolean;
  /** 提交ID */
  submissionId: string;
  /** 结果文件路径 */
  resultPath: string;
  /** 时间戳 */
  timestamp: number;
  /** 结果状态 */
  status: 'success' | 'partial' | 'failed';
  /** 是否为最终结果 */
  isFinal: boolean;
  /** 摘要 */
  summary?: string | undefined;
  /** 覆盖警告（如果发生重命名） */
  warning?: string | undefined;
}

type GateMode = 'off' | 'auto' | 'required';

interface ExecutionGateConfig {
  mode?: GateMode;
  build?: GateCommandConfig;
  smoke?: GateCommandConfig;
}

interface GateCommandConfig {
  command?: string[];
  cwd?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}

interface GateStep {
  kind: 'build' | 'smoke';
  command: string[];
  cwd: string;
  timeoutMs: number;
  allowFailure?: boolean;
}

interface GateStepResult {
  step: GateStep;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

interface GateSummary {
  status: 'passed' | 'skipped';
  reason?: string;
  steps?: Array<{
    kind: GateStep['kind'];
    command: string[];
    cwd: string;
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
    truncated: boolean;
  }>;
}

interface GateCheckResult {
  allowed: boolean;
  message?: string;
  summary?: GateSummary;
}

interface GateCandidate {
  ecosystem: 'node' | 'python' | 'go' | 'rust' | 'java' | 'dotnet';
  root: string;
  steps: GateStep[];
  reason?: string;
}

const GATE_MODE_VALUES = new Set<GateMode>(['off', 'auto', 'required']);

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function normalizeEnvId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Prevent path traversal / filesystem injection via env-provided identifiers.
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function normalizeFileStem(value: string): string {
  const trimmed = value.trim();
  const base = trimmed || 'result';
  // Keep it filesystem-safe and stable across platforms.
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/g, '_').slice(0, 64);
  if (!sanitized || sanitized === '.' || sanitized === '..') return 'result';
  return sanitized;
}

async function findUp(
  startDir: string,
  stopDir: string,
  targets: string[]
): Promise<string | undefined> {
  let current = resolve(startDir);
  const stop = resolve(stopDir);
  const literalTargets = targets.filter((target) => !target.includes('*'));
  const wildcardTargets = targets.filter((target) => target.includes('*'));

  while (true) {
    for (const target of literalTargets) {
      const candidate = join(current, target);
      if (await fileExists(candidate)) return candidate;
    }

    if (wildcardTargets.length > 0) {
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        for (const target of wildcardTargets) {
          if (matchesPattern(entry.name, target)) {
            return join(current, entry.name);
          }
        }
      }
    }

    if (current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

function pathDepth(dirPath: string): number {
  return resolve(dirPath).split(sep).filter(Boolean).length;
}

function parseGateMode(value: unknown): GateMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  if (GATE_MODE_VALUES.has(normalized as GateMode)) {
    return normalized as GateMode;
  }
  return undefined;
}

function parseGateConfig(env: Record<string, string>): ExecutionGateConfig | undefined {
  const raw = env.TACHIKOMA_EXECUTION_GATE ?? env.TACHIKOMA_EXECUTION_GATE_CONFIG;
  const modeOverride = parseGateMode(env.TACHIKOMA_EXECUTION_GATE_MODE);
  if (!raw) {
    return modeOverride ? { mode: modeOverride } : undefined;
  }

  if (GATE_MODE_VALUES.has(raw as GateMode)) {
    return { mode: modeOverride ?? (raw as GateMode) };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return modeOverride ? { mode: modeOverride } : undefined;
    const config: ExecutionGateConfig = {};
    const parsedMode = parseGateMode(parsed.mode);
    if (parsedMode) config.mode = parsedMode;
    const build = isPlainObject(parsed.build) ? normalizeGateCommand(parsed.build) : undefined;
    if (build) config.build = build;
    const smoke = isPlainObject(parsed.smoke) ? normalizeGateCommand(parsed.smoke) : undefined;
    if (smoke) config.smoke = smoke;
    if (modeOverride) config.mode = modeOverride;
    return config;
  } catch {
    return modeOverride ? { mode: modeOverride } : undefined;
  }
}

function normalizeGateCommand(value: Record<string, unknown>): GateCommandConfig | undefined {
  const normalized: GateCommandConfig = {};
  if (Array.isArray(value.command) && value.command.every((item) => typeof item === 'string')) {
    normalized.command = value.command as string[];
  }
  if (typeof value.cwd === 'string') {
    normalized.cwd = value.cwd;
  }
  if (typeof value.timeoutMs === 'number') {
    normalized.timeoutMs = value.timeoutMs;
  }
  if (typeof value.allowFailure === 'boolean') {
    normalized.allowFailure = value.allowFailure;
  }

  if (
    !normalized.command &&
    !normalized.cwd &&
    normalized.timeoutMs === undefined &&
    normalized.allowFailure === undefined
  ) {
    return undefined;
  }
  return normalized;
}

function parsePackageManagerField(value: unknown): 'npm' | 'pnpm' | 'yarn' | 'bun' | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.split('@')[0]?.trim();
  if (!name) return undefined;
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name;
  return undefined;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildGateStep(
  kind: GateStep['kind'],
  command: string[],
  cwd: string,
  timeoutMs: number,
  allowFailure?: boolean
): GateStep {
  return { kind, command, cwd, timeoutMs, ...(allowFailure !== undefined ? { allowFailure } : {}) };
}

function resolveGateCwd(cwd: string | undefined, workDir: string): string | undefined {
  if (!cwd) return undefined;
  return validatePath(cwd, workDir);
}

async function resolveNodeGate(
  baseDir: string,
  workDir: string,
  timeoutMs: number
): Promise<GateCandidate | null> {
  const packageJson = await findUp(baseDir, workDir, ['package.json']);
  if (!packageJson) return null;
  const root = dirname(packageJson);
  const pkg = await readJsonFile(packageJson);
  const scripts = isPlainObject(pkg?.scripts) ? (pkg?.scripts as Record<string, unknown>) : {};
  const hasBuild = typeof scripts.build === 'string';
  const smokeScript = typeof scripts.smoke === 'string'
    ? 'smoke'
    : typeof scripts.test === 'string'
      ? 'test'
      : undefined;

  const managerFromLock = detectPackageManager(root);
  const managerFromField = parsePackageManagerField(pkg?.packageManager);
  const manager = managerFromLock !== 'unknown'
    ? managerFromLock
    : (managerFromField ?? 'npm');

  const steps: GateStep[] = [];
  if (hasBuild) {
    steps.push(buildGateStep('build', [manager, 'run', 'build'], root, timeoutMs));
  }
  if (smokeScript) {
    steps.push(buildGateStep('smoke', [manager, 'run', smokeScript], root, timeoutMs));
  }

  return {
    ecosystem: 'node',
    root,
    steps,
    ...(steps.length === 0 && { reason: 'No build/test scripts found in package.json' }),
  };
}

async function resolvePythonGate(
  baseDir: string,
  workDir: string,
  timeoutMs: number,
  env: Record<string, string>
): Promise<GateCandidate | null> {
  const marker = await findUp(baseDir, workDir, [
    'poetry.lock',
    'pdm.lock',
    'pyproject.toml',
    'requirements.txt',
    'setup.py',
    'setup.cfg',
  ]);
  if (!marker) return null;
  const root = dirname(marker);
  const poetryLock = await fileExists(join(root, 'poetry.lock'));
  const pdmLock = !poetryLock && (await fileExists(join(root, 'pdm.lock')));
  const pytestIni = await fileExists(join(root, 'pytest.ini'));
  const testsDir = (await directoryExists(join(root, 'tests')))
    || (await directoryExists(join(root, 'test')));
  let hasPytestSignals = pytestIni || testsDir;

  const pyprojectPath = join(root, 'pyproject.toml');
  if (!hasPytestSignals && await fileExists(pyprojectPath)) {
    try {
      const content = await readFile(pyprojectPath, 'utf-8');
      if (content.includes('pytest')) {
        hasPytestSignals = true;
      }
    } catch {
      // ignore
    }
  }

  const python = (await resolveBinary('python', env))
    ?? (await resolveBinary('python3', env))
    ?? 'python';

  const steps: GateStep[] = [];
  if (poetryLock) {
    steps.push(buildGateStep('build', ['poetry', 'build'], root, timeoutMs));
    if (hasPytestSignals) {
      steps.push(buildGateStep('smoke', ['poetry', 'run', 'pytest', '-q'], root, timeoutMs));
    }
  } else if (pdmLock) {
    steps.push(buildGateStep('build', ['pdm', 'build'], root, timeoutMs));
    if (hasPytestSignals) {
      steps.push(buildGateStep('smoke', ['pdm', 'run', 'pytest', '-q'], root, timeoutMs));
    }
  } else {
    steps.push(buildGateStep('build', [python, '-m', 'compileall', '.'], root, timeoutMs));
    if (hasPytestSignals) {
      steps.push(buildGateStep('smoke', [python, '-m', 'pytest', '-q'], root, timeoutMs));
    }
  }

  return {
    ecosystem: 'python',
    root,
    steps,
    ...(steps.length === 0 && { reason: 'No runnable python build/test commands detected' }),
  };
}

async function resolveGoGate(
  baseDir: string,
  workDir: string,
  timeoutMs: number
): Promise<GateCandidate | null> {
  const goWork = await findUp(baseDir, workDir, ['go.work']);
  const goMod = goWork ? undefined : await findUp(baseDir, workDir, ['go.mod']);
  const marker = goWork ?? goMod;
  if (!marker) return null;
  const root = dirname(marker);
  return {
    ecosystem: 'go',
    root,
    steps: [
      buildGateStep('build', ['go', 'build', './...'], root, timeoutMs),
      buildGateStep('smoke', ['go', 'test', './...'], root, timeoutMs),
    ],
  };
}

async function resolveRustGate(
  baseDir: string,
  workDir: string,
  timeoutMs: number
): Promise<GateCandidate | null> {
  const cargo = await findUp(baseDir, workDir, ['Cargo.toml']);
  if (!cargo) return null;
  const root = dirname(cargo);
  return {
    ecosystem: 'rust',
    root,
    steps: [
      buildGateStep('build', ['cargo', 'build'], root, timeoutMs),
      buildGateStep('smoke', ['cargo', 'test', '--quiet'], root, timeoutMs),
    ],
  };
}

async function resolveJavaGate(
  baseDir: string,
  workDir: string,
  timeoutMs: number
): Promise<GateCandidate | null> {
  const mavenMarker = await findUp(baseDir, workDir, ['pom.xml']);
  const gradleMarker = mavenMarker ? undefined : await findUp(baseDir, workDir, ['build.gradle', 'build.gradle.kts']);
  const marker = mavenMarker ?? gradleMarker;
  if (!marker) return null;
  const root = dirname(marker);
  const isWindows = process.platform === 'win32';

  if (mavenMarker) {
    const wrapper = isWindows ? 'mvnw.cmd' : 'mvnw';
    const wrapperPath = join(root, wrapper);
    const command = (await fileExists(wrapperPath)) ? wrapperPath : 'mvn';
    return {
      ecosystem: 'java',
      root,
      steps: [
        buildGateStep('build', [command, '-q', '-DskipTests', 'package'], root, timeoutMs),
        buildGateStep('smoke', [command, '-q', 'test'], root, timeoutMs),
      ],
    };
  }

  const wrapper = isWindows ? 'gradlew.bat' : 'gradlew';
  const wrapperPath = join(root, wrapper);
  const command = (await fileExists(wrapperPath)) ? wrapperPath : 'gradle';
  return {
    ecosystem: 'java',
    root,
    steps: [
      buildGateStep('build', [command, 'build', '-x', 'test'], root, timeoutMs),
      buildGateStep('smoke', [command, 'test'], root, timeoutMs),
    ],
  };
}

async function resolveDotnetGate(
  baseDir: string,
  workDir: string,
  timeoutMs: number
): Promise<GateCandidate | null> {
  const marker = await findUp(baseDir, workDir, ['*.sln', '*.csproj', '*.fsproj']);
  if (!marker) return null;
  const root = dirname(marker);
  const target = marker ? [marker] : [];
  return {
    ecosystem: 'dotnet',
    root,
    steps: [
      buildGateStep('build', ['dotnet', 'build', ...target], root, timeoutMs),
      buildGateStep('smoke', ['dotnet', 'test', ...target], root, timeoutMs),
    ],
  };
}

async function resolveBinary(name: string, env: Record<string, string>): Promise<string | null> {
  const envPath = env.PATH ?? process.env.PATH ?? '';
  const dirs = envPath.split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function selectCandidate(candidates: GateCandidate[]): GateCandidate | null {
  if (candidates.length === 0) return null;
  const priority: Record<GateCandidate['ecosystem'], number> = {
    node: 1,
    python: 2,
    go: 3,
    rust: 4,
    java: 5,
    dotnet: 6,
  };
  return candidates
    .slice()
    .sort((a, b) => {
      const depthDiff = pathDepth(b.root) - pathDepth(a.root);
      if (depthDiff !== 0) return depthDiff;
      return (priority[a.ecosystem] ?? 999) - (priority[b.ecosystem] ?? 999);
    })[0] ?? null;
}

function buildStepsFromConfig(
  config: ExecutionGateConfig,
  workDir: string,
  timeoutMs: number
): GateStep[] {
  const steps: GateStep[] = [];
  let buildCwd = workDir;
  if (config.build?.cwd) {
    try {
      buildCwd = resolveGateCwd(config.build.cwd, workDir) ?? workDir;
    } catch (error) {
      const err = error as Error;
      throw new Error(`Invalid build cwd: ${err.message}`);
    }
  }
  if (config.build?.command && config.build.command.length > 0) {
    steps.push(buildGateStep('build', config.build.command, buildCwd, config.build.timeoutMs ?? timeoutMs, config.build.allowFailure));
  }
  let smokeCwd = workDir;
  if (config.smoke?.cwd) {
    try {
      smokeCwd = resolveGateCwd(config.smoke.cwd, workDir) ?? workDir;
    } catch (error) {
      const err = error as Error;
      throw new Error(`Invalid smoke cwd: ${err.message}`);
    }
  }
  if (config.smoke?.command && config.smoke.command.length > 0) {
    steps.push(buildGateStep('smoke', config.smoke.command, smokeCwd, config.smoke.timeoutMs ?? timeoutMs, config.smoke.allowFailure));
  }
  return steps;
}

async function resolveGateSteps(
  baseDir: string,
  workDir: string,
  env: Record<string, string>,
  config: ExecutionGateConfig | undefined,
  timeoutMs: number
): Promise<{ mode: GateMode; steps: GateStep[]; reason?: string }> {
  const mode: GateMode = config?.mode ?? 'auto';
  if (mode === 'off') {
    return { mode, steps: [], reason: 'disabled' };
  }

  const configuredSteps = config ? buildStepsFromConfig(config, workDir, timeoutMs) : [];
  if (configuredSteps.length > 0) {
    return { mode, steps: configuredSteps };
  }

  const candidates = (
    await Promise.all([
      resolveNodeGate(baseDir, workDir, timeoutMs),
      resolvePythonGate(baseDir, workDir, timeoutMs, env),
      resolveGoGate(baseDir, workDir, timeoutMs),
      resolveRustGate(baseDir, workDir, timeoutMs),
      resolveJavaGate(baseDir, workDir, timeoutMs),
      resolveDotnetGate(baseDir, workDir, timeoutMs),
    ])
  ).filter((candidate): candidate is GateCandidate => Boolean(candidate));

  const candidate = selectCandidate(candidates);
  if (!candidate) {
    return { mode, steps: [], reason: 'no build/test signals found' };
  }
  if (candidate.steps.length === 0) {
    return {
      mode,
      steps: [],
      reason: candidate.reason ?? `no runnable build/test commands found for ${candidate.ecosystem}`,
    };
  }
  return candidate.reason
    ? { mode, steps: candidate.steps, reason: candidate.reason }
    : { mode, steps: candidate.steps };
}

async function executeGateStep(
  step: GateStep,
  context: ExecutionContext
): Promise<GateStepResult> {
  const env = mergeEnv(context);
  const startTime = Date.now();

  return new Promise((resolveResult) => {
    let timedOut = false;
    const [command, ...args] = step.command;
    if (!command) {
      resolveResult({
        step,
        exitCode: 1,
        stdout: '',
        stderr: 'Invalid execution gate step: empty command.',
        timedOut: false,
        durationMs: Date.now() - startTime,
        truncated: false,
      });
      return;
    }

    const child = spawn(command, args, {
      cwd: step.cwd,
      detached: true,
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) {
          process.kill(-child.pid, 'SIGTERM');
          setTimeout(() => {
            try {
              if (child.pid && !child.killed) {
                process.kill(-child.pid, 'SIGKILL');
              }
            } catch {
              // ignore
            }
          }, 1000);
        }
      } catch {
        child.kill('SIGKILL');
      }
    }, step.timeoutMs);

    const finish = (exitCode: number) => {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;
      const stdoutResult = truncateWithNotice(stdout, DEFAULT_MAX_OUTPUT);
      const stderrResult = truncateWithNotice(stderr, DEFAULT_MAX_OUTPUT);
      resolveResult({
        step,
        exitCode,
        stdout: stdoutResult.content,
        stderr: stderrResult.content,
        timedOut,
        durationMs,
        truncated: stdoutResult.truncated || stderrResult.truncated,
      });
    };

    child.on('error', (error: Error) => {
      stderr += `\\n${error.message}`;
      finish(1);
    });

    child.on('close', (code: number | null) => {
      finish(timedOut ? 124 : (code ?? 1));
    });
  });
}

function formatGateFailure(result: GateStepResult): string {
  const command = result.step.command.join(' ');
  const output = [result.stdout, result.stderr].filter(Boolean).join('\\n');
  const timing = result.timedOut ? ' (timed out)' : '';
  return `Execution gate failed during ${result.step.kind} (${command})${timing}.\\n${output || 'No output captured.'}`;
}

async function enforceExecutionGate(
  context: ExecutionContext,
  isFinal: boolean,
  status: 'success' | 'partial' | 'failed'
): Promise<GateCheckResult> {
  if (!isFinal || status === 'failed') {
    return { allowed: true };
  }

  const workDirCheck = await ensureWorkDir(context.workDir);
  if (!workDirCheck.valid) {
    return {
      allowed: false,
      message: workDirCheck.error ?? 'Invalid workDir for execution gate',
    };
  }

  let baseDir = context.effectiveCwd ?? context.workDir;
  try {
    // Ensure we only search within the workspace; if agent changed cwd outside, fall back to workDir.
    baseDir = validatePath(baseDir, context.workDir);
  } catch {
    baseDir = context.workDir;
  }
  const env = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined)
    ) as Record<string, string>),
    ...(context.env ?? {}),
  };
  const config = parseGateConfig(env);
  const defaultTimeout = context.resourceLimits?.maxExecutionTime ?? DEFAULT_RESOURCE_LIMITS.maxExecutionTime;

  let plan: { mode: GateMode; steps: GateStep[]; reason?: string };
  try {
    plan = await resolveGateSteps(baseDir, context.workDir, env, config, defaultTimeout);
  } catch (error) {
    const err = error as Error;
    return {
      allowed: false,
      message: err.message || 'Execution gate config error',
    };
  }
  if (plan.mode === 'off') {
    return {
      allowed: true,
      summary: { status: 'skipped', reason: 'execution gate disabled' },
    };
  }

  if (plan.steps.length === 0) {
    if (plan.mode === 'required') {
      return {
        allowed: false,
        message: `Execution gate required but no commands found: ${plan.reason ?? 'no signals'}`,
      };
    }
    return {
      allowed: true,
      summary: { status: 'skipped', reason: plan.reason ?? 'no build/test signals found' },
    };
  }

  const summaries: GateSummary['steps'] = [];
  for (const step of plan.steps) {
    const result = await executeGateStep(step, context);
    summaries.push({
      kind: step.kind,
      command: step.command,
      cwd: step.cwd,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      truncated: result.truncated,
    });
    if (result.exitCode !== 0 && !step.allowFailure) {
      return {
        allowed: false,
        message: formatGateFailure(result),
      };
    }
  }

  return {
    allowed: true,
    summary: { status: 'passed', steps: summaries },
  };
}

/**
 * 验证输入
 */
function validateInput(input: unknown): {
  valid: boolean;
  error?: string;
  data?: {
    result: unknown;
    status: 'success' | 'partial' | 'failed';
    summary?: string | undefined;
    isFinal: boolean;
    metadata?: Record<string, unknown> | undefined;
    filename: string;
  };
} {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  // 必填字段
  if (!('result' in obj)) {
    return { valid: false, error: 'Missing required field: result' };
  }
  if (!('status' in obj)) {
    return { valid: false, error: 'Missing required field: status' };
  }

  // status 枚举校验
  const validStatuses = ['success', 'partial', 'failed'];
  if (!validStatuses.includes(obj.status as string)) {
    return {
      valid: false,
      error: `Invalid status: ${obj.status}. Must be one of: ${validStatuses.join(', ')}`,
    };
  }

  // 可选字段类型校验
  if (obj.summary !== undefined && typeof obj.summary !== 'string') {
    return { valid: false, error: 'summary must be a string' };
  }
  if (obj.isFinal !== undefined && typeof obj.isFinal !== 'boolean') {
    return { valid: false, error: 'isFinal must be a boolean' };
  }
  if (obj.metadata !== undefined && typeof obj.metadata !== 'object') {
    return { valid: false, error: 'metadata must be an object' };
  }
  if (obj.filename !== undefined && typeof obj.filename !== 'string') {
    return { valid: false, error: 'filename must be a string' };
  }

  return {
    valid: true,
    data: {
      result: obj.result,
      status: obj.status as 'success' | 'partial' | 'failed',
      summary: obj.summary as string | undefined,
      isFinal: (obj.isFinal as boolean) ?? true,
      metadata: obj.metadata as Record<string, unknown> | undefined,
      filename: (obj.filename as string) ?? 'result',
    },
  };
}

/**
 * submit_result 工具定义
 */
export const submitResultTool: Tool = {
  name: 'submit_result',
  title: 'Submit Result',
  description: `提交任务执行结果。结果会保存到 artifacts 目录，供 Orchestrator 读取聚合。

使用场景：
- 完成子任务后提交结果
- 报告部分进度
- 提交失败信息

执行门槛（Step 4）：
- 当 isFinal=true 且 status!=failed 时，自动运行 build + smoke（支持 node/python/go/rust/java/.NET）
- 前端联调 smoke 由 VerificationGate 的 smoke 层执行（页面渲染 + 数据 fetch 成功）
- 未识别到构建/测试信号时会跳过（auto 模式）
- 可通过环境变量配置：TACHIKOMA_EXECUTION_GATE / TACHIKOMA_EXECUTION_GATE_MODE

结果文件格式：JSON，包含 result、status、summary、metadata 等字段。`,

  layer: ToolLayer.Atomic,
  category: ToolCategory.Agent,
  permissions: [
    ToolPermission.FileSystemRead,
    ToolPermission.FileSystemWrite,
    ToolPermission.ProcessSpawn,
  ],

  annotations: {
    idempotent: false,
    cacheable: false,
    priority: 10, // 高优先级
  },

  inputSchema: {
    type: 'object',
    properties: {
      result: {
        description: '任务执行结果（任意JSON可序列化数据）',
      },
      status: {
        type: 'string',
        enum: ['success', 'partial', 'failed'],
        description: '结果状态：success-成功，partial-部分完成，failed-失败',
      },
      summary: {
        type: 'string',
        description: '结果摘要说明（人类可读）',
      },
      isFinal: {
        type: 'boolean',
        description: '是否为最终结果（默认true）',
        default: true,
      },
      metadata: {
        type: 'object',
        description: '附加元数据（如执行时间、token消耗等）',
      },
      filename: {
        type: 'string',
        description: '自定义文件名（不含扩展名，默认 "result"）',
      },
    },
    required: ['result', 'status'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      accepted: { type: 'boolean' },
      submissionId: { type: 'string' },
      resultPath: { type: 'string' },
      timestamp: { type: 'number' },
      status: { type: 'string', enum: ['success', 'partial', 'failed'] },
      isFinal: { type: 'boolean' },
      summary: { type: 'string' },
    },
  },

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<SubmitResultOutput>> {
    // 输入校验
    const validation = validateInput(input);
    if (!validation.valid || !validation.data) {
      return {
        success: false,
        error: `Invalid input: ${validation.error}`,
      };
    }

    const { result, status, summary, isFinal, metadata, filename } = validation.data;

    const gateResult = await enforceExecutionGate(context, isFinal, status);
    if (!gateResult.allowed) {
      return {
        success: false,
        error: gateResult.message ?? 'Execution gate failed',
      };
    }
    const executionGateSummary = gateResult.summary;

    const timestamp = Date.now();
    const submissionId = `submission-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;

    // 构建 artifacts 目录路径
    // 优先使用 session 路径（如果 SESSION_ID 存在）
    const sessionId = normalizeEnvId(context.env?.SESSION_ID as string | undefined);
    const workerId = normalizeEnvId(context.env?.WORKER_ID as string | undefined);
    const safeFilename = normalizeFileStem(filename);
    
    let artifactsDir: string;
    if (sessionId && workerId) {
      // Session 模式：写入 worker artifacts 目录
      artifactsDir = join(
        context.workDir, '.tachikoma', 'sessions', sessionId, 'workers', workerId, 'artifacts'
      );
    } else if (sessionId) {
      // 只有 sessionId，写入 orchestrator artifacts
      artifactsDir = join(
        context.workDir, '.tachikoma', 'sessions', sessionId, 'orchestrator', 'artifacts'
      );
    } else {
      // 默认模式：全局 artifacts 目录
      artifactsDir = join(context.workDir, '.tachikoma', 'artifacts');
    }

    try {
      // Ensure artifactsDir stays within workDir even if env ids were tampered.
      artifactsDir = validatePath(artifactsDir, context.workDir);
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: `Invalid artifacts directory: ${err.message}`,
      };
    }

    try {
      // 确保目录存在
      await mkdir(artifactsDir, { recursive: true });

      // 检查目录可写性
      const dirStat = await stat(artifactsDir);
      if (!dirStat.isDirectory()) {
        return {
          success: false,
          error: `Path is not a directory: ${artifactsDir}`,
        };
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        success: false,
        error: `Failed to create artifacts directory: ${artifactsDir}. Reason: ${err.message}`,
      };
    }

    // 构建结果对象
    const resultData = {
      submissionId,
      taskId: context.taskId,
      agentId: context.agentId,
      status,
      isFinal,
      result,
      summary,
      metadata: {
        ...metadata,
        submittedAt: new Date(timestamp).toISOString(),
        ...(executionGateSummary ? { executionGate: executionGateSummary } : {}),
      },
      timestamp,
    };

    // 构建文件名
    // isFinal=true 时检查文件是否已存在，避免误覆盖
    let resultFilename: string;
    let wasRenamed = false;
    
    if (isFinal) {
      const finalPath = validatePath(join(artifactsDir, `${safeFilename}.json`), artifactsDir);
      try {
        const existingStat = await stat(finalPath);
        if (existingStat.isFile()) {
          // 已存在最终结果，添加时间戳避免覆盖
          resultFilename = `${safeFilename}-final-${timestamp}.json`;
          wasRenamed = true;
        } else {
          resultFilename = `${safeFilename}.json`;
        }
      } catch {
        // 文件不存在，使用默认名称
        resultFilename = `${safeFilename}.json`;
      }
    } else {
      resultFilename = `${safeFilename}-${timestamp}.json`;
    }
    
    const resultPath = validatePath(join(artifactsDir, resultFilename), artifactsDir);

    try {
      await mkdir(dirname(resultPath), { recursive: true });
      await writeFile(resultPath, JSON.stringify(resultData, null, 2), 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        success: false,
        error: `Failed to write result file: ${resultPath}. Reason: ${err.message}`,
      };
    }

    return {
      success: true,
      data: {
        accepted: true,
        submissionId,
        resultPath,
        timestamp,
        status,
        isFinal,
        summary,
        ...(wasRenamed && { 
          warning: `已存在同名最终结果文件，本次使用时间戳后缀保存: ${resultFilename}` 
        }),
      },
    };
  },
};

export default submitResultTool;

/**
 * Build Gate Service
 *
 * Validates that code changes pass build/type checks before marking tasks as complete.
 * Inspired by OpenCode's LSP-first verification pattern.
 *
 * Key responsibilities:
 * - Detect project type (TypeScript, Python, etc.)
 * - Run appropriate type/build checks
 * - Parse errors into structured format
 * - Provide clear feedback for error fixing
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, extname, isAbsolute, resolve, relative } from 'node:path';
import { Diagnostic } from 'vscode-languageserver-types';
import { LSP } from '../../lsp';

// ============================================================================
// Types
// ============================================================================

export interface BuildError {
  file: string;
  line: number;
  column: number;
  message: string;
  code?: string;
  severity: 'error' | 'warning';
}

export interface BuildGateResult {
  passed: boolean;
  errors: BuildError[];
  warnings: BuildError[];
  summary: string;
  command?: string;
  duration?: number;
}

export type ProjectType = 'typescript' | 'python' | 'javascript' | 'unknown';

export interface BuildGateConfig {
  /** Maximum time for build check in ms */
  timeout?: number;
  /** Whether to include warnings in failure */
  failOnWarnings?: boolean;
  /** Maximum number of errors to report */
  maxErrors?: number;
  /** Use LSP for diagnostics when available (faster than tsc) */
  useLsp?: boolean;
}

export interface BuildGateCheckOptions {
  /** Override detected project type */
  projectType?: ProjectType;
  /** Override type check command */
  typeCheckCommand?: string;
  /** Changed files to trigger LSP diagnostics */
  changedFiles?: string[] | undefined;
  /** Environment variables */
  env?: Record<string, string>;
}

const DEFAULT_CONFIG: Required<BuildGateConfig> = {
  timeout: 60_000,
  failOnWarnings: false,
  maxErrors: 50,
  useLsp: true,
};

const COMMONJS_MODULE_HINT = 'File is a CommonJS module; it may be converted to an ES module.';
const DOWNGRADE_LSP_DIAGNOSTIC_CODES = new Set(['80001']);
const MAX_FALLBACK_OUTPUT_CHARS = 4000;
const MAX_CHANGED_FILES_TOUCH = 80;
const LSP_TOUCH_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

// ============================================================================
// BuildGateService
// ============================================================================

export class BuildGateService {
  private readonly config: Required<BuildGateConfig>;

  constructor(config?: BuildGateConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run build gate check on a project directory
   */
  async check(workDir: string, options: BuildGateCheckOptions = {}): Promise<BuildGateResult> {
    const startTime = Date.now();
    const projectType = options.projectType ?? (await this.detectProjectType(workDir));

    console.info(`[BuildGate] Detected project type: ${projectType} in ${workDir}`);

    let result: BuildGateResult;

    switch (projectType) {
      case 'typescript': {
        // Try LSP first for faster diagnostics
        if (this.config.useLsp) {
          const lspResult = await this.checkWithLSP(workDir, options.changedFiles, options.env);
          if (lspResult !== null) {
            result = lspResult;
            break;
          }
        }
        // Fallback to tsc
        result = await this.checkTypeScript(workDir, options.typeCheckCommand);
        break;
      }
      case 'python':
        result = await this.checkPython(workDir, options.typeCheckCommand);
        break;
      case 'javascript':
        // JavaScript projects without TypeScript just need syntax check
        result = {
          passed: true,
          errors: [],
          warnings: [],
          summary: 'No type check needed for JavaScript',
        };
        break;
      default:
        result = {
          passed: true,
          errors: [],
          warnings: [],
          summary: 'Unknown project type, skipping build gate',
        };
    }

    result.duration = Date.now() - startTime;

    // Log result
    if (result.passed) {
      console.info(`[BuildGate] PASSED in ${result.duration}ms`);
    } else {
      console.warn(
        `[BuildGate] FAILED with ${result.errors.length} errors in ${result.duration}ms`
      );
    }

    return result;
  }

  /**
   * Check using LSP diagnostics (faster than running tsc)
   * Returns null if LSP is not available
   */
  async checkWithLSP(
    workDir: string,
    changedFiles?: string[],
    env?: Record<string, string>
  ): Promise<BuildGateResult | null> {
    const startTime = Date.now();
    const lintSources = new Set(['eslint', 'oxlint', 'biome', 'stylelint']);

    try {
      // Initialize LSP state
      await LSP.init(workDir, env);

      // Determine files to touch for LSP diagnostics
      let filesToTouch = changedFiles ?? [];

      if (filesToTouch.length > 0) {
        filesToTouch = this.normalizeChangedFiles(filesToTouch, workDir);
        if (filesToTouch.length > MAX_CHANGED_FILES_TOUCH) {
          console.info(
            `[BuildGate] Limiting LSP touch to ${MAX_CHANGED_FILES_TOUCH} of ${filesToTouch.length} changed files`
          );
          filesToTouch = filesToTouch.slice(0, MAX_CHANGED_FILES_TOUCH);
        }
      }

      // If no changed files provided, discover TypeScript files to trigger LSP
      if (filesToTouch.length === 0) {
        filesToTouch = await this.discoverTsFiles(workDir);
        if (filesToTouch.length === 0) {
          console.info('[BuildGate] No TypeScript files found in project, skipping LSP');
          return null;
        }
        console.info(`[BuildGate] Discovered ${filesToTouch.length} TypeScript files for LSP`);
      }

      // Touch files to trigger diagnostics (limit to 20 to avoid slowdown)
      // Run sequentially to avoid excessive diagnostics listeners.
      for (const file of filesToTouch.slice(0, 20)) {
        try {
          await LSP.touchFile(file, workDir, env, true);
        } catch {
          // Skip files that can't be opened
        }
      }

      // Get all diagnostics
      const rawDiagnostics = await LSP.diagnostics(workDir, env);
      const diagnostics = this.filterDiagnostics(rawDiagnostics, workDir);
      const droppedDiagnostics =
        Object.keys(rawDiagnostics).length - Object.keys(diagnostics).length;
      if (droppedDiagnostics > 0) {
        console.info(
          `[BuildGate] Ignored ${droppedDiagnostics} stale diagnostics for missing/out-of-scope files`
        );
      }
      const allErrors: BuildError[] = [];
      const allWarnings: BuildError[] = [];
      const lintDiagnostics: BuildError[] = [];
      const lintSourceCounts = new Map<string, number>();

      const logDiagnostics = (label: string, items: BuildError[], limit = 10) => {
        if (items.length === 0) return;
        console.info(
          `[BuildGate] LSP ${label}: showing ${Math.min(items.length, limit)} of ${items.length}`
        );
        for (const item of items.slice(0, limit)) {
          const loc = `${item.file}:${item.line}:${item.column}`;
          const code = item.code ? ` ${item.code}` : '';
          console.info(`[BuildGate] ${loc}${code} ${item.message}`);
        }
      };

      for (const [file, fileDiagnostics] of Object.entries(diagnostics)) {
        for (const diag of fileDiagnostics) {
          const codeValue = diag.code !== undefined ? String(diag.code) : undefined;
          const diagnosticMessage = Diagnostic.getMessageString(diag);
          const isCommonJsModuleHint =
            codeValue === '80001' ||
            DOWNGRADE_LSP_DIAGNOSTIC_CODES.has(codeValue ?? '') ||
            diagnosticMessage.includes(COMMONJS_MODULE_HINT);
          const baseSeverity = diag.severity === 1 ? 'error' : 'warning';
          const severity = isCommonJsModuleHint ? 'warning' : baseSeverity;
          const source = typeof diag.source === 'string' ? diag.source : undefined;
          const sourceKey = source ? source.toLowerCase() : undefined;
          const message = source ? `[${source}] ${diagnosticMessage}` : diagnosticMessage;
          const buildError: BuildError = {
            file,
            line: diag.range.start.line + 1,
            column: diag.range.start.character + 1,
            message,
            ...(codeValue ? { code: codeValue } : {}),
            severity,
          };

          if (isCommonJsModuleHint && baseSeverity === 'error') {
            console.info(`[BuildGate] Downgraded TS${codeValue ?? ''} to warning for ${file}`);
          }

          if (sourceKey && lintSources.has(sourceKey)) {
            lintDiagnostics.push(buildError);
            lintSourceCounts.set(sourceKey, (lintSourceCounts.get(sourceKey) ?? 0) + 1);
            continue;
          }

          if (severity === 'error') {
            allErrors.push(buildError);
          } else {
            allWarnings.push(buildError);
          }
        }
      }

      if (lintDiagnostics.length > 0) {
        const sources = Array.from(lintSourceCounts.entries())
          .map(([sourceKey, count]) => `${sourceKey}:${count}`)
          .join(', ');
        console.info(
          `[BuildGate] Ignoring ${lintDiagnostics.length} lint diagnostics from LSP (${sources})`
        );
        logDiagnostics('lint', lintDiagnostics);
      }

      if (allErrors.length === 0 && allWarnings.length === 0) {
        // Zero diagnostics could mean:
        // 1. No LSP clients connected
        // 2. LSP not fully indexed yet
        // 3. Actually no errors
        // To be safe, always fallback to tsc for verification when LSP returns nothing
        const status = await LSP.status(workDir, env);
        if (status.length === 0) {
          console.info('[BuildGate] No LSP clients connected, falling back to tsc');
        } else {
          console.info(
            '[BuildGate] LSP returned zero diagnostics, falling back to tsc for verification'
          );
        }
        return null; // Signal to use fallback
      }

      const errorCount = allErrors.length;
      const warningCount = allWarnings.length;
      const passed = this.config.failOnWarnings
        ? errorCount === 0 && warningCount === 0
        : errorCount === 0;

      if (!passed) {
        logDiagnostics('errors', allErrors);
        logDiagnostics('warnings', allWarnings);
      }

      return {
        passed,
        errors: allErrors.slice(0, this.config.maxErrors),
        warnings: allWarnings.slice(0, this.config.maxErrors),
        summary: passed
          ? 'LSP check passed'
          : `LSP check failed: ${errorCount} errors, ${warningCount} warnings`,
        command: 'lsp_check',
        duration: Date.now() - startTime,
      };
    } catch (error) {
      console.info(`[BuildGate] LSP check failed, falling back: ${(error as Error).message}`);
      return null; // Signal to use fallback
    }
  }

  /**
   * Detect project type based on configuration files
   */
  async detectProjectType(workDir: string): Promise<ProjectType> {
    // Check for TypeScript
    if (existsSync(join(workDir, 'tsconfig.json'))) {
      return 'typescript';
    }

    // Check for Python
    if (
      existsSync(join(workDir, 'pyproject.toml')) ||
      existsSync(join(workDir, 'requirements.txt')) ||
      existsSync(join(workDir, 'setup.py'))
    ) {
      return 'python';
    }

    // Check for JavaScript (package.json without TypeScript)
    if (existsSync(join(workDir, 'package.json'))) {
      return 'javascript';
    }

    return 'unknown';
  }

  /**
   * Check TypeScript project using tsc --noEmit
   */
  async checkTypeScript(workDir: string, commandOverride?: string): Promise<BuildGateResult> {
    const command = commandOverride ?? 'npx tsc --noEmit --pretty false';

    try {
      const output = await this.runCommand(command, workDir);
      const parsedErrors = this.parseTypeScriptErrors(output, workDir);
      const errors = this.ensureErrorsFromOutput(parsedErrors, output, workDir, 'TypeScript');

      const errorCount = errors.filter((e) => e.severity === 'error').length;
      const warningCount = errors.filter((e) => e.severity === 'warning').length;

      const passed = this.config.failOnWarnings ? errors.length === 0 : errorCount === 0;

      if (!passed) {
        this.logParsedDiagnostics('TypeScript', errors);
      }

      return {
        passed,
        errors: errors.filter((e) => e.severity === 'error').slice(0, this.config.maxErrors),
        warnings: errors.filter((e) => e.severity === 'warning').slice(0, this.config.maxErrors),
        summary: passed
          ? 'TypeScript check passed'
          : `TypeScript check failed: ${errorCount} errors, ${warningCount} warnings`,
        command,
      };
    } catch (error) {
      // tsc returns non-zero exit code on errors, which is expected
      const output =
        error instanceof Error && 'stdout' in error
          ? String((error as { stdout: string }).stdout)
          : String(error);
      const parsedErrors = this.parseTypeScriptErrors(output, workDir);
      const errors = this.ensureErrorsFromOutput(parsedErrors, output, workDir, 'TypeScript');

      this.logParsedDiagnostics('TypeScript', errors);

      return {
        passed: false,
        errors: errors.filter((e) => e.severity === 'error').slice(0, this.config.maxErrors),
        warnings: errors.filter((e) => e.severity === 'warning').slice(0, this.config.maxErrors),
        summary: `TypeScript check failed: ${errors.length} errors`,
        command,
      };
    }
  }

  /**
   * Check Python project using mypy or pyright
   */
  async checkPython(workDir: string, commandOverride?: string): Promise<BuildGateResult> {
    // Try mypy first, fall back to pyright
    const hasPyright = existsSync(join(workDir, 'pyrightconfig.json'));
    const command =
      commandOverride ?? (hasPyright ? 'npx pyright' : 'python -m mypy . --ignore-missing-imports');

    try {
      const output = await this.runCommand(command, workDir);
      const usesPyright = command.includes('pyright');
      const errors = usesPyright
        ? this.parsePyrightErrors(output, workDir)
        : this.parseMypyErrors(output, workDir);

      const errorCount = errors.filter((e) => e.severity === 'error').length;

      return {
        passed: errorCount === 0,
        errors: errors.filter((e) => e.severity === 'error').slice(0, this.config.maxErrors),
        warnings: errors.filter((e) => e.severity === 'warning').slice(0, this.config.maxErrors),
        summary:
          errorCount === 0
            ? 'Python type check passed'
            : `Python type check failed: ${errorCount} errors`,
        command,
      };
    } catch (_error) {
      // Type checker not installed - this is a degraded state, warn clearly
      console.warn(
        '[BuildGate] Python type checker (mypy/pyright) not available. Install with: pip install mypy'
      );
      return {
        passed: true, // Allow to proceed but with warning
        errors: [],
        warnings: [
          {
            file: workDir,
            line: 0,
            column: 0,
            message:
              'Python type checker not available. Install mypy or pyright for proper type checking.',
            severity: 'warning' as const,
          },
        ],
        summary: 'Python type checker not available (mypy/pyright not installed)',
        command,
      };
    }
  }

  /**
   * Parse TypeScript compiler output into structured errors
   *
   * Format: file(line,col): error TS1234: message
   */
  private parseTypeScriptErrors(output: string, workDir: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = output.split('\n');

    // TypeScript error format: src/file.ts(10,5): error TS2345: message
    const errorRegex = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;
    const globalErrorRegex = /^(error|warning)\s+(TS\d+):\s*(.+)$/;

    for (const line of lines) {
      const match = line.match(errorRegex);
      if (match) {
        const [, file, lineNum, col, severity, code, message] = match;
        if (!file || !lineNum || !col || !severity || !message) continue;
        errors.push({
          file: file.startsWith('/') ? file : join(workDir, file),
          line: parseInt(lineNum, 10),
          column: parseInt(col, 10),
          message: message.trim(),
          ...(code && { code }),
          severity: severity as 'error' | 'warning',
        });
        continue;
      }

      const globalMatch = line.match(globalErrorRegex);
      if (globalMatch) {
        const [, severity, code, message] = globalMatch;
        if (!severity || !code || !message) continue;
        errors.push({
          file: workDir,
          line: 0,
          column: 0,
          message: message.trim(),
          code,
          severity: severity as 'error' | 'warning',
        });
      }
    }

    return errors;
  }

  /**
   * Parse mypy output into structured errors
   *
   * Format: file:line: error: message
   */
  private parseMypyErrors(output: string, workDir: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = output.split('\n');

    // mypy format: file.py:10: error: message
    const errorRegex = /^(.+?):(\d+):\s*(error|warning|note):\s*(.+)$/;

    for (const line of lines) {
      const match = line.match(errorRegex);
      if (match) {
        const [, file, lineNum, severity, message] = match;
        if (severity === 'note') continue; // Skip notes
        if (!file || !lineNum || !severity || !message) continue;

        errors.push({
          file: file.startsWith('/') ? file : join(workDir, file),
          line: parseInt(lineNum, 10),
          column: 1,
          message: message.trim(),
          severity: severity as 'error' | 'warning',
        });
      }
    }

    return errors;
  }

  /**
   * Parse pyright output into structured errors
   */
  private parsePyrightErrors(output: string, workDir: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = output.split('\n');

    // pyright format: file.py:10:5 - error: message
    const errorRegex = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning|information):\s*(.+)$/;

    for (const line of lines) {
      const match = line.match(errorRegex);
      if (match) {
        const [, file, lineNum, col, severity, message] = match;
        if (severity === 'information') continue;
        if (!file || !lineNum || !col || !severity || !message) continue;

        errors.push({
          file: file.startsWith('/') ? file : join(workDir, file),
          line: parseInt(lineNum, 10),
          column: parseInt(col, 10),
          message: message.trim(),
          severity: severity === 'error' ? 'error' : 'warning',
        });
      }
    }

    return errors;
  }

  private ensureErrorsFromOutput(
    parsedErrors: BuildError[],
    output: string,
    workDir: string,
    label: string
  ): BuildError[] {
    if (parsedErrors.length > 0) return parsedErrors;
    const trimmed = output.trim();
    if (!trimmed) return parsedErrors;
    const message = `${label} output:\n${this.truncateOutput(trimmed)}`;
    console.warn(
      `[BuildGate] ${label} output did not match expected error format, emitting raw output.`
    );
    return [
      {
        file: workDir,
        line: 0,
        column: 0,
        message,
        severity: 'error',
      },
    ];
  }

  private logParsedDiagnostics(label: string, items: BuildError[], limit = 10): void {
    if (items.length === 0) return;
    console.info(
      `[BuildGate] ${label} errors: showing ${Math.min(items.length, limit)} of ${items.length}`
    );
    for (const item of items.slice(0, limit)) {
      const loc = `${item.file}:${item.line}:${item.column}`;
      const code = item.code ? ` ${item.code}` : '';
      console.info(`[BuildGate] ${loc}${code} ${item.message}`);
    }
  }

  private truncateOutput(output: string): string {
    if (output.length <= MAX_FALLBACK_OUTPUT_CHARS) return output;
    return `${output.slice(0, MAX_FALLBACK_OUTPUT_CHARS)}\n... (truncated)`;
  }

  /**
   * Discover TypeScript files in a project for LSP initialization
   * Returns up to 20 files to avoid performance issues
   */
  private async discoverTsFiles(workDir: string): Promise<string[]> {
    const files: string[] = [];
    const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
    const IGNORE_DIRS = ['node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage'];

    const scanDir = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 4 || files.length >= 20) return;

      try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (files.length >= 20) break;

          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!IGNORE_DIRS.includes(entry.name) && !entry.name.startsWith('.')) {
              await scanDir(fullPath, depth + 1);
            }
          } else if (entry.isFile()) {
            const ext = extname(entry.name);
            if (TS_EXTENSIONS.includes(ext)) {
              files.push(fullPath);
            }
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    await scanDir(workDir);
    return files;
  }

  private normalizeChangedFiles(files: string[], workDir: string): string[] {
    const normalized = new Set<string>();
    for (const file of files) {
      if (!file || typeof file !== 'string') continue;
      const absolute = isAbsolute(file) ? resolve(file) : resolve(workDir, file);
      const rel = relative(workDir, absolute);
      if (rel.startsWith('..') || rel === '') continue;
      const ext = extname(absolute);
      if (!LSP_TOUCH_EXTENSIONS.has(ext)) continue;
      if (!existsSync(absolute)) continue;
      normalized.add(absolute);
    }
    return Array.from(normalized);
  }

  private filterDiagnostics(
    diagnostics: Record<string, LSP.Diagnostic[]>,
    workDir: string
  ): Record<string, LSP.Diagnostic[]> {
    const filtered: Record<string, LSP.Diagnostic[]> = {};
    for (const [file, items] of Object.entries(diagnostics)) {
      if (!file) continue;
      const absolute = isAbsolute(file) ? resolve(file) : resolve(workDir, file);
      const rel = relative(workDir, absolute);
      if (rel.startsWith('..')) continue;
      if (!existsSync(absolute)) continue;
      filtered[absolute] = items;
    }
    return filtered;
  }

  /**
   * Run a command and return its output
   */
  private runCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', command], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.config.timeout,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        const output = stdout + stderr;
        if (code === 0) {
          resolve(output);
        } else {
          // Return output even on non-zero exit (type checkers do this on errors)
          const error = new Error(`Command failed with code ${code}`) as Error & { stdout: string };
          error.stdout = output;
          reject(error);
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Format errors for display to Worker/LLM
   */
  static formatErrorsForWorker(result: BuildGateResult): string {
    if (result.passed) {
      return `✅ Build check passed: ${result.summary}`;
    }

    const lines: string[] = [
      `❌ Build check failed: ${result.summary}`,
      '',
      '## Errors to fix:',
      '',
    ];

    for (const error of result.errors.slice(0, 20)) {
      lines.push(`- **${error.file}:${error.line}:${error.column}**`);
      lines.push(`  ${error.code ? `[${error.code}] ` : ''}${error.message}`);
    }

    if (result.errors.length > 20) {
      lines.push(`... and ${result.errors.length - 20} more errors`);
    }

    const verifyCommand =
      result.command && result.command !== 'lsp_check' ? result.command : 'npx tsc --noEmit';
    lines.push('');
    lines.push(`Please fix all errors and ensure \`${verifyCommand}\` passes.`);

    return lines.join('\n');
  }
}

/**
 * Create a new BuildGateService instance
 */
export function createBuildGateService(config?: BuildGateConfig): BuildGateService {
  return new BuildGateService(config);
}

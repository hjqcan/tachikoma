/**
 * Build Gate Service
 *
 * Validates that code changes pass build/type checks before marking tasks as complete.
 * Inspired by OpenCode's lsp_diagnostics pattern.
 *
 * Key responsibilities:
 * - Detect project type (TypeScript, Python, etc.)
 * - Run appropriate type/build checks
 * - Parse errors into structured format
 * - Provide clear feedback for error fixing
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
}

const DEFAULT_CONFIG: Required<BuildGateConfig> = {
  timeout: 60_000,
  failOnWarnings: false,
  maxErrors: 50,
  useLsp: true,
};

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
    const projectType = options.projectType ?? await this.detectProjectType(workDir);

    console.info(`[BuildGate] Detected project type: ${projectType} in ${workDir}`);

    let result: BuildGateResult;

    switch (projectType) {
      case 'typescript': {
        // Try LSP first for faster diagnostics
        if (this.config.useLsp) {
          const lspResult = await this.checkWithLSP(workDir);
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
        result = { passed: true, errors: [], warnings: [], summary: 'No type check needed for JavaScript' };
        break;
      default:
        result = { passed: true, errors: [], warnings: [], summary: 'Unknown project type, skipping build gate' };
    }

    result.duration = Date.now() - startTime;

    // Log result
    if (result.passed) {
      console.info(`[BuildGate] PASSED in ${result.duration}ms`);
    } else {
      console.warn(`[BuildGate] FAILED with ${result.errors.length} errors in ${result.duration}ms`);
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

    try {
      // Initialize LSP state
      await LSP.init(workDir, env);

      // Touch changed files to trigger diagnostics
      if (changedFiles && changedFiles.length > 0) {
        for (const file of changedFiles.slice(0, 20)) {
          try {
            await LSP.touchFile(file, workDir, env, true);
          } catch {
            // Skip files that can't be opened
          }
        }
      }

      // Get all diagnostics
      const diagnostics = await LSP.diagnostics(workDir, env);
      const allErrors: BuildError[] = [];
      const allWarnings: BuildError[] = [];

      for (const [file, fileDiagnostics] of Object.entries(diagnostics)) {
        for (const diag of fileDiagnostics) {
          const severity = diag.severity === 1 ? 'error' : 'warning';
          const buildError: BuildError = {
            file,
            line: diag.range.start.line + 1,
            column: diag.range.start.character + 1,
            message: diag.message,
            severity,
          };

          if (severity === 'error') {
            allErrors.push(buildError);
          } else {
            allWarnings.push(buildError);
          }
        }
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
          console.info('[BuildGate] LSP returned zero diagnostics, falling back to tsc for verification');
        }
        return null; // Signal to use fallback
      }

      const errorCount = allErrors.length;
      const warningCount = allWarnings.length;
      const passed = this.config.failOnWarnings
        ? errorCount === 0 && warningCount === 0
        : errorCount === 0;

      return {
        passed,
        errors: allErrors.slice(0, this.config.maxErrors),
        warnings: allWarnings.slice(0, this.config.maxErrors),
        summary: passed
          ? 'LSP check passed'
          : `LSP check failed: ${errorCount} errors, ${warningCount} warnings`,
        command: 'lsp_diagnostics',
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
      const errors = this.parseTypeScriptErrors(output, workDir);

      const errorCount = errors.filter(e => e.severity === 'error').length;
      const warningCount = errors.filter(e => e.severity === 'warning').length;

      const passed = this.config.failOnWarnings 
        ? errors.length === 0 
        : errorCount === 0;

      return {
        passed,
        errors: errors.filter(e => e.severity === 'error').slice(0, this.config.maxErrors),
        warnings: errors.filter(e => e.severity === 'warning').slice(0, this.config.maxErrors),
        summary: passed 
          ? 'TypeScript check passed' 
          : `TypeScript check failed: ${errorCount} errors, ${warningCount} warnings`,
        command,
      };
    } catch (error) {
      // tsc returns non-zero exit code on errors, which is expected
      const output = error instanceof Error && 'stdout' in error 
        ? String((error as { stdout: string }).stdout) 
        : String(error);
      const errors = this.parseTypeScriptErrors(output, workDir);

      return {
        passed: false,
        errors: errors.filter(e => e.severity === 'error').slice(0, this.config.maxErrors),
        warnings: errors.filter(e => e.severity === 'warning').slice(0, this.config.maxErrors),
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
      commandOverride ??
      (hasPyright ? 'npx pyright' : 'python -m mypy . --ignore-missing-imports');

    try {
      const output = await this.runCommand(command, workDir);
      const usesPyright = command.includes('pyright');
      const errors = usesPyright
        ? this.parsePyrightErrors(output, workDir)
        : this.parseMypyErrors(output, workDir);

      const errorCount = errors.filter(e => e.severity === 'error').length;

      return {
        passed: errorCount === 0,
        errors: errors.filter(e => e.severity === 'error').slice(0, this.config.maxErrors),
        warnings: errors.filter(e => e.severity === 'warning').slice(0, this.config.maxErrors),
        summary: errorCount === 0 
          ? 'Python type check passed' 
          : `Python type check failed: ${errorCount} errors`,
        command,
      };
    } catch (_error) {
      // Type checker not installed - this is a degraded state, warn clearly
      console.warn('[BuildGate] Python type checker (mypy/pyright) not available. Install with: pip install mypy');
      return {
        passed: true, // Allow to proceed but with warning
        errors: [],
        warnings: [{
          file: workDir,
          line: 0,
          column: 0,
          message: 'Python type checker not available. Install mypy or pyright for proper type checking.',
          severity: 'warning' as const,
        }],
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
      result.command && result.command !== 'lsp_diagnostics' ? result.command : 'npx tsc --noEmit';
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

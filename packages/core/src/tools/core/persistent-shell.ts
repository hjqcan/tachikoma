/**
 * PersistentShell - Maintains a long-running shell process for efficient command execution
 * 
 * Inspired by Codex's persistent shell architecture, this avoids per-command spawn overhead
 * and solves timeout issues for long-running commands like `npm install`.
 * 
 * Key features:
 * - Single shell process reused for all commands
 * - Marker-based command completion detection (no prompt parsing)
 * - Per-command timeout support
 * - Output buffering and streaming
 * - Proper process cleanup
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mergeEnv } from '../env-utils';
import type { ExecutionContext } from '../../types';

// =============================================================================
// Types
// =============================================================================

export interface PersistentShellOptions {
  /** Working directory for the shell */
  cwd: string;
  /** Environment variables (merged with process.env) */
  env?: NodeJS.ProcessEnv;
  /** Shell to use (defaults to /bin/bash on Unix, cmd.exe on Windows) */
  shell?: string;
  /** Default timeout for commands in milliseconds (default: 5 minutes) */
  defaultTimeout?: number;
  /** Execution context for env merging */
  context?: ExecutionContext;
}

export interface CommandResult {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code of the command */
  exitCode: number;
  /** Whether the command timed out */
  timedOut?: boolean;
  /** Duration in milliseconds */
  duration: number;
}

export interface CommandOptions {
  /** Working directory for this command (will cd before execution) */
  cwd?: string;
  /** Additional environment variables for this command */
  env?: Record<string, string>;
  /** Timeout in milliseconds */
  timeout?: number;
}

export interface PendingCommand {
  id: string;
  command: string;
  timeout: number;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  startTime: number;
  timeoutId?: ReturnType<typeof setTimeout>;
  stdout: string;
  stderr: string;
  completed: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const MAX_OUTPUT_BUFFER = 1024 * 1024; // 1MB output buffer limit
const MARKER_PREFIX = '__TACHIKOMA_CMD_';
const START_MARKER = (id: string) => `${MARKER_PREFIX}START_${id}__`;
const END_MARKER_REGEX = new RegExp(`${MARKER_PREFIX}END_([a-zA-Z0-9]+)_(\\d+)__`);

// Shell initialization commands to set up a clean environment
const SHELL_INIT_COMMANDS = [
  'set +o history 2>/dev/null || true',  // Disable history (ignore if fails)
  'export PS1=""',   // Clear prompt to reduce noise
  'export PS2=""',   // Clear continuation prompt
];

// =============================================================================
// PersistentShell Class
// =============================================================================

export class PersistentShell extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: Required<Omit<PersistentShellOptions, 'context'>> & { context?: ExecutionContext };
  private outputBuffer = '';
  private currentCommand: PendingCommand | null = null;
  private commandQueue: PendingCommand[] = [];
  private commandIdCounter = 0;
  private isInitialized = false;
  private isDestroyed = false;
  // NOTE: We no longer track currentCwd because we always cd to workDir before each command
  // This is the MAINTAIN_PROJECT_WORKING_DIR fix inspired by Claude Code
  private isWindows = process.platform === 'win32';

  constructor(options: PersistentShellOptions) {
    super();
    this.options = {
      cwd: options.cwd,
      env: options.env ?? {},
      shell: options.shell ?? this.getDefaultShell(),
      defaultTimeout: options.defaultTimeout ?? DEFAULT_TIMEOUT,
      ...(options.context !== undefined ? { context: options.context } : {}),
    };
  }

  /**
   * Get the default shell based on platform
   */
  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    // Prefer bash for consistency, fall back to sh
    return '/bin/bash';
  }

  /**
   * Initialize the shell process if not already started
   */
  private async ensureStarted(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('PersistentShell has been destroyed');
    }

    if (this.process && this.isInitialized) {
      return;
    }

    await this.start();
  }

  /**
   * Start the shell process
   */
  private async start(): Promise<void> {
    const env = this.options.context 
      ? mergeEnv(this.options.context)
      : { ...process.env, ...this.options.env };

    // Do NOT use -i (interactive) to avoid rc script noise and side effects
    // Use -l (login) only on Unix to get PATH from profile
    const shellArgs = this.isWindows 
      ? [] 
      : (this.options.shell.includes('bash') || this.options.shell.includes('zsh')) 
        ? [] // No flags - cleaner execution
        : [];

    this.process = spawn(this.options.shell, shellArgs, {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    if (!this.process.pid) {
      throw new Error('Failed to start shell process');
    }

    // Handle stdout
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleOutput(data.toString(), 'stdout');
    });

    // Handle stderr
    this.process.stderr?.on('data', (data: Buffer) => {
      this.handleOutput(data.toString(), 'stderr');
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      this.handleProcessExit();
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
      this.handleProcessExit();
    });

    // Initialize the shell
    await this.initializeShell();
    this.isInitialized = true;
    this.emit('ready');
  }

  /**
   * Initialize shell with clean environment
   */
  private async initializeShell(): Promise<void> {
    for (const cmd of SHELL_INIT_COMMANDS) {
      this.writeToStdin(cmd + '\n');
    }
    // Wait a bit for initialization
    await this.sleep(100);
    // Clear any initialization output
    this.outputBuffer = '';
  }

  /**
   * Handle output from the shell
   */
  private handleOutput(data: string, source: 'stdout' | 'stderr'): void {
    // Limit output buffer to prevent memory pressure
    if (this.outputBuffer.length < MAX_OUTPUT_BUFFER) {
      this.outputBuffer += data;
    }
    this.emit('output', { data, source });

    // Check for command completion marker
    if (this.currentCommand && !this.currentCommand.completed) {
      // Append to command output (with limit)
      if (source === 'stdout') {
        if (this.currentCommand.stdout.length < MAX_OUTPUT_BUFFER) {
          this.currentCommand.stdout += data;
        }
      } else {
        if (this.currentCommand.stderr.length < MAX_OUTPUT_BUFFER) {
          this.currentCommand.stderr += data;
        }
      }

      // Check if command completed
      const match = END_MARKER_REGEX.exec(this.outputBuffer);
      if (match && match[1] === this.currentCommand.id) {
        const rawExitCode = match[2];
        const exitCode = rawExitCode ? parseInt(rawExitCode, 10) : 0;
        this.completeCurrentCommand(exitCode);
      }
    }
  }

  /**
   * Complete the current command with the given exit code
   */
  private completeCurrentCommand(exitCode: number, timedOut = false): void {
    const cmd = this.currentCommand;
    if (!cmd || cmd.completed) return;

    cmd.completed = true;
    if (cmd.timeoutId) {
      clearTimeout(cmd.timeoutId);
    }

    // Clean up markers from output
    const cleanOutput = (text: string): string => {
      return text
        .replace(new RegExp(START_MARKER(cmd.id), 'g'), '')
        .replace(new RegExp(`${MARKER_PREFIX}END_${cmd.id}_\\d+__`, 'g'), '')
        .trim();
    };

    const result: CommandResult = {
      stdout: cleanOutput(cmd.stdout),
      stderr: cleanOutput(cmd.stderr),
      exitCode: timedOut ? 124 : exitCode, // 124 is standard timeout exit code
      timedOut,
      duration: Date.now() - cmd.startTime,
    };

    cmd.resolve(result);
    this.currentCommand = null;
    this.outputBuffer = '';

    // Process next command in queue
    this.processQueue();
  }

  /**
   * Handle shell process exit
   */
  private handleProcessExit(): void {
    // Reject current command if any
    if (this.currentCommand && !this.currentCommand.completed) {
      this.currentCommand.completed = true;
      if (this.currentCommand.timeoutId) {
        clearTimeout(this.currentCommand.timeoutId);
      }
      this.currentCommand.reject(new Error('Shell process exited unexpectedly'));
    }

    // Reject all queued commands
    for (const cmd of this.commandQueue) {
      cmd.reject(new Error('Shell process exited'));
    }
    this.commandQueue = [];

    this.process = null;
    this.isInitialized = false;
  }

  /**
   * Write to shell stdin
   */
  private writeToStdin(data: string): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(data);
    }
  }

  /**
   * Process the next command in the queue
   */
  private processQueue(): void {
    if (this.currentCommand || this.commandQueue.length === 0) {
      return;
    }

    const nextCommand = this.commandQueue.shift()!;
    this.executeCommandInternal(nextCommand);
  }

  /**
   * Execute a command (internal, called after queuing)
   */
  private executeCommandInternal(pending: PendingCommand): void {
    this.currentCommand = pending;
    pending.startTime = Date.now();

    // Set up timeout
    pending.timeoutId = setTimeout(() => {
      if (!pending.completed) {
        console.warn(`[PersistentShell] Command timed out after ${pending.timeout}ms: ${pending.command.substring(0, 50)}...`);
        // Send Ctrl+C to interrupt the command
        this.writeToStdin('\x03');
        // Give it a moment to respond, then complete with timeout
        setTimeout(() => {
          if (!pending.completed) {
            this.completeCurrentCommand(124, true);
          }
        }, 500);
      }
    }, pending.timeout);

    // Wrap command with markers - platform-specific syntax
    // Format: echo START; command; capture exit code; echo END_exitcode
    let wrappedCommand: string;
    
    if (this.isWindows) {
      // Windows cmd.exe syntax:
      // - No echo -n, use <nul set /p to avoid newline
      // - Use %ERRORLEVEL% instead of $?
      // - Use & or && instead of ;
      wrappedCommand = [
        `<nul set /p ="${START_MARKER(pending.id)}"`,
        pending.command,
        `set __exit_code__=%ERRORLEVEL%`,
        `echo ${MARKER_PREFIX}END_${pending.id}_%__exit_code__%__`,
      ].join(' & ');
    } else {
      // POSIX (bash/zsh/sh) syntax
      wrappedCommand = [
        `echo -n "${START_MARKER(pending.id)}"`,
        pending.command,
        `__exit_code__=$?`,
        `echo "${MARKER_PREFIX}END_${pending.id}_\${__exit_code__}__"`,
      ].join('; ');
    }

    this.writeToStdin(wrappedCommand + '\n');
  }

  /**
   * Generate a unique command ID
   */
  private generateCommandId(): string {
    return `cmd${++this.commandIdCounter}${Date.now().toString(36)}`;
  }

  /**
   * Simple sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Execute a command in the persistent shell
   * 
   * @param command - The command to execute
   * @param options - Optional command options (cwd, env, timeout)
   * @returns Promise with command result
   */
  async execute(command: string, options?: CommandOptions | number): Promise<CommandResult> {
    await this.ensureStarted();

    // Support legacy signature: execute(command, timeout)
    const opts: CommandOptions = typeof options === 'number' 
      ? { timeout: options }
      : options || {};

    return new Promise((resolve, reject) => {
      // Build the actual command with cd and env exports if needed
      const commandParts: string[] = [];
      
      // CRITICAL FIX (Claude Code style MAINTAIN_PROJECT_WORKING_DIR):
      // Always cd to initial workDir first to reset any drift from embedded cd commands
      // This prevents issues like "cd frontend && npm install" permanently changing the CWD
      commandParts.push(`cd ${this.escapeShellArg(this.options.cwd)}`);
      
      // Then handle per-call cwd if specified (relative to workDir)
      if (opts.cwd && opts.cwd !== this.options.cwd) {
        commandParts.push(`cd ${this.escapeShellArg(opts.cwd)}`);
      }
      
      // Handle environment variables
      if (opts.env && Object.keys(opts.env).length > 0) {
        for (const [key, value] of Object.entries(opts.env)) {
          if (this.isWindows) {
            // Windows: set VAR=value
            commandParts.push(`set ${key}=${value}`);
          } else {
            // Unix: export VAR=value
            commandParts.push(`export ${key}=${this.escapeShellArg(value)}`);
          }
        }
      }
      
      // Add the actual command
      commandParts.push(command);
      
      // Join with appropriate separator
      const fullCommand = this.isWindows 
        ? commandParts.join(' && ')
        : commandParts.join('; ');

      const pending: PendingCommand = {
        id: this.generateCommandId(),
        command: fullCommand,
        timeout: opts.timeout || this.options.defaultTimeout,
        resolve,
        reject,
        startTime: 0,
        stdout: '',
        stderr: '',
        completed: false,
      };

      // Queue the command
      this.commandQueue.push(pending);

      // Process queue if not currently executing
      if (!this.currentCommand) {
        this.processQueue();
      }
    });
  }

  /**
   * Escape a string for safe use in shell commands
   */
  private escapeShellArg(arg: string): string {
    if (this.isWindows) {
      // Windows escaping - wrap in double quotes
      return `"${arg.replace(/"/g, '""')}"`;
    }
    // Unix escaping - wrap in single quotes
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Change the working directory
   */
  async cd(directory: string): Promise<CommandResult> {
    return this.execute(`cd ${JSON.stringify(directory)} && pwd`);
  }

  /**
   * Check if the shell process is alive
   */
  isAlive(): boolean {
    return !this.isDestroyed && this.process !== null && !this.process.killed;
  }

  /**
   * Get the process ID of the shell
   */
  getPid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Destroy the shell process
   */
  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    // Clear timeout for current command
    if (this.currentCommand?.timeoutId) {
      clearTimeout(this.currentCommand.timeoutId);
    }

    // Kill the process group
    if (this.process?.pid) {
      try {
        if (process.platform === 'win32') {
          // Windows: use taskkill
          spawn('taskkill', ['/pid', String(this.process.pid), '/f', '/t'], { stdio: 'ignore' });
        } else {
          // Unix: kill process group
          process.kill(-this.process.pid, 'SIGTERM');
          await this.sleep(200);
          try {
            process.kill(-this.process.pid, 'SIGKILL');
          } catch {
            // Process may have already exited
          }
        }
      } catch {
        // Process may have already exited
        this.process?.kill('SIGKILL');
      }
    }

    this.process = null;
    this.emit('destroyed');
  }
}

export default PersistentShell;
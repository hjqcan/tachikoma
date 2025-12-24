/**
 * ShellSessionManager - Manages multiple persistent shell sessions
 * 
 * Provides session scoping per task/agent combination and handles
 * automatic cleanup when tasks complete.
 */

import { PersistentShell, type PersistentShellOptions, type CommandResult } from './persistent-shell';
import { EventEmitter } from 'node:events';

// =============================================================================
// Types
// =============================================================================

export interface SessionInfo {
  id: string;
  taskId: string;
  agentId: string;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  commandCount: number;
  isAlive: boolean;
}

export interface CreateSessionOptions extends Omit<PersistentShellOptions, 'context'> {
  taskId: string;
  agentId: string;
}

// =============================================================================
// ShellSessionManager
// =============================================================================

/**
 * Manages persistent shell sessions with automatic lifecycle management
 */
export class ShellSessionManager extends EventEmitter {
  private static instance: ShellSessionManager | null = null;
  private sessions = new Map<string, { shell: PersistentShell; info: SessionInfo }>();

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): ShellSessionManager {
    if (!ShellSessionManager.instance) {
      ShellSessionManager.instance = new ShellSessionManager();
    }
    return ShellSessionManager.instance;
  }

  /**
   * Generate a session ID from task and agent IDs
   */
  private generateSessionId(taskId: string, agentId: string): string {
    return `${taskId}:${agentId}`;
  }

  /**
   * Get or create a shell session for the given task/agent
   */
  getOrCreate(options: CreateSessionOptions): PersistentShell {
    const sessionId = this.generateSessionId(options.taskId, options.agentId);
    
    const existing = this.sessions.get(sessionId);
    if (existing && existing.shell.isAlive()) {
      existing.info.lastUsedAt = Date.now();
      return existing.shell;
    }

    // Clean up dead session if it exists
    if (existing) {
      this.sessions.delete(sessionId);
    }

    // Create new session
    const shell = new PersistentShell({
      cwd: options.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.shell !== undefined ? { shell: options.shell } : {}),
      ...(options.defaultTimeout !== undefined
        ? { defaultTimeout: options.defaultTimeout }
        : {}),
    });

    const info: SessionInfo = {
      id: sessionId,
      taskId: options.taskId,
      agentId: options.agentId,
      cwd: options.cwd,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      commandCount: 0,
      isAlive: true,
    };

    // Track command count
    shell.on('output', () => {
      info.lastUsedAt = Date.now();
    });

    shell.on('exit', () => {
      info.isAlive = false;
    });

    shell.on('destroyed', () => {
      info.isAlive = false;
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, { shell, info });
    this.emit('session:created', info);

    return shell;
  }

  /**
   * Get an existing session if it exists and is alive
   */
  get(taskId: string, agentId: string): PersistentShell | null {
    const sessionId = this.generateSessionId(taskId, agentId);
    const session = this.sessions.get(sessionId);
    
    if (session && session.shell.isAlive()) {
      session.info.lastUsedAt = Date.now();
      return session.shell;
    }
    
    return null;
  }

  /**
   * Execute a command in a session, creating one if needed
   */
  async execute(
    taskId: string,
    agentId: string,
    command: string,
    options: Omit<CreateSessionOptions, 'taskId' | 'agentId'>
  ): Promise<CommandResult> {
    const shell = this.getOrCreate({
      taskId,
      agentId,
      ...options,
    });

    const sessionId = this.generateSessionId(taskId, agentId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.info.commandCount++;
    }

    return shell.execute(command, options.defaultTimeout);
  }

  /**
   * Destroy a specific session
   */
  async destroy(taskId: string, agentId: string): Promise<void> {
    const sessionId = this.generateSessionId(taskId, agentId);
    const session = this.sessions.get(sessionId);
    
    if (session) {
      await session.shell.destroy();
      this.sessions.delete(sessionId);
      this.emit('session:destroyed', session.info);
    }
  }

  /**
   * Destroy all sessions for a specific task
   */
  async destroyForTask(taskId: string): Promise<void> {
    const toDestroy: string[] = [];
    
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (session.info.taskId === taskId) {
        toDestroy.push(sessionId);
      }
    }

    await Promise.all(
      toDestroy.map(async (sessionId) => {
        const session = this.sessions.get(sessionId);
        if (session) {
          await session.shell.destroy();
          this.sessions.delete(sessionId);
          this.emit('session:destroyed', session.info);
        }
      })
    );
  }

  /**
   * Destroy all sessions
   */
  async destroyAll(): Promise<void> {
    const allSessions = Array.from(this.sessions.entries());
    
    await Promise.all(
      allSessions.map(async ([sessionId, session]) => {
        await session.shell.destroy();
        this.sessions.delete(sessionId);
        this.emit('session:destroyed', session.info);
      })
    );
  }

  /**
   * Get information about all active sessions
   */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .map(({ info, shell }) => ({
        ...info,
        isAlive: shell.isAlive(),
      }));
  }

  /**
   * Get session count
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Clean up dead sessions
   */
  cleanup(): void {
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (!session.shell.isAlive()) {
        this.sessions.delete(sessionId);
        this.emit('session:cleaned', session.info);
      }
    }
  }
}

// Export singleton accessor
export const shellSessionManager = ShellSessionManager.getInstance();

export default ShellSessionManager;

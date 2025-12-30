/**
 * DevServerManager
 * 
 * Manages dev server lifecycle for smoke testing:
 * - Start dev server in background
 * - Wait for port to become available
 * - Stop server when done
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';

// =============================================================================
// Types
// =============================================================================

export interface DevServerConfig {
  /** Command to start the dev server (e.g., 'npm run dev') */
  command: string;
  
  /** Working directory */
  cwd: string;
  
  /** Port to wait for */
  port: number;
  
  /** Host (default: localhost) */
  host?: string;
  
  /** Timeout for server to start (ms, default: 60000) */
  startTimeout?: number;
  
  /** Interval to check port (ms, default: 500) */
  pollInterval?: number;
}

export interface DevServerHandle {
  /** Server URL */
  url: string;
  
  /** Process ID */
  pid: number;
  
  /** Process handle */
  process: ChildProcess;
  
  /** Stop the server */
  stop: () => Promise<void>;
  
  /** Server logs */
  logs: string;
}

// =============================================================================
// DevServerManager
// =============================================================================

export class DevServerManager {
  private activeServers: Map<number, DevServerHandle> = new Map<number, DevServerHandle>();

  /**
   * Start a dev server and wait for it to become available
   */
  async start(config: DevServerConfig): Promise<DevServerHandle> {
    const {
      command,
      cwd,
      port,
      host = 'localhost',
      startTimeout = 60000,
      pollInterval = 500,
    } = config;

    console.info(`[DevServer] Starting: ${command} on port ${port}`);
    
    // Parse command
    const [cmd, ...args] = command.split(' ');
    if (!cmd) {
      throw new Error('Invalid command');
    }

    // Start the process
    const child = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let logs = '';
    
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      logs += text;
      // Look for common "ready" messages
      if (text.includes('ready') || text.includes('listening') || text.includes('started')) {
        console.info(`[DevServer] Ready signal detected`);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      logs += data.toString();
    });

    // Wait for port to become available
    const url = `http://${host}:${port}`;
    const startTime = Date.now();

    while (Date.now() - startTime < startTimeout) {
      if (await this.isPortOpen(host, port)) {
        console.info(`[DevServer] Port ${port} is open after ${Date.now() - startTime}ms`);
        break;
      }
      await this.sleep(pollInterval);
    }

    // Final check
    if (!await this.isPortOpen(host, port)) {
      // Kill the process
      this.killProcess(child);
      throw new Error(`Dev server failed to start within ${startTimeout}ms. Logs:\n${logs.slice(-2000)}`);
    }

    // Create handle
    const handle: DevServerHandle = {
      url,
      pid: child.pid ?? 0,
      process: child,
      logs,
      stop: async () => {
        console.info(`[DevServer] Stopping server on port ${port}`);
        this.killProcess(child);
        this.activeServers.delete(child.pid ?? 0);
        // Wait for process to actually exit
        await new Promise<void>((resolve) => {
          child.on('exit', () => resolve());
          setTimeout(resolve, 2000); // Timeout
        });
      },
    };

    if (child.pid) {
      this.activeServers.set(child.pid, handle);
    }

    console.info(`[DevServer] Server started: ${url} (pid: ${child.pid})`);
    return handle;
  }

  /**
   * Stop all active servers
   */
  async stopAll(): Promise<void> {
    console.info(`[DevServer] Stopping ${this.activeServers.size} servers`);
    const handles = Array.from(this.activeServers.values());
    await Promise.all(handles.map(h => h.stop().catch(() => undefined)));
    this.activeServers.clear();
  }

  /**
   * Check if a port is open
   */
  private isPortOpen(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket: Socket = createConnection({ host, port });
      
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      
      // Timeout
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Kill a process and its children
   */
  private killProcess(child: ChildProcess): void {
    try {
      const pid = child.pid;
      if (pid && process.platform !== 'win32') {
        // Try to kill the entire process group when detached
        process.kill(-pid, 'SIGTERM');
      } else {
        child.kill('SIGTERM');
      }
      
      // Force kill after 2 seconds
      setTimeout(() => {
        try {
          if (!child.killed) {
            if (pid && process.platform !== 'win32') {
              process.kill(-pid, 'SIGKILL');
            } else {
              child.kill('SIGKILL');
            }
          }
        } catch {
          // Process may have already exited (ESRCH)
        }
      }, 2000);
    } catch {
      // Process may have already exited
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Factory function
 */
export function createDevServerManager(): DevServerManager {
  return new DevServerManager();
}

/**
 * run_local 工具
 *
 * 在本地运行项目并验证其可访问性
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';

// =============================================================================
// 类型定义
// =============================================================================

/** 项目类型 */
export type ProjectType = 'python' | 'node' | 'bun' | 'unknown';

/** 运行本地项目输入 */
export interface RunLocalInput {
  /** 项目目录 (相对于 workDir) */
  projectDir: string;
  /** 启动命令 (默认自动检测) */
  command?: string;
  /** 端口号 (默认自动检测) */
  port?: number;
  /** 是否安装依赖 (默认 true) */
  installDeps?: boolean;
  /** 启动后等待时间 (毫秒，默认 5000) */
  waitTime?: number;
  /** 超时时间 (毫秒，默认 60000) */
  timeout?: number;
}

/** 运行本地项目输出 */
export interface RunLocalOutput {
  /** 项目类型 */
  projectType: ProjectType;
  /** 访问 URL */
  url: string;
  /** 端口号 */
  port: number;
  /** 进程 ID (可能为 undefined) */
  pid: number | undefined;
  /** 启动日志 */
  logs: string;
  /** 是否成功启动 */
  running: boolean;
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 检测项目类型
 */
async function detectProjectType(projectDir: string): Promise<{
  type: ProjectType;
  command: string;
  port: number;
}> {
  // 检查 package.json (Node/Bun)
  const packageJsonPath = join(projectDir, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const content = await readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = pkg.scripts || {};

      // 检测框架和端口
      if (scripts.dev) {
        // Next.js 默认 3000
        if (pkg.dependencies?.next) {
          return { type: 'node', command: 'npm run dev', port: 3000 };
        }
        // Vite 默认 5173
        if (pkg.devDependencies?.vite) {
          return { type: 'node', command: 'npm run dev', port: 5173 };
        }
        return { type: 'node', command: 'npm run dev', port: 3000 };
      }
      if (scripts.start) {
        return { type: 'node', command: 'npm start', port: 3000 };
      }
    } catch {
      // 解析失败
    }
  }

  // 检查 requirements.txt (Python)
  const requirementsPath = join(projectDir, 'requirements.txt');
  if (existsSync(requirementsPath)) {
    const requirements = await readFile(requirementsPath, 'utf-8');

    // Streamlit
    if (requirements.includes('streamlit')) {
      return { type: 'python', command: 'streamlit run app.py', port: 8501 };
    }
    // Gradio
    if (requirements.includes('gradio')) {
      return { type: 'python', command: 'python app.py', port: 7860 };
    }
    // FastAPI
    if (requirements.includes('fastapi')) {
      return { type: 'python', command: 'uvicorn app.main:app --reload', port: 8000 };
    }
    // Flask
    if (requirements.includes('flask')) {
      return { type: 'python', command: 'flask run', port: 5000 };
    }
    // Django
    if (requirements.includes('django')) {
      return { type: 'python', command: 'python manage.py runserver', port: 8000 };
    }
  }

  // 检查 pyproject.toml
  if (existsSync(join(projectDir, 'pyproject.toml'))) {
    return { type: 'python', command: 'python -m app', port: 8000 };
  }

  return { type: 'unknown', command: '', port: 8080 };
}

/**
 * 安装项目依赖
 */
async function installDependencies(
  projectDir: string,
  projectType: ProjectType
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];

    switch (projectType) {
      case 'python':
        cmd = 'pip';
        args = ['install', '-r', 'requirements.txt'];
        break;
      case 'node':
        cmd = 'npm';
        args = ['install'];
        break;
      case 'bun':
        cmd = 'bun';
        args = ['install'];
        break;
      default:
        resolve({ success: false, output: 'Unknown project type' });
        return;
    }

    const proc = spawn(cmd, args, { cwd: projectDir, shell: true });
    let output = '';

    proc.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0, output });
    });
    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

/**
 * 启动项目 (返回启动信息，进程在后台运行)
 */
async function startProject(
  projectDir: string,
  command: string,
  waitTime: number,
  timeout: number
): Promise<{ pid: number | undefined; logs: string; running: boolean }> {
  return new Promise((resolve) => {
    const parts = command.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    if (!cmd) {
      resolve({ pid: undefined, logs: 'No command specified', running: false });
      return;
    }

    const proc = spawn(cmd, args, {
      cwd: projectDir,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let logs = '';
    let resolved = false;

    proc.stdout.on('data', (data: Buffer) => {
      logs += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      logs += data.toString();
    });

    // 等待启动
    const startTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // 不杀进程，让它在后台运行
        proc.unref();
        resolve({ pid: proc.pid, logs, running: true });
      }
    }, waitTime);

    // 超时
    const timeoutTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill();
        } catch {
          // ignore
        }
        resolve({ pid: proc.pid, logs, running: false });
      }
    }, timeout);

    proc.on('error', (err: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(startTimer);
        clearTimeout(timeoutTimer);
        resolve({ pid: proc.pid, logs: logs + '\n' + err.message, running: false });
      }
    });

    proc.on('exit', (code: number | null) => {
      if (!resolved && code !== 0) {
        resolved = true;
        clearTimeout(startTimer);
        clearTimeout(timeoutTimer);
        resolve({ pid: proc.pid, logs, running: false });
      }
    });
  });
}

// =============================================================================
// 工具定义
// =============================================================================

export const runLocalTool: Tool = {
  name: 'run_local',
  title: 'Run Local Project',
  description: `在本地运行项目并验证其可访问性。

功能：
- 自动检测项目类型 (Python/Node.js)
- 自动安装依赖
- 启动开发服务器
- 返回访问 URL

支持的项目类型：
- Streamlit (端口 8501)
- Gradio (端口 7860)
- FastAPI (端口 8000)
- Flask (端口 5000)
- Next.js (端口 3000)
- Vite (端口 5173)`,

  inputSchema: {
    type: 'object',
    properties: {
      projectDir: {
        type: 'string',
        description: '项目目录',
      },
      command: {
        type: 'string',
        description: '启动命令（默认自动检测）',
      },
      port: {
        type: 'number',
        description: '端口号（默认自动检测）',
      },
      installDeps: {
        type: 'boolean',
        description: '是否安装依赖',
        default: true,
      },
      waitTime: {
        type: 'number',
        description: '启动后等待时间（毫秒）',
        default: 5000,
      },
      timeout: {
        type: 'number',
        description: '超时时间（毫秒）',
        default: 60000,
      },
    },
    required: ['projectDir'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          projectType: { type: 'string' },
          url: { type: 'string' },
          port: { type: 'number' },
          pid: { type: 'number' },
          logs: { type: 'string' },
          running: { type: 'boolean' },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.7,
    idempotent: false,
    estimatedDuration: 30000,
  },

  permissions: ['process:spawn', 'network:local'],
  layer: ToolLayer.Sandbox,
  category: ToolCategory.Shell,

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<RunLocalOutput>> {
    const {
      projectDir,
      command: inputCommand,
      port: inputPort,
      installDeps = true,
      waitTime = 5000,
      timeout = 60000,
    } = input as RunLocalInput;

    try {
      // 验证工作目录
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Invalid workDir',
        };
      }

      // 验证项目目录
      const fullProjectDir = validatePath(projectDir, context.workDir);
      if (!existsSync(fullProjectDir)) {
        return {
          success: false,
          error: `Project directory not found: ${projectDir}`,
        };
      }

      // 检测项目类型
      const detected = await detectProjectType(fullProjectDir);
      const command = inputCommand || detected.command;
      const port = inputPort || detected.port;

      if (!command) {
        return {
          success: false,
          error: 'Could not detect project type. Please specify command.',
        };
      }

      let logs = '';

      // 安装依赖
      if (installDeps) {
        const installResult = await installDependencies(fullProjectDir, detected.type);
        logs += `[Install] ${installResult.success ? 'Success' : 'Failed'}\n`;
        logs += installResult.output + '\n';

        if (!installResult.success) {
          return {
            success: false,
            error: `Failed to install dependencies: ${installResult.output}`,
          };
        }
      }

      // 启动项目
      const startResult = await startProject(fullProjectDir, command, waitTime, timeout);
      logs += startResult.logs;

      // 返回结果
      return {
        success: startResult.running,
        data: {
          projectType: detected.type,
          url: `http://localhost:${port}`,
          port,
          pid: startResult.pid,
          logs: logs.slice(-2000), // 限制日志长度
          running: startResult.running,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Failed to run project',
      };
    }
  },
};

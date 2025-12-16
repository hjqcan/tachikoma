/**
 * dockerize 工具
 *
 * 为项目生成 Docker 配置并构建镜像
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';

// =============================================================================
// 类型定义
// =============================================================================

/** Docker 化输入 */
export interface DockerizeInput {
  /** 项目目录 */
  projectDir: string;
  /** 镜像名称 (默认使用目录名) */
  imageName?: string;
  /** 镜像标签 (默认 latest) */
  tag?: string;
  /** 是否构建镜像 (默认 true) */
  build?: boolean;
  /** 是否运行容器测试 (默认 false) */
  runTest?: boolean;
  /** 暴露端口 (默认自动检测) */
  port?: number;
  /** 仅生成配置不构建 */
  configOnly?: boolean;
}

/** Docker 化输出 */
export interface DockerizeOutput {
  /** Dockerfile 路径 */
  dockerfilePath: string;
  /** docker-compose.yml 路径 (如果生成) */
  composePath?: string;
  /** 镜像名称 */
  imageName: string;
  /** 构建是否成功 */
  buildSuccess: boolean;
  /** 构建日志 */
  buildLogs: string;
  /** 暴露端口 */
  port: number;
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 检测项目类型和框架
 */
async function detectProjectConfig(projectDir: string): Promise<{
  type: 'python' | 'node' | 'unknown';
  framework: string;
  port: number;
  pythonVersion: string;
  nodeVersion: string;
}> {
  // 检查 package.json
  const packageJsonPath = join(projectDir, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const content = await readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      if (pkg.dependencies?.next) {
        return { type: 'node', framework: 'nextjs', port: 3000, pythonVersion: '', nodeVersion: '20' };
      }
      if (pkg.devDependencies?.vite) {
        return { type: 'node', framework: 'vite', port: 5173, pythonVersion: '', nodeVersion: '20' };
      }
      return { type: 'node', framework: 'node', port: 3000, pythonVersion: '', nodeVersion: '20' };
    } catch {
      // ignore
    }
  }

  // 检查 requirements.txt
  const requirementsPath = join(projectDir, 'requirements.txt');
  if (existsSync(requirementsPath)) {
    const content = await readFile(requirementsPath, 'utf-8');

    if (content.includes('streamlit')) {
      return { type: 'python', framework: 'streamlit', port: 8501, pythonVersion: '3.11', nodeVersion: '' };
    }
    if (content.includes('gradio')) {
      return { type: 'python', framework: 'gradio', port: 7860, pythonVersion: '3.11', nodeVersion: '' };
    }
    if (content.includes('fastapi')) {
      return { type: 'python', framework: 'fastapi', port: 8000, pythonVersion: '3.11', nodeVersion: '' };
    }
    if (content.includes('flask')) {
      return { type: 'python', framework: 'flask', port: 5000, pythonVersion: '3.11', nodeVersion: '' };
    }
    if (content.includes('django')) {
      return { type: 'python', framework: 'django', port: 8000, pythonVersion: '3.11', nodeVersion: '' };
    }
    return { type: 'python', framework: 'python', port: 8000, pythonVersion: '3.11', nodeVersion: '' };
  }

  return { type: 'unknown', framework: 'unknown', port: 8080, pythonVersion: '3.11', nodeVersion: '20' };
}

/**
 * 生成 Python Dockerfile
 */
function generatePythonDockerfile(
  framework: string,
  pythonVersion: string,
  port: number
): string {
  let cmd = '';

  switch (framework) {
    case 'streamlit':
      cmd = `CMD ["streamlit", "run", "app.py", "--server.address=0.0.0.0", "--server.port=${port}"]`;
      break;
    case 'gradio':
      cmd = `CMD ["python", "app.py"]`;
      break;
    case 'fastapi':
      cmd = `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "${port}"]`;
      break;
    case 'flask':
      cmd = `CMD ["flask", "run", "--host=0.0.0.0", "--port=${port}"]`;
      break;
    case 'django':
      cmd = `CMD ["python", "manage.py", "runserver", "0.0.0.0:${port}"]`;
      break;
    default:
      cmd = `CMD ["python", "app.py"]`;
  }

  return `# Auto-generated Dockerfile
FROM python:${pythonVersion}-slim

WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制代码
COPY . .

EXPOSE ${port}

${cmd}
`;
}

/**
 * 生成 Node.js Dockerfile
 */
function generateNodeDockerfile(
  framework: string,
  nodeVersion: string,
  port: number
): string {
  if (framework === 'nextjs') {
    return `# Auto-generated Dockerfile for Next.js
FROM node:${nodeVersion}-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:${nodeVersion}-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE ${port}

CMD ["node", "server.js"]
`;
  }

  // Generic Node.js
  return `# Auto-generated Dockerfile
FROM node:${nodeVersion}-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE ${port}

CMD ["npm", "start"]
`;
}

/**
 * 生成 docker-compose.yml
 */
function generateDockerCompose(
  imageName: string,
  port: number
): string {
  return `version: '3.8'

services:
  app:
    build: .
    image: ${imageName}
    ports:
      - "${port}:${port}"
    env_file:
      - .env
    restart: unless-stopped
`;
}

/**
 * 执行 Docker 构建
 */
async function buildDockerImage(
  projectDir: string,
  imageName: string,
  tag: string,
  timeout = 300000
): Promise<{ success: boolean; logs: string }> {
  return new Promise((resolve) => {
    const fullImageName = `${imageName}:${tag}`;
    const proc = spawn('docker', ['build', '-t', fullImageName, '.'], {
      cwd: projectDir,
    });

    let logs = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ success: false, logs: logs + '\n[Build timed out]' });
    }, timeout);

    proc.stdout.on('data', (data: Buffer) => {
      logs += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      logs += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ success: code === 0, logs });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, logs: logs + '\n' + err.message });
    });
  });
}

/**
 * 检查 Docker 是否可用
 */
async function checkDocker(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['--version']);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// =============================================================================
// 工具定义
// =============================================================================

export const dockerizeTool: Tool = {
  name: 'dockerize',
  title: 'Dockerize Project',
  description: `为项目生成 Docker 配置并可选构建镜像。

功能：
- 自动检测项目类型 (Python/Node.js)
- 生成优化的 Dockerfile
- 生成 docker-compose.yml
- 可选构建 Docker 镜像

支持的框架：
- Python: Streamlit, Gradio, FastAPI, Flask, Django
- Node.js: Next.js, Vite, Express`,

  inputSchema: {
    type: 'object',
    properties: {
      projectDir: {
        type: 'string',
        description: '项目目录',
      },
      imageName: {
        type: 'string',
        description: '镜像名称（默认使用目录名）',
      },
      tag: {
        type: 'string',
        description: '镜像标签（默认 latest）',
        default: 'latest',
      },
      build: {
        type: 'boolean',
        description: '是否构建镜像',
        default: true,
      },
      port: {
        type: 'number',
        description: '暴露端口（默认自动检测）',
      },
      configOnly: {
        type: 'boolean',
        description: '仅生成配置文件不构建',
        default: false,
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
          dockerfilePath: { type: 'string' },
          composePath: { type: 'string' },
          imageName: { type: 'string' },
          buildSuccess: { type: 'boolean' },
          buildLogs: { type: 'string' },
          port: { type: 'number' },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.6,
    idempotent: false,
    estimatedDuration: 120000,
  },

  permissions: ['fs:write', 'process:spawn'],
  layer: ToolLayer.Sandbox,
  category: ToolCategory.Shell,

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<DockerizeOutput>> {
    const {
      projectDir,
      imageName: inputImageName,
      tag = 'latest',
      build = true,
      port: inputPort,
      configOnly = false,
    } = input as DockerizeInput;

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

      // 检测项目配置
      const config = await detectProjectConfig(fullProjectDir);
      const port = inputPort || config.port;
      const imageName = inputImageName || basename(fullProjectDir).toLowerCase().replace(/[^a-z0-9-]/g, '-');

      // 生成 Dockerfile
      let dockerfile: string;
      if (config.type === 'python') {
        dockerfile = generatePythonDockerfile(config.framework, config.pythonVersion, port);
      } else if (config.type === 'node') {
        dockerfile = generateNodeDockerfile(config.framework, config.nodeVersion, port);
      } else {
        return {
          success: false,
          error: 'Could not detect project type. Please ensure requirements.txt or package.json exists.',
        };
      }

      // 写入 Dockerfile
      const dockerfilePath = join(fullProjectDir, 'Dockerfile');
      await writeFile(dockerfilePath, dockerfile, 'utf-8');

      // 生成 docker-compose.yml
      const composePath = join(fullProjectDir, 'docker-compose.yml');
      const compose = generateDockerCompose(imageName, port);
      await writeFile(composePath, compose, 'utf-8');

      // 如果仅生成配置
      if (configOnly) {
        return {
          success: true,
          data: {
            dockerfilePath,
            composePath,
            imageName,
            buildSuccess: false,
            buildLogs: 'Config only mode - build skipped',
            port,
          },
        };
      }

      // 检查 Docker
      if (build) {
        const hasDocker = await checkDocker();
        if (!hasDocker) {
          return {
            success: true,
            data: {
              dockerfilePath,
              composePath,
              imageName,
              buildSuccess: false,
              buildLogs: 'Docker not installed - config files generated only',
              port,
            },
          };
        }

        // 构建镜像
        const buildResult = await buildDockerImage(fullProjectDir, imageName, tag);

        return {
          success: buildResult.success,
          data: {
            dockerfilePath,
            composePath,
            imageName,
            buildSuccess: buildResult.success,
            buildLogs: buildResult.logs.slice(-2000),
            port,
          },
        };
      }

      return {
        success: true,
        data: {
          dockerfilePath,
          composePath,
          imageName,
          buildSuccess: false,
          buildLogs: 'Build skipped',
          port,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Failed to dockerize project',
      };
    }
  },
};

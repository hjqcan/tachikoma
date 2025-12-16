/**
 * scaffold_project 工具
 *
 * 根据模板生成项目脚手架
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';

// =============================================================================
// 类型定义
// =============================================================================

/** 项目模板类型 */
export type ProjectTemplate =
  | 'streamlit'      // Python + Streamlit Web UI
  | 'gradio'         // Python + Gradio ML Demo
  | 'fastapi'        // Python + FastAPI REST API
  | 'flask'          // Python + Flask Web App
  | 'nextjs'         // TypeScript + Next.js
  | 'python-cli'     // Python CLI 工具
  | 'python-lib';    // Python 库

/** 脚手架输入 */
export interface ScaffoldProjectInput {
  /** 项目名称 */
  projectName: string;
  /** 项目模板 */
  template: ProjectTemplate;
  /** 项目描述 */
  description?: string;
  /** 输出目录 (相对于 workDir) */
  outputDir?: string;
  /** 额外功能 */
  features?: string[];
  /** Python 版本 (默认 3.11) */
  pythonVersion?: string;
  /** 是否生成 Docker 配置 */
  includeDocker?: boolean;
  /** 是否生成 GitHub Actions */
  includeCI?: boolean;
}

/** 脚手架输出 */
export interface ScaffoldProjectOutput {
  /** 项目根目录 */
  projectDir: string;
  /** 生成的文件列表 */
  files: string[];
  /** 下一步指引 */
  nextSteps: string[];
}

// =============================================================================
// 模板内容
// =============================================================================

/**
 * 生成 Streamlit 项目模板
 */
function generateStreamlitTemplate(
  projectName: string,
  description: string,
  pythonVersion: string,
  includeDocker: boolean
): Record<string, string> {
  const files: Record<string, string> = {};

  // README.md
  files['README.md'] = `# ${projectName}

${description}

## 快速开始

\`\`\`bash
# 创建虚拟环境
python -m venv venv
source venv/bin/activate  # Windows: venv\\Scripts\\activate

# 安装依赖
pip install -r requirements.txt

# 运行应用
streamlit run app.py
\`\`\`

## 功能

- [ ] 功能 1
- [ ] 功能 2

## 技术栈

- Python ${pythonVersion}
- Streamlit
`;

  // requirements.txt
  files['requirements.txt'] = `streamlit>=1.28.0
python-dotenv>=1.0.0
`;

  // app.py
  files['app.py'] = `"""
${projectName} - Streamlit Application
"""
import streamlit as st
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 页面配置
st.set_page_config(
    page_title="${projectName}",
    page_icon="🚀",
    layout="wide",
)

# 标题
st.title("${projectName}")
st.markdown("${description}")

# 侧边栏
with st.sidebar:
    st.header("设置")
    # 在这里添加配置选项

# 主内容区
st.header("上传文件")
uploaded_file = st.file_uploader("选择文件", type=["txt", "pdf", "png", "jpg"])

if uploaded_file is not None:
    st.success(f"已上传: {uploaded_file.name}")
    # 在这里处理上传的文件

# 操作按钮
if st.button("开始处理"):
    with st.spinner("处理中..."):
        # 在这里添加处理逻辑
        st.success("处理完成!")

# 结果展示区
st.header("结果")
st.info("处理结果将显示在这里")
`;

  // .env.example
  files['.env.example'] = `# API Keys
# OPENAI_API_KEY=sk-xxx
`;

  // .gitignore
  files['.gitignore'] = `# Python
__pycache__/
*.py[cod]
*$py.class
venv/
.env

# IDE
.vscode/
.idea/

# OS
.DS_Store
`;

  // Dockerfile (可选)
  if (includeDocker) {
    files['Dockerfile'] = `FROM python:${pythonVersion}-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8501

CMD ["streamlit", "run", "app.py", "--server.address=0.0.0.0"]
`;

    files['docker-compose.yml'] = `version: '3.8'
services:
  app:
    build: .
    ports:
      - "8501:8501"
    env_file:
      - .env
`;
  }

  return files;
}

/**
 * 生成 Gradio 项目模板
 */
function generateGradioTemplate(
  projectName: string,
  description: string,
  pythonVersion: string,
  includeDocker: boolean
): Record<string, string> {
  const files: Record<string, string> = {};

  files['README.md'] = `# ${projectName}

${description}

## 快速开始

\`\`\`bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
\`\`\`
`;

  files['requirements.txt'] = `gradio>=4.0.0
python-dotenv>=1.0.0
`;

  files['app.py'] = `"""
${projectName} - Gradio Application
"""
import gradio as gr
from dotenv import load_dotenv

load_dotenv()

def process(input_text: str) -> str:
    """处理输入并返回结果"""
    # 在这里添加处理逻辑
    return f"处理结果: {input_text}"

# 创建 Gradio 界面
demo = gr.Interface(
    fn=process,
    inputs=gr.Textbox(label="输入", placeholder="请输入..."),
    outputs=gr.Textbox(label="输出"),
    title="${projectName}",
    description="${description}",
)

if __name__ == "__main__":
    demo.launch()
`;

  files['.env.example'] = `# API Keys
`;

  files['.gitignore'] = `__pycache__/
venv/
.env
.DS_Store
`;

  if (includeDocker) {
    files['Dockerfile'] = `FROM python:${pythonVersion}-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 7860
CMD ["python", "app.py"]
`;
  }

  return files;
}

/**
 * 生成 FastAPI 项目模板
 */
function generateFastAPITemplate(
  projectName: string,
  description: string,
  pythonVersion: string,
  includeDocker: boolean
): Record<string, string> {
  const files: Record<string, string> = {};

  files['README.md'] = `# ${projectName}

${description}

## 快速开始

\`\`\`bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
\`\`\`

API 文档: http://localhost:8000/docs
`;

  files['requirements.txt'] = `fastapi>=0.104.0
uvicorn>=0.24.0
python-dotenv>=1.0.0
pydantic>=2.0.0
`;

  files['app/__init__.py'] = ``;

  files['app/main.py'] = `"""
${projectName} - FastAPI Application
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(
    title="${projectName}",
    description="${description}",
    version="0.1.0",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"message": "Hello from ${projectName}"}

@app.get("/health")
async def health():
    return {"status": "ok"}
`;

  files['.env.example'] = `# API Keys
`;

  files['.gitignore'] = `__pycache__/
venv/
.env
.DS_Store
`;

  if (includeDocker) {
    files['Dockerfile'] = `FROM python:${pythonVersion}-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
  }

  return files;
}

/**
 * 生成 Next.js 项目模板
 */
function generateNextJSTemplate(
  projectName: string,
  description: string,
  includeDocker: boolean
): Record<string, string> {
  const files: Record<string, string> = {};

  files['README.md'] = `# ${projectName}

${description}

## 快速开始

\`\`\`bash
bun install
bun dev
\`\`\`

打开 http://localhost:3000
`;

  files['package.json'] = JSON.stringify({
    name: projectName.toLowerCase().replace(/\s+/g, '-'),
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      lint: 'next lint',
    },
    dependencies: {
      next: '^14.0.0',
      react: '^18.0.0',
      'react-dom': '^18.0.0',
    },
    devDependencies: {
      '@types/node': '^20.0.0',
      '@types/react': '^18.0.0',
      typescript: '^5.0.0',
    },
  }, null, 2);

  files['tsconfig.json'] = JSON.stringify({
    compilerOptions: {
      target: 'es5',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'preserve',
      incremental: true,
      paths: { '@/*': ['./src/*'] },
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'],
    exclude: ['node_modules'],
  }, null, 2);

  files['src/app/page.tsx'] = `export default function Home() {
  return (
    <main className="min-h-screen p-24">
      <h1 className="text-4xl font-bold">${projectName}</h1>
      <p className="mt-4">${description}</p>
    </main>
  );
}
`;

  files['src/app/layout.tsx'] = `import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '${projectName}',
  description: '${description}',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
`;

  files['.gitignore'] = `node_modules/
.next/
.env
.DS_Store
`;

  if (includeDocker) {
    files['Dockerfile'] = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
CMD ["npm", "start"]
`;
  }

  return files;
}

/**
 * 根据模板类型生成文件
 */
function generateTemplateFiles(
  template: ProjectTemplate,
  projectName: string,
  description: string,
  pythonVersion: string,
  includeDocker: boolean
): Record<string, string> {
  switch (template) {
    case 'streamlit':
      return generateStreamlitTemplate(projectName, description, pythonVersion, includeDocker);
    case 'gradio':
      return generateGradioTemplate(projectName, description, pythonVersion, includeDocker);
    case 'fastapi':
      return generateFastAPITemplate(projectName, description, pythonVersion, includeDocker);
    case 'nextjs':
      return generateNextJSTemplate(projectName, description, includeDocker);
    default:
      // 默认使用 Streamlit
      return generateStreamlitTemplate(projectName, description, pythonVersion, includeDocker);
  }
}

/**
 * 获取下一步指引
 */
function getNextSteps(template: ProjectTemplate): string[] {
  const baseSteps = [
    '查看 README.md 了解项目详情',
    '复制 .env.example 为 .env 并配置环境变量',
  ];

  switch (template) {
    case 'streamlit':
      return [
        ...baseSteps,
        '运行 `pip install -r requirements.txt` 安装依赖',
        '运行 `streamlit run app.py` 启动应用',
        '在浏览器打开 http://localhost:8501',
      ];
    case 'gradio':
      return [
        ...baseSteps,
        '运行 `pip install -r requirements.txt` 安装依赖',
        '运行 `python app.py` 启动应用',
      ];
    case 'fastapi':
      return [
        ...baseSteps,
        '运行 `pip install -r requirements.txt` 安装依赖',
        '运行 `uvicorn app.main:app --reload` 启动服务',
        '访问 http://localhost:8000/docs 查看 API 文档',
      ];
    case 'nextjs':
      return [
        ...baseSteps,
        '运行 `bun install` 或 `npm install` 安装依赖',
        '运行 `bun dev` 或 `npm run dev` 启动开发服务器',
      ];
    default:
      return baseSteps;
  }
}

// =============================================================================
// 工具定义
// =============================================================================

export const scaffoldProjectTool: Tool = {
  name: 'scaffold_project',
  title: 'Scaffold Project',
  description: `生成项目脚手架。

根据指定模板创建完整的项目结构，包括：
- 项目配置文件 (package.json / requirements.txt)
- 入口文件 (app.py / page.tsx)
- 环境变量模板 (.env.example)
- Docker 配置 (可选)
- README 文档

支持的模板：
- streamlit: Python + Streamlit Web UI（推荐用于快速原型）
- gradio: Python + Gradio ML 演示界面
- fastapi: Python + FastAPI REST API
- nextjs: TypeScript + Next.js 现代 Web 应用`,

  inputSchema: {
    type: 'object',
    properties: {
      projectName: {
        type: 'string',
        description: '项目名称',
      },
      template: {
        type: 'string',
        enum: ['streamlit', 'gradio', 'fastapi', 'flask', 'nextjs', 'python-cli', 'python-lib'],
        description: '项目模板类型',
      },
      description: {
        type: 'string',
        description: '项目描述',
      },
      outputDir: {
        type: 'string',
        description: '输出目录（默认使用项目名称）',
      },
      pythonVersion: {
        type: 'string',
        description: 'Python 版本（默认 3.11）',
        default: '3.11',
      },
      includeDocker: {
        type: 'boolean',
        description: '是否生成 Docker 配置',
        default: true,
      },
      includeCI: {
        type: 'boolean',
        description: '是否生成 GitHub Actions 配置',
        default: false,
      },
    },
    required: ['projectName', 'template'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          projectDir: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          nextSteps: { type: 'array', items: { type: 'string' } },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.8,
    idempotent: false,
    estimatedDuration: 5000,
  },

  permissions: ['fs:write'],
  layer: ToolLayer.Atomic,
  category: ToolCategory.FileSystem,

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<ScaffoldProjectOutput>> {
    const {
      projectName,
      template,
      description = 'A new project',
      outputDir,
      pythonVersion = '3.11',
      includeDocker = true,
    } = input as ScaffoldProjectInput;

    try {
      // 验证工作目录
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Invalid workDir',
        };
      }

      // 确定项目目录
      const projectDir = validatePath(
        outputDir || projectName.toLowerCase().replace(/\s+/g, '-'),
        context.workDir
      );

      // 检查目录是否已存在
      if (existsSync(projectDir)) {
        return {
          success: false,
          error: `Directory already exists: ${projectDir}`,
        };
      }

      // 生成模板文件
      const templateFiles = generateTemplateFiles(
        template,
        projectName,
        description,
        pythonVersion,
        includeDocker
      );

      // 创建文件
      const createdFiles: string[] = [];

      for (const [filePath, content] of Object.entries(templateFiles)) {
        const fullPath = join(projectDir, filePath);
        const dir = dirname(fullPath);

        // 创建目录 (顺序执行确保父目录先创建)
        // eslint-disable-next-line no-await-in-loop
        await mkdir(dir, { recursive: true });

        // 写入文件
        // eslint-disable-next-line no-await-in-loop
        await writeFile(fullPath, content, 'utf-8');
        createdFiles.push(filePath);
      }

      // 获取下一步指引
      const nextSteps = getNextSteps(template);

      return {
        success: true,
        data: {
          projectDir,
          files: createdFiles,
          nextSteps,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Failed to scaffold project',
      };
    }
  },
};

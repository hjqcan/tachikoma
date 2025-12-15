import * as fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolRegistry } from '../tools/registry';
import { loadSkills, loadSkillContent, DEFAULT_GLOBAL_SKILLS_DIR } from './loader';
import { executeSkillScript, hasExecutableScripts } from './executor';
import { ToolCategory, ToolLayer, ToolPermission } from '../tools/types';
import type { Tool } from '../types';
import type { SkillContent } from './types';
import { createSandbox } from '../factories';

/**
 * Skill 管理器配置
 */
export interface SkillManagerConfig {
  /** Skills 根目录（默认为 ~/.tachikoma/skills） */
  skillsDir?: string;
  /** 是否自动注册到 ToolRegistry（默认为 true） */
  autoRegister?: boolean;
}

export class SkillManager {
  private readonly registry: ToolRegistry;
  private readonly config: Required<SkillManagerConfig>;
  private readonly loadedSkills = new Map<string, SkillContent>();

  constructor(registry: ToolRegistry, config: SkillManagerConfig = {}) {
    this.registry = registry;
    this.config = {
      skillsDir: config.skillsDir ?? DEFAULT_GLOBAL_SKILLS_DIR,
      autoRegister: config.autoRegister ?? true,
    };
  }

  /**
   * 初始化：加载现有 Skills 并注册
   */
  async initialize(): Promise<void> {
    await this.reload();
  }

  /**
   * 创建新 Skill
   *
   * @param name - Skill 名称 (kebab-case)
   * @param description - 描述
   * @param scriptContent - 脚本内容
   * @param scriptParams - 脚本参数（文件名、语言等）
   */
  /**
   * 创建新 Skill
   *
   * @param name - Skill 名称 (kebab-case)
   * @param description - 描述
   * @param scriptContent - 脚本内容
   * @param options - 选项
   */
  async createSkill(
    name: string,
    description: string,
    scriptContent: string,
    options: {
      filename?: string;
      dependencies?: string[];
      instructions?: string;
    } = {}
  ): Promise<void> {
    // 0. 校验安全性
    const filename = options.filename ?? 'main.py';
    this.validateFilename(filename);

    // 防止覆盖非动态 Skill 的原生工具
    // 逻辑：如果注册表中已存在同名工具，检查是否为动态 Skill (即是否存在对应的目录)
    const skillDir = join(this.config.skillsDir, name);
    
    // 简单检查：如果目录存在，则认为是动态 Skill，允许重写
    // 如果目录不存在，但工具已注册，则认为是 Native Tool，禁止重写
    // NOTE: 这种判断可能存在一种边缘情况：如果用户手动删除了目录但未 reload，可能导致判断失误。
    // 但在这个上下文中，它是此处唯一可用的无状态判断依据。
    
    try {
      await fs.promises.access(skillDir);
      // 目录存在，认为是动态 Skill，允许覆盖
    } catch {
      // 目录不存在
      if (this.registry.getByName(name)) {
         throw new Error(`Cannot overwrite native tool: ${name}`);
      }
    }

    const scriptsDir = join(skillDir, 'scripts');

    // 1. 创建目录
    await mkdir(scriptsDir, { recursive: true });

    // 2. 创建 SKILL.md (修复 tab/indent 问题，使用标准 yaml 格式，必须顶格)
    const skillMdContent = `---
name: ${name}
description: ${description}
---

${options.instructions ?? description}
`;
    await writeFile(join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8');

    // 3. 创建脚本文件
    await writeFile(join(scriptsDir, filename), scriptContent, 'utf-8');

    // 4. (可选) 创建 requirements.txt 或 package.json
    if (options.dependencies && options.dependencies.length > 0) {
      if (filename.endsWith('.py')) {
        await writeFile(join(scriptsDir, 'requirements.txt'), options.dependencies.join('\n'), 'utf-8');
      } else if (filename.endsWith('.ts') || filename.endsWith('.js')) {
        const pkgJson = {
          name: name,
          dependencies: Object.fromEntries(options.dependencies.map(d => [d, 'latest']))
        };
        await writeFile(join(scriptsDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8');
      }
    }

    // 5. 重新加载
    await this.reload();

    // 6. 验证注册结果
    if (!this.registry.getByName(name)) {
      throw new Error(`Skill created but failed to register: ${name}`);
    }
  }

  /**
   * 重新加载所有 Skills 并更新注册表
   */
  async reload(): Promise<void> {
    // 1. 发现 Skills
    const outcome = loadSkills({
      globalDir: this.config.skillsDir,
      enabled: true,
      ignoreDirs: ['.git', 'node_modules', '__pycache__'], // 恢复默认忽略
    });

    // 2. 加载完整内容并转换为 Tools
    const loadPromises = outcome.skills.map(async (metadata) => {
      try {
        return await loadSkillContent(metadata);
      } catch (error) {
        console.error(`Failed to load skill '${metadata.name}':`, error);
        return null;
      }
    });

    const results = await Promise.all(loadPromises);
    const validSkills = new Set<string>();

    for (const content of results) {
      if (!content) continue;

      // 只有包含可执行脚本的 Skill 才能转换为 Tool
      if (hasExecutableScripts(content)) {
        this.loadedSkills.set(content.name, content);
        validSkills.add(content.name);
        
        if (this.config.autoRegister) {
          const tool = this.convertToTool(content);
          // 如果已存在先注销，支持覆盖更新
          if (this.registry.getByName(tool.name)) {
            this.registry.unregister(tool.name);
          }
          this.registry.register(tool);
        }
      }
    }

    // 3. 清理已删除的 Skill
    for (const [name] of this.loadedSkills) {
      if (!validSkills.has(name)) {
        this.loadedSkills.delete(name);
        if (this.config.autoRegister && this.registry.getByName(name)) {
          this.registry.unregister(name);
        }
      }
    }
  }

  /**
   * 校验文件名安全性
   */
  private validateFilename(filename: string): void {
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Invalid filename: ${filename}. Path traversal is not allowed.`);
    }
    // 允许的扩展名
    const allowedExts = ['.py', '.js', '.ts', '.sh'];
    const ext = filename.substring(filename.lastIndexOf('.'));
    if (!allowedExts.includes(ext)) {
       throw new Error(`Invalid file extension: ${ext}. Allowed: ${allowedExts.join(', ')}`);
    }
  }

  /**
   * 将 Skill 转换为 Tool 对象
   */
  private convertToTool(skill: SkillContent): Tool {
    return {
      name: skill.name,
      title: skill.name,
      description: skill.description,
      category: ToolCategory.Agent, // 视为 Agent 能力
      layer: ToolLayer.CodeExecution, // 视为代码执行层
      permissions: [ToolPermission.ProcessSpawn], // 需要进程生成权限
      inputSchema: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Arguments to pass to the script'
          }
        }
      },
      execute: async (input: unknown) => {
        const args = (input as { args?: string[] }).args ?? [];
        
        // 为每次执行创建临时沙盒（或者复用，视策略而定）
        const sandbox = createSandbox();
    // 初始化 Sandbox
    await (sandbox as any).initialize();
        
        try {
          // 查找主脚本
          // 优先找 main.py, index.ts, main.ts 等
          // 这里简化逻辑：取第一个发现的脚本
          // 实际应该读取 SKILL.md 中的配置或 metadata
          const script = this.findMainScript(skill);
          if (!script) {
             throw new Error(`No executable script found for skill ${skill.name}`);
          }

          const result = await executeSkillScript({
            skill,
            script,
            args,
          }, sandbox);

          if (!result.success) {
             return {
               success: false,
               error: result.stderr || 'Unknown execution error',
               meta: { exitCode: result.exitCode }
             };
          }

          return {
            success: true,
            data: result.stdout,
            meta: { duration: result.duration }
          };
        } finally {
          await sandbox.destroy();
        }
      }
    };
  }

  private findMainScript(skill: SkillContent): string | undefined {
    // 简单启发式
    if (!skill.scriptsDir) return undefined;
    try {
      const files = fs.readdirSync(skill.scriptsDir);
      const candidates = ['main.py', 'index.ts', 'index.js', 'script.py', 'main.sh'];
      for (const c of candidates) {
        if (files.includes(c)) return join('scripts', c);
      }
      // 没找到标准命名的，返回第一个脚本文件
      const first = files.find(f => /\.(py|ts|js|sh)$/.test(f));
      if (first) return join('scripts', first);
    } catch {
      return undefined;
    }
    return undefined;
  }
}

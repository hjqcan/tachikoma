/**
 * Skills Manager Engine
 *
 * 管理 Worker 的 Skills 加载与提示词构建
 */

import {
  type SkillMetadata,
  type SkillDiscoveryConfig,
  type SkillLoadOutcome,
  loadSkills,
  renderSkillsSection,
  renderSkillsSectionWithRecommendations,
} from '../../skills';
import type { ContextMessage } from '../../prompt/types';
import { 
  createProjectContextLoader,
  type ProjectContextInjector, 
  createProjectContextInjector, 
  type ProjectContextLoaderConfig
} from '../../prompt';
import type { SkillError } from '../../skills';

/**
 * 项目上下文配置（扩展 ProjectContextLoaderConfig 以包含 enabled）
 */
export interface ProjectContextConfig extends ProjectContextLoaderConfig {
  enabled?: boolean;
}

// ============================================================================
// Skills Manager
// ============================================================================

/**
 * Skills Manager
 * 
 * 负责：
 * 1. 加载和管理 Skills
 * 2. 注入 Project Context
 * 3. 构建 System Prompt 增强部分
 */
export class SkillsManager {
  private skills: SkillMetadata[] = [];
  private loadErrors: SkillError[] = [];
  private projectContextInjector?: ProjectContextInjector;

  /**
   * @param config - Skills 配置
   * @param workDir - 工作目录
   * @param projectContextConfig - 项目上下文配置 (可选)
   */
  constructor(
    private readonly config: SkillDiscoveryConfig | undefined,
    private readonly workDir: string,
    private readonly projectContextConfig?: ProjectContextConfig
  ) {
    this.reload();
  }

  /**
   * (重新)加载 Skills 和 Context
   */
  reload(): void {
    // 1. Load Skills
    if (this.config?.enabled !== false) {
      const outcome: SkillLoadOutcome = loadSkills(
        this.config ?? {},
        this.workDir
      );
      this.skills = outcome.skills;
      this.loadErrors = outcome.errors;
      
      if (this.skills.length > 0) {
        const maxPreview = 12;
        const names = this.skills.slice(0, maxPreview).map((skill) => skill.name);
        const remaining = this.skills.length - names.length;
        const suffix = remaining > 0 ? `, +${remaining} more` : '';
        console.debug(`[SkillsManager] Loaded ${this.skills.length} skills: ${names.join(', ')}${suffix}`);
      }
      if (this.loadErrors.length > 0) {
        console.warn('[SkillsManager] Skill loading errors:', this.loadErrors);
      }
    } else {
      this.skills = [];
      this.loadErrors = [];
    }

    // 2. Initialize Project Context Injector
    if (this.projectContextConfig?.enabled) {
      const loader = createProjectContextLoader(this.projectContextConfig);
      this.projectContextInjector = createProjectContextInjector(loader);
      console.debug('[SkillsManager] ProjectContextInjector initialized');
    } else {
      this.projectContextInjector = undefined;
    }
  }

  /**
   * 获取已加载的 Skills
   */
  getSkills(): SkillMetadata[] {
    return this.skills;
  }

  /**
   * 获取加载错误
   */
  getLoadErrors(): SkillError[] {
    return this.loadErrors;
  }

  /**
   * 渲染 System Prompt 附加部分 (Skills + Project Context)
   * @param basePrompt - 基础提示词
   * @param taskDescription - 可选任务描述，用于推荐相关技能
   */
  async renderSystemPromptSection(
    basePrompt: string,
    taskDescription?: string
  ): Promise<string> {
    let finalPrompt = basePrompt;

    // 1. Render Skills (with recommendations if task description provided)
    let skillsSection: string | null;
    if (taskDescription) {
      skillsSection = renderSkillsSectionWithRecommendations(
        this.skills,
        taskDescription,
        this.config?.maxSkillTokens
      );
    } else {
      skillsSection = renderSkillsSection(
        this.skills,
        this.config?.maxSkillTokens
      );
    }
    
    if (skillsSection) {
      finalPrompt += '\n\n' + skillsSection;
    }

    // 2. Render Project Context - handled separately via injectProjectContext
    // because it injects messages, not just text into system prompt
    
    return finalPrompt;
  }

  /**
   * 注入项目上下文到消息列表
   */
  async injectProjectContext(
    messages: ContextMessage[],
    workDir: string
  ): Promise<ContextMessage[]> {
    if (!this.projectContextInjector) {
      return messages;
    }
    
    this.projectContextInjector.clearCache();
    return this.projectContextInjector.injectProjectContext(messages, workDir);
  }
}

/**
 * 创建 Skills Manager
 */
export function createSkillsManager(
  config: SkillDiscoveryConfig | undefined,
  workDir: string,
  projectContextConfig?: ProjectContextConfig
): SkillsManager {
  return new SkillsManager(config, workDir, projectContextConfig);
}

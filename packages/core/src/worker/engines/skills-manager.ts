/**
 * Skills Manager Engine
 *
 * 管理 Worker 的 Skills 加载与提示词构建
 */

import {
  type SkillMetadata,
  type SkillDiscoveryConfig,
  type SkillLoadOutcome,
  type SkillRenderOptions,
  type ActivatedSkill,
  loadSkills,
  renderSkillsSection,
  renderSkillsSectionWithRecommendations,
  renderSkillsSectionWithActivation,
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
  
  /** 最近一次渲染时激活的 Skills */
  private lastActivatedSkills: ActivatedSkill[] = [];

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
   * 获取最近激活的 Skills
   */
  getLastActivatedSkills(): ActivatedSkill[] {
    return this.lastActivatedSkills;
  }

  /**
   * 渲染 System Prompt 附加部分 (Skills + Project Context)
   * 
   * 支持两种模式：
   * - 旧模式（默认）：只渲染 skills 列表，不激活正文
   * - 新模式（autoActivate: true）：自动激活匹配 skills 并注入正文
   * 
   * @param basePrompt - 基础提示词
   * @param taskDescription - 可选任务描述，用于推荐相关技能
   * @param options - 渲染选项（包含激活配置和父任务上下文）
   */
  async renderSystemPromptSection(
    basePrompt: string,
    taskDescription?: string,
    options?: SkillRenderOptions & { parentObjective?: string }
  ): Promise<string> {
    let finalPrompt = basePrompt;

    // 合并上下文用于技能匹配（父任务目标 + 子任务描述）
    // 这确保了子任务能继承父任务的领域关键词
    const matchContext = [
      options?.parentObjective,
      taskDescription
    ].filter((s): s is string => typeof s === 'string' && s.length > 0).join(' | ');

    // 新模式：使用带激活的渲染
    if (options?.autoActivate && matchContext) {
      const renderOptions: SkillRenderOptions = { ...options };
      // Only set maxSkillTokens if it's defined (for exactOptionalPropertyTypes)
      if (options.maxSkillTokens !== undefined) {
        renderOptions.maxSkillTokens = options.maxSkillTokens;
      } else if (this.config?.maxSkillTokens !== undefined) {
        renderOptions.maxSkillTokens = this.config.maxSkillTokens;
      }
      
      // 使用合并后的上下文进行技能匹配
      const { section, activated } = renderSkillsSectionWithActivation(
        this.skills,
        matchContext,
        renderOptions
      );
      
      this.lastActivatedSkills = activated;
      
      if (activated.length > 0) {
        console.debug(
          `[SkillsManager] Activated ${activated.length} skills: ` +
          activated.map(a => `${a.metadata.name} (${a.reason})`).join(', ')
        );
      }
      
      if (section) {
        finalPrompt += '\n\n' + section;
      }
      
      return finalPrompt;
    }

    // 旧模式：只渲染列表（向后兼容）
    this.lastActivatedSkills = [];
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
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
  getGlobalSkillBlockManager,
} from '../../skills';
import type { ContextMessage } from '../../prompt/types';
import { 
  createProjectContextLoader,
  type ProjectContextInjector, 
  createProjectContextInjector, 
  type ProjectContextConfig,
  DEFAULT_PROJECT_CONTEXT_CONFIG
} from '../../prompt';
import type { SkillError } from '../../skills';

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
  private projectContextInjector: ProjectContextInjector | undefined;
  private projectContextCacheState: { workDir: string; loadedAt: number } | null = null;
  
  /** 最近一次渲染时激活的 Skills */
  private lastActivatedSkills: ActivatedSkill[] = [];
  
  /** 使用统计 */
  private reloadCount = 0;
  private lastReloadTime = 0;

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
    this.reloadCount++;
    this.lastReloadTime = Date.now();

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

    // 2. Sync to Memory Block (for /skill list and context injection)
    try {
      const blockManager = getGlobalSkillBlockManager();
      blockManager.refreshSkillsBlock(this.skills);
    } catch (error) {
      // Best-effort: don't fail reload if block manager has issues
      console.debug('[SkillsManager] Memory Block refresh failed (continuing):', error);
    }

    // 3. Initialize Project Context Injector
    if (this.projectContextConfig?.enabled) {
      const loader = createProjectContextLoader(this.projectContextConfig);
      this.projectContextInjector = createProjectContextInjector(loader);
      this.projectContextCacheState = null;
      console.debug('[SkillsManager] ProjectContextInjector initialized');
    } else {
      this.projectContextInjector = undefined;
      this.projectContextCacheState = null;
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
   * 获取使用统计
   */
  getStats(): { reloadCount: number; skillCount: number; lastReloadTime: number } {
    return {
      reloadCount: this.reloadCount,
      skillCount: this.skills.length,
      lastReloadTime: this.lastReloadTime,
    };
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
    options?: SkillRenderOptions & { parentObjective?: string; includeProjectContext?: boolean }
  ): Promise<string> {
    let finalPrompt = basePrompt;
    if (options?.includeProjectContext) {
      const projectContextSection = await this.renderProjectContextSection();
      if (projectContextSection) {
        finalPrompt += '\n\n' + projectContextSection;
      }
    }

    // 始终注入“手动加载”的 skills（loaded_skills）
    // - 这是 Letta-Code 风格的关键闭环：用户/Agent 显式 load 后，必须立刻影响后续推理
    // - best-effort：任何异常都不应影响主流程
    const appendLoadedSkills = (prompt: string): string => {
      try {
        const blockManager = getGlobalSkillBlockManager();
        const loadedSection = blockManager.renderLoadedSkillsForPrompt();
        if (loadedSection) {
          return `${prompt}\n\n${loadedSection}`;
        }
      } catch (error) {
        console.debug('[SkillsManager] Loaded skills render failed (continuing):', error);
      }
      return prompt;
    };

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
      console.info(
        `[SkillsManager] Activated ${activated.length} skills: ` +
        activated.map(a => `${a.metadata.name} (${a.reason})`).join(', ')
      );
    }
      
      if (section) {
        finalPrompt += '\n\n' + section;
      }

      return appendLoadedSkills(finalPrompt);
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

    // Project Context can be injected as messages or appended to system prompt
    
    return appendLoadedSkills(finalPrompt);
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

    const shouldRefresh = this.shouldRefreshProjectContext(workDir);
    if (shouldRefresh) {
      this.projectContextInjector.clearCache();
    }
    const injected = await this.projectContextInjector.injectProjectContext(
      messages,
      workDir
    );
    if (shouldRefresh || !this.projectContextCacheState) {
      this.projectContextCacheState = { workDir, loadedAt: Date.now() };
    }
    return injected;
  }

  private async renderProjectContextSection(): Promise<string | null> {
    if (!this.projectContextInjector) {
      return null;
    }

    const shouldRefresh = this.shouldRefreshProjectContext(this.workDir);
    if (shouldRefresh) {
      this.projectContextInjector.clearCache();
    }
    const injected = await this.projectContextInjector.injectProjectContext([], this.workDir);
    if (shouldRefresh || !this.projectContextCacheState) {
      this.projectContextCacheState = { workDir: this.workDir, loadedAt: Date.now() };
    }
    const projectMessage = injected.find((m) => m.id === 'project-context');
    return projectMessage ? projectMessage.content : null;
  }

  private shouldRefreshProjectContext(workDir: string): boolean {
    if (!this.projectContextCacheState) {
      return true;
    }
    if (this.projectContextCacheState.workDir !== workDir) {
      return true;
    }
    const ttl = this.projectContextConfig?.cacheTtlMs;
    if (ttl === undefined) {
      return false;
    }
    if (ttl <= 0) {
      return true;
    }
    return Date.now() - this.projectContextCacheState.loadedAt >= ttl;
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

export function resolveProjectContextConfig(
  config?: ProjectContextConfig
): ProjectContextConfig | undefined {
  if (!config) {
    return { ...DEFAULT_PROJECT_CONTEXT_CONFIG, enabled: true };
  }
  if (config.enabled === false) {
    return config;
  }
  return {
    ...DEFAULT_PROJECT_CONTEXT_CONFIG,
    ...config,
    enabled: true,
  };
}

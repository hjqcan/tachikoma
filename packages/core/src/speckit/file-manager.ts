/**
 * SpecKit 文件管理器
 *
 * 管理 .tachikoma/speckit/ 目录结构及文件读写
 */

import { mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type {
  Constitution,
  Specification,
  ImplementationPlan,
  TaskBreakdown,
  SpecTask,
  SpecTaskStatus,
  DataModel,
} from './types';
import { DEFAULT_SPECKIT_ROOT, SPECKIT_DIRS, SPECKIT_FILES } from './index';

const SPECKIT_JSON_FILES = {
  constitution: 'constitution.json',
  spec: 'spec.json',
  // 避免与 Orchestrator 的 runtime.json / Task Master 的 tasks.json 混淆
  plan: 'implementation.json',
  tasks: 'tasks.json',
} as const;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 文件管理器配置
 */
export interface SpecKitFileManagerConfig {
  /** 项目工作目录 */
  workDir: string;
  /** SpecKit 根目录名（默认 .tachikoma/speckit） */
  rootDir?: string;
}

/**
 * 规范目录信息
 */
export interface SpecDirInfo {
  /** 规范 ID */
  specId: string;
  /** 规范目录绝对路径 */
  path: string;
  /** 是否有 spec.md */
  hasSpec: boolean;
  /** 是否有 plan.md */
  hasPlan: boolean;
  /** 是否有 tasks.md */
  hasTasks: boolean;
}

// ============================================================================
// SpecKitFileManager
// ============================================================================

/**
 * SpecKit 文件管理器
 *
 * 负责管理 SpecKit 目录结构和文件操作
 */
export class SpecKitFileManager {
  private readonly workDir: string;
  private readonly rootDir: string;

  constructor(config: SpecKitFileManagerConfig) {
    this.workDir = config.workDir;
    this.rootDir = config.rootDir || DEFAULT_SPECKIT_ROOT;
  }

  // ==========================================================================
  // 路径获取
  // ==========================================================================

  /** 获取 SpecKit 根路径 */
  getRootPath(): string {
    return join(this.workDir, this.rootDir);
  }

  /** 获取 memory 目录路径 */
  getMemoryPath(): string {
    return join(this.getRootPath(), SPECKIT_DIRS.memory);
  }

  /** 获取 specs 目录路径 */
  getSpecsPath(): string {
    return join(this.getRootPath(), SPECKIT_DIRS.specs);
  }

  /** 获取 templates 目录路径 */
  getTemplatesPath(): string {
    return join(this.getRootPath(), SPECKIT_DIRS.templates);
  }

  /** 获取 constitution 文件路径 */
  getConstitutionPath(): string {
    return join(this.getMemoryPath(), SPECKIT_FILES.constitution);
  }

  /** 获取 constitution.json 文件路径 */
  getConstitutionJsonPath(): string {
    return join(this.getMemoryPath(), SPECKIT_JSON_FILES.constitution);
  }

  /** 获取指定规范的目录路径 */
  getSpecDirPath(specId: string): string {
    return join(this.getSpecsPath(), specId);
  }

  /** 获取指定规范的 spec.md 路径 */
  getSpecFilePath(specId: string): string {
    return join(this.getSpecDirPath(specId), SPECKIT_FILES.spec);
  }

  /** 获取指定规范的 spec.json 路径 */
  getSpecJsonFilePath(specId: string): string {
    return join(this.getSpecDirPath(specId), SPECKIT_JSON_FILES.spec);
  }

  /** 获取指定规范的 plan.md 路径 */
  getPlanFilePath(specId: string): string {
    return join(this.getSpecDirPath(specId), SPECKIT_FILES.plan);
  }

  /** 获取指定规范的 implementation.json 路径 */
  getPlanJsonFilePath(specId: string): string {
    return join(this.getSpecDirPath(specId), SPECKIT_JSON_FILES.plan);
  }

  /** 获取指定规范的 tasks.md 路径 */
  getTasksFilePath(specId: string): string {
    return join(this.getSpecDirPath(specId), SPECKIT_FILES.tasks);
  }

  /** 获取指定规范的 tasks.json 路径 */
  getTasksJsonFilePath(specId: string): string {
    return join(this.getSpecDirPath(specId), SPECKIT_JSON_FILES.tasks);
  }

  /** 获取指定规范的 data-model.md 路径 */
  getDataModelFilePath(specId: string): string {
    return join(this.getSpecDirPath(specId), SPECKIT_FILES.dataModel);
  }

  /** 获取指定规范的 research.md 路径 */
  getResearchFilePath(specId: string): string {
    return join(this.getSpecDirPath(specId), SPECKIT_FILES.research);
  }

  // ==========================================================================
  // 目录初始化
  // ==========================================================================

  /**
   * 初始化 SpecKit 目录结构
   *
   * 创建：
   * - .tachikoma/speckit/
   * - .tachikoma/speckit/memory/
   * - .tachikoma/speckit/specs/
   * - .tachikoma/speckit/templates/
   */
  async init(): Promise<void> {
    await mkdir(this.getMemoryPath(), { recursive: true });
    await mkdir(this.getSpecsPath(), { recursive: true });
    await mkdir(this.getTemplatesPath(), { recursive: true });
  }

  /**
   * 检查 SpecKit 是否已初始化
   */
  async isInitialized(): Promise<boolean> {
    try {
      const s = await stat(this.getRootPath());
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * 初始化指定规范的目录
   */
  async initSpecDir(specId: string): Promise<void> {
    await mkdir(this.getSpecDirPath(specId), { recursive: true });
    await mkdir(join(this.getSpecDirPath(specId), 'contracts'), { recursive: true });
  }

  // ==========================================================================
  // Constitution 操作
  // ==========================================================================

  /**
   * 读取项目宪法
   */
  async readConstitution(): Promise<Constitution | null> {
    try {
      const json = await this.readJsonFile<Constitution>(this.getConstitutionJsonPath());
      if (json) return json;
      const content = await readFile(this.getConstitutionPath(), 'utf-8');
      return this.parseConstitution(content);
    } catch {
      return null;
    }
  }

  /**
   * 写入项目宪法
   */
  async writeConstitution(constitution: Constitution): Promise<void> {
    await mkdir(dirname(this.getConstitutionPath()), { recursive: true });
    await writeFile(this.getConstitutionPath(), constitution.rawContent, 'utf-8');
    await this.writeJsonFile(this.getConstitutionJsonPath(), constitution);
  }

  /**
   * 解析 Constitution Markdown 内容
   */
  private parseConstitution(content: string): Constitution {
    // 简化解析：提取 frontmatter 和正文
    const now = Date.now();
    const principles = this.extractListItems(content, 'Principles', 'Core Principles');

    return {
      version: '1.0',
      principles,
      rawContent: content,
      createdAt: now,
      updatedAt: now,
    };
  }

  // ==========================================================================
  // Specification 操作
  // ==========================================================================

  /**
   * 列出所有规范
   */
  async listSpecs(): Promise<SpecDirInfo[]> {
    try {
      const specsDir = this.getSpecsPath();
      const entries = await readdir(specsDir, { withFileTypes: true });
      const specs: SpecDirInfo[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const specId = entry.name;
          const specPath = join(specsDir, specId);

          const [hasSpec, hasPlan, hasTasks] = await Promise.all([
            this.fileExists(join(specPath, SPECKIT_FILES.spec)),
            this.fileExists(join(specPath, SPECKIT_FILES.plan)),
            this.fileExists(join(specPath, SPECKIT_FILES.tasks)),
          ]);

          specs.push({
            specId,
            path: specPath,
            hasSpec,
            hasPlan,
            hasTasks,
          });
        }
      }

      return specs.sort((a, b) => a.specId.localeCompare(b.specId));
    } catch {
      return [];
    }
  }

  /**
   * 读取规范
   */
  async readSpec(specId: string): Promise<Specification | null> {
    try {
      const json = await this.readJsonFile<Specification>(this.getSpecJsonFilePath(specId));
      if (json) return json;
      const content = await readFile(this.getSpecFilePath(specId), 'utf-8');
      return this.parseSpecification(specId, content);
    } catch {
      return null;
    }
  }

  /**
   * 写入规范
   */
  async writeSpec(spec: Specification): Promise<void> {
    await this.initSpecDir(spec.id);
    await writeFile(this.getSpecFilePath(spec.id), spec.rawContent, 'utf-8');
    await this.writeJsonFile(this.getSpecJsonFilePath(spec.id), spec);

    // 如果有 data model，也写入
    if (spec.dataModel) {
      const dataModelContent = this.renderDataModel(spec.dataModel);
      await writeFile(this.getDataModelFilePath(spec.id), dataModelContent, 'utf-8');
    }
  }

  /**
   * 解析 Specification Markdown 内容
   */
  private parseSpecification(specId: string, content: string): Specification {
    const now = Date.now();
    const name = this.extractTitle(content) || specId;
    const description = this.extractSection(content, 'Description', 'Overview') || '';
    const acceptanceCriteria = this.extractListItems(content, 'Acceptance Criteria');
    const outOfScope = this.extractListItems(content, 'Out of Scope');

    return {
      id: specId,
      name,
      description,
      userStories: [],
      acceptanceCriteria,
      outOfScope,
      rawContent: content,
      createdAt: now,
      updatedAt: now,
    };
  }

  private renderDataModel(dataModel: DataModel): string {
    let md = '# Data Model\n\n';

    for (const entity of dataModel.entities) {
      md += `## ${entity.name}\n\n`;
      if (entity.description) {
        md += `${entity.description}\n\n`;
      }
      md += '| Field | Type | Required | Description |\n';
      md += '|-------|------|----------|-------------|\n';
      for (const field of entity.fields) {
        md += `| ${field.name} | ${field.type} | ${field.required ? 'Yes' : 'No'} | ${field.description || ''} |\n`;
      }
      md += '\n';
    }

    if (dataModel.diagram) {
      md += '## Diagram\n\n';
      md += '```mermaid\n';
      md += dataModel.diagram;
      md += '\n```\n';
    }

    return md;
  }

  // ==========================================================================
  // Implementation Plan 操作
  // ==========================================================================

  /**
   * 读取实现计划
   */
  async readPlan(specId: string): Promise<ImplementationPlan | null> {
    try {
      const json = await this.readJsonFile<ImplementationPlan>(this.getPlanJsonFilePath(specId));
      if (json) return json;
      const content = await readFile(this.getPlanFilePath(specId), 'utf-8');
      return this.parsePlan(specId, content);
    } catch {
      return null;
    }
  }

  /**
   * 写入实现计划
   */
  async writePlan(plan: ImplementationPlan): Promise<void> {
    await this.initSpecDir(plan.specId);
    await writeFile(this.getPlanFilePath(plan.specId), plan.rawContent, 'utf-8');
    await this.writeJsonFile(this.getPlanJsonFilePath(plan.specId), plan);

    // 写入 research.md
    if (plan.research?.rawContent) {
      await writeFile(this.getResearchFilePath(plan.specId), plan.research.rawContent, 'utf-8');
    }
  }

  private parsePlan(specId: string, content: string): ImplementationPlan {
    const now = Date.now();
    return {
      specId,
      techStack: {},
      phases: [],
      rawContent: content,
      createdAt: now,
      updatedAt: now,
    };
  }

  // ==========================================================================
  // Task Breakdown 操作
  // ==========================================================================

  /**
   * 读取任务分解
   */
  async readTasks(specId: string): Promise<TaskBreakdown | null> {
    try {
      const json = await this.readJsonFile<TaskBreakdown>(this.getTasksJsonFilePath(specId));
      if (json) return json;
      const content = await readFile(this.getTasksFilePath(specId), 'utf-8');
      return this.parseTasks(specId, content);
    } catch {
      return null;
    }
  }

  /**
   * 写入任务分解
   */
  async writeTasks(tasks: TaskBreakdown): Promise<void> {
    await this.initSpecDir(tasks.planId);
    if (!tasks.rawContent || tasks.rawContent.trim().length === 0) {
      tasks.rawContent = this.renderTasksMarkdown(tasks.tasks, tasks.parallelGroups);
    }
    await writeFile(this.getTasksFilePath(tasks.planId), tasks.rawContent, 'utf-8');
    await this.writeJsonFile(this.getTasksJsonFilePath(tasks.planId), tasks);
  }

  /**
   * 更新单个任务状态
   */
  async updateTaskStatus(specId: string, taskId: string, status: SpecTaskStatus): Promise<void> {
    const tasks = await this.readTasks(specId);
    if (!tasks) return;

    const task = tasks.tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = status;
      tasks.updatedAt = Date.now();

      // 尝试就地更新 Markdown checkbox（优先保持原格式）
      const updated = this.updateTaskCheckboxInMarkdown(tasks.rawContent, taskId, status);
      tasks.rawContent = updated ?? this.renderTasksMarkdown(tasks.tasks, tasks.parallelGroups);

      await this.writeTasks(tasks);
    }
  }

  private parseTasks(specId: string, content: string): TaskBreakdown {
    const now = Date.now();
    const tasks = this.parseTaskList(content);

    return {
      planId: specId,
      tasks,
      dependencies: tasks.map((t) => ({ taskId: t.id, dependsOn: t.dependencies })),
      parallelGroups: this.extractParallelGroups(tasks),
      rawContent: content,
      createdAt: now,
      updatedAt: now,
    };
  }

  private parseTaskList(content: string): SpecTask[] {
    const tasks: SpecTask[] = [];
    const lines = content.split('\n');
    let currentTask: Partial<SpecTask> | null = null;
    let taskIndex = 0;

    for (const line of lines) {
      // 匹配任务行（rich）：- [ ] **task-001**: Title ...
      const richMatch = line.match(/^-\s*\[([ xX/!\-])\]\s*\*\*([^*]+)\*\*:\s*(.+)$/);
      if (richMatch) {
        if (currentTask && currentTask.id) {
          tasks.push(currentTask as SpecTask);
        }
        const statusChar = richMatch[1]?.toLowerCase() ?? ' ';
        const id = richMatch[2]?.trim() ?? `task-${++taskIndex}`;
        const title = richMatch[3]?.trim() ?? '';
        const isParallel = title.includes('[P]');
        currentTask = {
          id,
          title: title.replace('[P]', '').trim(),
          description: '',
          filePaths: [],
          dependencies: [],
          isParallel,
          testFirst: false,
          status: this.charToStatus(statusChar),
        };
        continue;
      }

      // 匹配任务行（simple）：- [ ] Task title
      const simpleMatch = line.match(/^-\s*\[([ xX/!\-])\]\s*(.+)$/);
      if (simpleMatch) {
        if (currentTask && currentTask.id) {
          tasks.push(currentTask as SpecTask);
        }
        taskIndex++;
        const statusChar = simpleMatch[1]?.toLowerCase() ?? ' ';
        const title = simpleMatch[2]?.trim() ?? '';
        const isParallel = title.includes('[P]');
        currentTask = {
          id: `task-${taskIndex}`,
          title: title.replace('[P]', '').trim(),
          description: '',
          filePaths: [],
          dependencies: [],
          isParallel,
          testFirst: false,
          status: this.charToStatus(statusChar),
        };
        continue;
      }

      // 解析任务的附加信息（缩进行）
      if (currentTask && line.startsWith('  ')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Files:')) {
          // Files: `a`, `b`
          const files = [...trimmed.matchAll(/`([^`]+)`/g)]
            .map((m) => m[1])
            .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
          currentTask.filePaths = files;
        } else if (trimmed.startsWith('Depends on:')) {
          const deps = trimmed
            .slice('Depends on:'.length)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          currentTask.dependencies = deps;
        } else if (trimmed.startsWith('Estimated:')) {
          const num = Number(trimmed.slice('Estimated:'.length).trim().replace(/h$/i, ''));
          if (Number.isFinite(num)) currentTask.estimatedHours = num;
        } else if (!trimmed.startsWith('**') && !trimmed.startsWith('-')) {
          // 作为 description 的补充（非常宽松）
          currentTask.description = trimmed;
        }
      }
    }

    if (currentTask && currentTask.id) {
      tasks.push(currentTask as SpecTask);
    }

    return tasks;
  }

  private charToStatus(char: string): SpecTaskStatus {
    switch (char.toLowerCase()) {
      case 'x':
        return 'done';
      case '/':
        return 'in-progress';
      case '!':
        return 'failed';
      case '-':
        return 'skipped';
      default:
        return 'pending';
    }
  }

  private extractParallelGroups(tasks: SpecTask[]): string[][] {
    const parallelTasks = tasks.filter((t) => t.isParallel);
    if (parallelTasks.length === 0) return [];
    return [parallelTasks.map((t) => t.id)];
  }

  private renderTasksMarkdown(tasks: SpecTask[], parallelGroups: string[][]): string {
    let md = '# Task Breakdown\n\n';

    for (const task of tasks) {
      const statusChar = this.statusToChar(task.status);
      const markers: string[] = [];
      if (task.isParallel) markers.push('[P]');
      if (task.testFirst) markers.push('[TDD]');
      const markerStr = markers.length ? ` ${markers.join(' ')}` : '';

      md += `- [${statusChar}] **${task.id}**: ${task.title}${markerStr}\n`;
      if (task.description) {
        md += `  ${task.description}\n`;
      }
      if (task.filePaths.length > 0) {
        md += `  Files: \`${task.filePaths.join('`, `')}\`\n`;
      }
      if (task.dependencies.length > 0) {
        md += `  Depends on: ${task.dependencies.join(', ')}\n`;
      }
      if (task.estimatedHours) {
        md += `  Estimated: ${task.estimatedHours}h\n`;
      }
      md += '\n';
    }

    if (parallelGroups.length > 0) {
      md += '## Parallel Execution Groups\n\n';
      for (let i = 0; i < parallelGroups.length; i++) {
        const group = parallelGroups[i];
        if (group) md += `**Group ${i + 1}:** ${group.join(', ')}\n`;
      }
      md += '\n';
    }

    return md;
  }

  private statusToChar(status: SpecTaskStatus): string {
    switch (status) {
      case 'done':
        return 'x';
      case 'in-progress':
        return '/';
      case 'failed':
        return '!';
      case 'skipped':
        return '-';
      default:
        return ' ';
    }
  }

  private updateTaskCheckboxInMarkdown(
    markdown: string,
    taskId: string,
    status: SpecTaskStatus
  ): string | null {
    const newChar = this.statusToChar(status);

    // 1) rich 格式：- [ ] **task-001**:
    const rich = new RegExp(
      `(^-\\s*\\[[^\\]]\\]\\s*\\*\\*${this.escapeRegExp(taskId)}\\*\\*:)`,
      'm'
    );
    if (rich.test(markdown)) {
      return markdown.replace(
        new RegExp(
          `(^-\\s*)\\[[^\\]]\\](\\s*\\*\\*${this.escapeRegExp(taskId)}\\*\\*:)`,
          'm'
        ),
        `$1[${newChar}]$2`
      );
    }

    // 2) simple 格式：- [ ] Task title（无法定位 id），返回 null 走重建
    return null;
  }

  private escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ==========================================================================
  // 模板操作
  // ==========================================================================

  /**
   * 读取模板文件
   */
  async readTemplate(templateName: string): Promise<string | null> {
    try {
      const templatePath = join(this.getTemplatesPath(), templateName);
      return await readFile(templatePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * 写入模板文件
   */
  async writeTemplate(templateName: string, content: string): Promise<void> {
    await mkdir(this.getTemplatesPath(), { recursive: true });
    await writeFile(join(this.getTemplatesPath(), templateName), content, 'utf-8');
  }

  // ==========================================================================
  // 清理操作
  // ==========================================================================

  /**
   * 删除指定规范
   */
  async deleteSpec(specId: string): Promise<void> {
    await rm(this.getSpecDirPath(specId), { recursive: true, force: true });
  }

  /**
   * 清理整个 SpecKit 目录
   */
  async clean(): Promise<void> {
    await rm(this.getRootPath(), { recursive: true, force: true });
  }

  // ==========================================================================
  // 辅助方法
  // ==========================================================================

  private async fileExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private extractTitle(content: string): string | null {
    const match = content.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() ?? null;
  }

  private extractSection(content: string, ...sectionNames: string[]): string | null {
    for (const name of sectionNames) {
      const regex = new RegExp(`^##\\s+${name}\\s*\n([\\s\\S]*?)(?=^##|$)`, 'mi');
      const match = content.match(regex);
      if (match) {
        return match[1]?.trim() ?? '';
      }
    }
    return null;
  }

  private extractListItems(content: string, ...sectionNames: string[]): string[] {
    const section = this.extractSection(content, ...sectionNames);
    if (!section) return [];

    const items: string[] = [];
    const lines = section.split('\n');
    for (const line of lines) {
      const match = line.match(/^[-*]\s+(.+)$/);
      if (match) {
        items.push(match[1]?.trim() ?? '');
      }
    }
    return items;
  }

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async writeJsonFile(filePath: string, data: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 SpecKit 文件管理器
 */
export function createSpecKitFileManager(config: SpecKitFileManagerConfig): SpecKitFileManager {
  return new SpecKitFileManager(config);
}

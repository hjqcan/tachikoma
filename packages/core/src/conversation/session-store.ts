/**
 * Session Store
 *
 * 会话持久化存储，支持检查点管理
 */

import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionState, Checkpoint, ConversationMessage } from './types';
import type { PlanFile, ProgressFile } from '../orchestrator/session/types';
import { atomicWriteJson } from '../orchestrator/session/utils';

// =============================================================================
// 常量
// =============================================================================

const SESSION_FILE = 'session.json';
const CANONICAL_SESSIONS_DIR = 'sessions';
const CONVERSATION_DIR = 'conversation';
const CHECKPOINTS_DIR = 'checkpoints';
const WORKSPACE_SNAPSHOT_FILE = 'workspace.json';
const WORKSPACE_FILES_DIR = 'workspace_files';
const ORCHESTRATOR_SNAPSHOT_DIR = 'orchestrator';
const ORCHESTRATOR_SNAPSHOT_FILES = ['plan.json', 'progress.json', 'decisions.jsonl'];

const execFileAsync = promisify(execFile);

interface WorkspaceSnapshot {
  id: string;
  createdAt: number;
  workDir: string;
  repoRoot: string;
  trackedModified: string[];
  trackedDeleted: string[];
  untracked: string[];
  filesDir: string;
}

// =============================================================================
// SessionStore 类
// =============================================================================

/**
 * 会话存储管理器
 */
export class SessionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  /**
   * 创建新会话
   */
  async createSession(workDir: string): Promise<SessionState> {
    const sessionId = `conv-${randomUUID().substring(0, 8)}`;
    const now = Date.now();

    const session: SessionState = {
      sessionId,
      createdAt: now,
      lastActiveAt: now,
      workDir,
      messages: [],
      completedSubtasks: [],
      pendingSubtasks: [],
      checkpoints: [],
      variables: {},
      waitingForUser: false,
    };

    await this.saveSession(session);
    return session;
  }

  /**
   * 获取会话
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    const canonical = await this.readCanonicalSession(sessionId);
    if (canonical) {
      await this.hydrateSessionFromOrchestrator(canonical);
      return canonical;
    }

    const legacy = await this.readLegacySession(sessionId);
    if (legacy) {
      // Best-effort migration: write canonical copy so future reads use the orchestrator session root.
      await this.saveSession(legacy).catch(() => undefined);
      await this.hydrateSessionFromOrchestrator(legacy);
      return legacy;
    }

    // If this session was created by Orchestrator directly, synthesize a minimal SessionState.
    const synthesized = await this.synthesizeFromOrchestrator(sessionId);
    if (synthesized) return synthesized;

    return null;
  }

  /**
   * 保存会话
   */
  async saveSession(session: SessionState): Promise<void> {
    const sessionPath = this.getCanonicalSessionPath(session.sessionId);
    await mkdir(sessionPath, { recursive: true });

    session.lastActiveAt = Date.now();
    // Use atomic write to prevent half-written JSON on crash
    await atomicWriteJson(join(sessionPath, SESSION_FILE), session);
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<void> {
    const canonicalRoot = this.getCanonicalSessionRoot(sessionId);
    await rm(canonicalRoot, { recursive: true, force: true });

    // Legacy cleanup (best-effort).
    const legacyRoot = this.getLegacySessionPath(sessionId);
    await rm(legacyRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * 列出所有会话
   */
  async listSessions(): Promise<SessionState[]> {
    try {
      await mkdir(this.baseDir, { recursive: true });
      const sessionsDir = join(this.baseDir, CANONICAL_SESSIONS_DIR);
      await mkdir(sessionsDir, { recursive: true });

      const entries = await readdir(sessionsDir, { withFileTypes: true });
      const sessions: SessionState[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const session = await this.getSession(entry.name);
        if (session) sessions.push(session);
      }

      // Backward compatibility: also scan legacy `baseDir/conv-*` directories.
      const legacyEntries = await readdir(this.baseDir, { withFileTypes: true });
      for (const entry of legacyEntries) {
        if (!entry.isDirectory() || !entry.name.startsWith('conv-')) continue;
        if (sessions.some((s) => s.sessionId === entry.name)) continue;
        const session = await this.getSession(entry.name);
        if (session) sessions.push(session);
      }

      // 按最后活动时间排序
      return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Message Management
  // ---------------------------------------------------------------------------

  /**
   * 添加消息
   */
  async addMessage(
    sessionId: string,
    message: Omit<ConversationMessage, 'id' | 'timestamp'>
  ): Promise<ConversationMessage> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const fullMessage: ConversationMessage = {
      ...message,
      id: `msg-${randomUUID().substring(0, 8)}`,
      timestamp: Date.now(),
    };

    session.messages.push(fullMessage);
    await this.saveSession(session);

    return fullMessage;
  }

  // ---------------------------------------------------------------------------
  // Checkpoint Management
  // ---------------------------------------------------------------------------

  /**
   * 创建检查点
   */
  async createCheckpoint(
    sessionId: string,
    description: string,
    options?: {
      includeWorkspaceSnapshot?: boolean;
      includeOrchestratorSnapshot?: boolean;
    }
  ): Promise<Checkpoint> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const checkpoint: Checkpoint = {
      id: `ckpt-${randomUUID().substring(0, 8)}`,
      timestamp: Date.now(),
      description,
      messageIndex: session.messages.length,
    };
    checkpoint.hasWorkspaceSnapshot = false;
    checkpoint.hasOrchestratorSnapshot = false;

    const includeWorkspaceSnapshot = options?.includeWorkspaceSnapshot ?? false;
    const includeOrchestratorSnapshot = options?.includeOrchestratorSnapshot ?? includeWorkspaceSnapshot;

    if (includeWorkspaceSnapshot) {
      try {
        const snapshotPath = await this.createWorkspaceSnapshot(
          sessionId,
          checkpoint.id,
          session.workDir
        );
        if (snapshotPath) {
          checkpoint.snapshotPath = snapshotPath;
          checkpoint.hasWorkspaceSnapshot = true;
        }
      } catch (error) {
        console.warn('[SessionStore] Failed to create workspace snapshot (non-fatal):', error);
      }
    }

    if (includeOrchestratorSnapshot) {
      try {
        await this.captureOrchestratorSnapshot(sessionId, checkpoint.id);
        checkpoint.hasOrchestratorSnapshot = true;
      } catch (error) {
        console.warn('[SessionStore] Failed to capture orchestrator snapshot (non-fatal):', error);
      }
    }

    session.checkpoints.push(checkpoint);
    await this.saveSession(session);

    return checkpoint;
  }

  /**
   * 回滚到检查点
   */
  async rollbackToCheckpoint(
    sessionId: string,
    checkpointId: string
  ): Promise<SessionState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const checkpointIndex = session.checkpoints.findIndex(
      (c) => c.id === checkpointId
    );
    if (checkpointIndex === -1) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const checkpoint = session.checkpoints[checkpointIndex];
    if (!checkpoint) {
      throw new Error(`Checkpoint data is undefined: ${checkpointId}`);
    }

    if (checkpoint.snapshotPath) {
      await this.restoreWorkspaceSnapshot(checkpoint.snapshotPath);
    }
    const hasOrchestratorSnapshot =
      checkpoint.hasOrchestratorSnapshot ?? (await this.hasOrchestratorSnapshot(sessionId, checkpoint.id));
    if (hasOrchestratorSnapshot) {
      await this.restoreOrchestratorSnapshot(sessionId, checkpoint.id).catch((error) => {
        console.warn('[SessionStore] Failed to restore orchestrator snapshot (non-fatal):', error);
      });
    }

    // 截断消息历史
    session.messages = session.messages.slice(0, checkpoint.messageIndex);

    // 移除此检查点之后的所有检查点
    session.checkpoints = session.checkpoints.slice(0, checkpointIndex + 1);

    // 重置执行状态
    session.currentPlan = undefined;
    session.completedSubtasks = [];
    session.pendingSubtasks = [];
    session.waitingForUser = false;
    session.pendingQuestion = undefined;

    await this.saveSession(session);
    return session;
  }

  /**
   * 获取最近的检查点
   */
  async getLatestCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const session = await this.getSession(sessionId);
    if (!session || session.checkpoints.length === 0) {
      return null;
    }
    return session.checkpoints[session.checkpoints.length - 1] ?? null;
  }

  /**
   * 关联 orchestrator 检查点（用于恢复执行）
   */
  async attachOrchestratorCheckpoint(
    sessionId: string,
    checkpointId: string,
    orchestratorCheckpointId: string
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const checkpoint = session.checkpoints.find((cp) => cp.id === checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    checkpoint.orchestratorCheckpointId = orchestratorCheckpointId;
    await this.saveSession(session);
  }

  /**
   * 恢复检查点相关的文件快照（不修改对话消息）
   */
  async restoreCheckpointAssets(
    sessionId: string,
    checkpointId: string,
    options: { workspace?: boolean; orchestrator?: boolean } = {}
  ): Promise<{ restoredWorkspace: boolean; restoredOrchestrator: boolean }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const checkpoint = session.checkpoints.find((cp) => cp.id === checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    let restoredWorkspace = false;
    if (options.workspace !== false && checkpoint.snapshotPath) {
      await this.restoreWorkspaceSnapshot(checkpoint.snapshotPath);
      restoredWorkspace = true;
    }

    let restoredOrchestrator = false;
    if (options.orchestrator !== false) {
      const hasOrchestratorSnapshot =
        checkpoint.hasOrchestratorSnapshot ?? (await this.hasOrchestratorSnapshot(sessionId, checkpoint.id));
      if (hasOrchestratorSnapshot) {
        await this.restoreOrchestratorSnapshot(sessionId, checkpoint.id);
        restoredOrchestrator = true;
      }
    }

    return { restoredWorkspace, restoredOrchestrator };
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * 获取 canonical 会话 conversation 目录路径
   */
  private getCanonicalSessionPath(sessionId: string): string {
    return join(this.getCanonicalSessionRoot(sessionId), CONVERSATION_DIR);
  }

  private getCanonicalSessionRoot(sessionId: string): string {
    return join(this.baseDir, CANONICAL_SESSIONS_DIR, sessionId);
  }

  private getLegacySessionPath(sessionId: string): string {
    return join(this.baseDir, sessionId);
  }

  private async readCanonicalSession(sessionId: string): Promise<SessionState | null> {
    try {
      const content = await readFile(join(this.getCanonicalSessionPath(sessionId), SESSION_FILE), 'utf-8');
      return JSON.parse(content) as SessionState;
    } catch {
      return null;
    }
  }

  private async readLegacySession(sessionId: string): Promise<SessionState | null> {
    try {
      const content = await readFile(join(this.getLegacySessionPath(sessionId), SESSION_FILE), 'utf-8');
      return JSON.parse(content) as SessionState;
    } catch {
      return null;
    }
  }

  private async synthesizeFromOrchestrator(sessionId: string): Promise<SessionState | null> {
    const progressPath = join(this.getCanonicalSessionRoot(sessionId), 'orchestrator', 'progress.json');
    const planPath = join(this.getCanonicalSessionRoot(sessionId), 'orchestrator', 'plan.json');

    let progress: ProgressFile | null = null;
    let plan: PlanFile | null = null;

    try {
      progress = JSON.parse(await readFile(progressPath, 'utf-8')) as ProgressFile;
    } catch {
      // ignore
    }
    try {
      plan = JSON.parse(await readFile(planPath, 'utf-8')) as PlanFile;
    } catch {
      // ignore
    }

    if (!progress && !plan) return null;

    const createdAt = progress?.startedAt ?? plan?.createdAt ?? Date.now();
    const session: SessionState = {
      sessionId,
      createdAt,
      lastActiveAt: progress?.updatedAt ?? plan?.updatedAt ?? Date.now(),
      workDir: '',
      messages: [],
      completedSubtasks: [],
      pendingSubtasks: [],
      checkpoints: [],
      variables: {},
      waitingForUser: false,
    };

    await this.hydrateSessionFromOrchestrator(session);
    return session;
  }

  private async hydrateSessionFromOrchestrator(session: SessionState): Promise<void> {
    const sessionRoot = this.getCanonicalSessionRoot(session.sessionId);
    const progressPath = join(sessionRoot, 'orchestrator', 'progress.json');
    const planPath = join(sessionRoot, 'orchestrator', 'plan.json');

    let progress: ProgressFile | null = null;
    let plan: PlanFile | null = null;

    try {
      progress = JSON.parse(await readFile(progressPath, 'utf-8')) as ProgressFile;
    } catch {
      // ignore
    }
    try {
      plan = JSON.parse(await readFile(planPath, 'utf-8')) as PlanFile;
    } catch {
      // ignore
    }

    if (plan?.plannerOutput) {
      const subtasks = plan.plannerOutput.subtasks.map((st) => ({ ...st }));
      const completed = new Set(progress?.completedSubtasks ?? []);
      const failed = new Set(progress?.failedSubtasks ?? []);
      const running = new Set(progress?.runningSubtasks ?? []);

      for (const st of subtasks) {
        if (completed.has(st.id)) st.status = 'success';
        else if (failed.has(st.id)) st.status = 'failure';
        else if (running.has(st.id)) st.status = 'running';
      }

      session.currentPlan = {
        subtasks,
        executionOrder: plan.plannerOutput.executionPlan.steps.flatMap((s) => s.subtaskIds),
      };
    }

    if (progress) {
      session.completedSubtasks = Array.isArray(progress.completedSubtasks) ? progress.completedSubtasks.slice() : [];

      const completed = new Set(progress.completedSubtasks ?? []);
      const failed = new Set(progress.failedSubtasks ?? []);
      const planIds = session.currentPlan?.subtasks?.map((s) => s.id) ?? [];
      session.pendingSubtasks = planIds.filter((id) => !completed.has(id) && !failed.has(id));
    }
  }

  private getCheckpointRoot(sessionId: string, checkpointId: string): string {
    return join(this.getCanonicalSessionPath(sessionId), CHECKPOINTS_DIR, checkpointId);
  }

  private async runGit(args: string[], cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd });
      return stdout.toString();
    } catch {
      return null;
    }
  }

  private async readGitPaths(args: string[], cwd: string): Promise<string[]> {
    const output = await this.runGit(args, cwd);
    if (!output) return [];
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async createWorkspaceSnapshot(
    sessionId: string,
    checkpointId: string,
    workDir: string
  ): Promise<string | undefined> {
    if (!workDir) return undefined;

    const repoRootRaw = await this.runGit(['rev-parse', '--show-toplevel'], workDir);
    if (!repoRootRaw) return undefined;
    const repoRoot = repoRootRaw.trim();
    if (!repoRoot) return undefined;

    const modified = await this.readGitPaths(
      ['diff', '--name-only', '--diff-filter=ACMRTUXB'],
      repoRoot
    );
    const modifiedStaged = await this.readGitPaths(
      ['diff', '--name-only', '--staged', '--diff-filter=ACMRTUXB'],
      repoRoot
    );
    const deleted = await this.readGitPaths(
      ['diff', '--name-only', '--diff-filter=D'],
      repoRoot
    );
    const deletedStaged = await this.readGitPaths(
      ['diff', '--name-only', '--staged', '--diff-filter=D'],
      repoRoot
    );
    const untracked = await this.readGitPaths(
      ['ls-files', '--others', '--exclude-standard'],
      repoRoot
    );

    const trackedDeletedSet = new Set([...deleted, ...deletedStaged]);
    const trackedModified = Array.from(
      new Set([...modified, ...modifiedStaged].filter((p) => !trackedDeletedSet.has(p)))
    );
    const trackedDeleted = Array.from(trackedDeletedSet);

    const snapshotDir = this.getCheckpointRoot(sessionId, checkpointId);
    const filesDir = join(snapshotDir, WORKSPACE_FILES_DIR);
    await mkdir(filesDir, { recursive: true });

    const snapshot: WorkspaceSnapshot = {
      id: checkpointId,
      createdAt: Date.now(),
      workDir,
      repoRoot,
      trackedModified,
      trackedDeleted,
      untracked,
      filesDir: WORKSPACE_FILES_DIR,
    };

    const copyTargets = [...trackedModified, ...untracked];
    for (const relativePath of copyTargets) {
      const sourcePath = join(repoRoot, relativePath);
      try {
        const info = await stat(sourcePath);
        if (!info.isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      const destPath = join(filesDir, relativePath);
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);
    }

    const snapshotPath = join(snapshotDir, WORKSPACE_SNAPSHOT_FILE);
    await atomicWriteJson(snapshotPath, snapshot);
    return snapshotPath;
  }

  private async restoreWorkspaceSnapshot(snapshotPath: string): Promise<void> {
    const snapshotRaw = await readFile(snapshotPath, 'utf-8');
    const snapshot = JSON.parse(snapshotRaw) as WorkspaceSnapshot;
    const repoRoot = snapshot.repoRoot;
    if (!repoRoot) {
      throw new Error('Workspace snapshot missing repoRoot');
    }

    const workDirRelative = relative(repoRoot, snapshot.workDir);
    const normalizedWorkDir = workDirRelative.split(sep).join('/');
    const shouldScope =
      normalizedWorkDir &&
      normalizedWorkDir !== '.' &&
      !normalizedWorkDir.startsWith('..') &&
      !normalizedWorkDir.startsWith('/');
    const scopePrefix = shouldScope ? normalizedWorkDir : '';
    const inScope = (relativePath: string): boolean =>
      !scopePrefix || relativePath === scopePrefix || relativePath.startsWith(`${scopePrefix}/`);

    const trackedModified = snapshot.trackedModified.filter(inScope);
    const trackedDeleted = snapshot.trackedDeleted.filter(inScope);
    const untracked = snapshot.untracked.filter(inScope);

    for (const relativePath of trackedDeleted) {
      const targetPath = join(repoRoot, relativePath);
      await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }

    const filesDir = join(dirname(snapshotPath), snapshot.filesDir);
    const restoreTargets = [...trackedModified, ...untracked];
    for (const relativePath of restoreTargets) {
      const sourcePath = join(filesDir, relativePath);
      try {
        await stat(sourcePath);
      } catch {
        continue;
      }
      const destPath = join(repoRoot, relativePath);
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);
    }

  }

  private async captureOrchestratorSnapshot(sessionId: string, checkpointId: string): Promise<void> {
    const sessionRoot = this.getCanonicalSessionRoot(sessionId);
    const sourceDir = join(sessionRoot, 'orchestrator');
    const snapshotDir = join(this.getCheckpointRoot(sessionId, checkpointId), ORCHESTRATOR_SNAPSHOT_DIR);
    await mkdir(snapshotDir, { recursive: true });

    for (const fileName of ORCHESTRATOR_SNAPSHOT_FILES) {
      const sourcePath = join(sourceDir, fileName);
      try {
        await stat(sourcePath);
      } catch {
        continue;
      }
      const destPath = join(snapshotDir, fileName);
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);
    }
  }

  private async restoreOrchestratorSnapshot(sessionId: string, checkpointId: string): Promise<void> {
    const sessionRoot = this.getCanonicalSessionRoot(sessionId);
    const snapshotDir = join(this.getCheckpointRoot(sessionId, checkpointId), ORCHESTRATOR_SNAPSHOT_DIR);

    let restoredAny = false;
    for (const fileName of ORCHESTRATOR_SNAPSHOT_FILES) {
      const snapshotPath = join(snapshotDir, fileName);
      const targetPath = join(sessionRoot, 'orchestrator', fileName);
      try {
        await stat(snapshotPath);
        await mkdir(dirname(targetPath), { recursive: true });
        await copyFile(snapshotPath, targetPath);
        restoredAny = true;
      } catch {
        continue;
      }
    }
    if (!restoredAny) {
      return;
    }
  }

  private async hasOrchestratorSnapshot(sessionId: string, checkpointId: string): Promise<boolean> {
    const snapshotDir = join(this.getCheckpointRoot(sessionId, checkpointId), ORCHESTRATOR_SNAPSHOT_DIR);
    for (const fileName of ORCHESTRATOR_SNAPSHOT_FILES) {
      const snapshotPath = join(snapshotDir, fileName);
      try {
        await stat(snapshotPath);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }
}

/**
 * Environment Information Collector
 *
 * Gathers runtime environment details for system prompt injection.
 * Ported from Claude Code's `computeSimpleEnvInfo()`.
 *
 * @module prompt/system-prompt/env-info
 */

import { platform, type as osType, release as osRelease, hostname } from 'os';
import { execSync } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export interface EnvironmentInfo {
  /** Current working directory */
  cwd: string;
  /** Operating system type */
  platform: string;
  /** Shell name */
  shell: string;
  /** Whether the project is a git repo */
  isGit: boolean;
  /** Current git branch (if git repo) */
  gitBranch?: string | undefined;
  /** Current date string */
  date: string;
  /** Hostname */
  hostname: string;
  /** LLM model name */
  model?: string | undefined;
  /** LLM provider name */
  provider?: string | undefined;
}

// ============================================================================
// Helpers
// ============================================================================

function getShell(): string {
  return process.env.SHELL || process.env.ComSpec || '/bin/sh';
}

function getGitBranch(cwd: string): string | undefined {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function getSessionDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Collect environment information for system prompt.
 */
export function collectEnvironmentInfo(
  cwd: string,
  options?: { model?: string | undefined; provider?: string | undefined },
): EnvironmentInfo {
  const isGit = isGitRepo(cwd);
  return {
    cwd,
    platform: `${osType()} ${platform()} ${osRelease()}`,
    shell: getShell(),
    isGit,
    gitBranch: isGit ? getGitBranch(cwd) : undefined,
    date: getSessionDate(),
    hostname: hostname(),
    model: options?.model,
    provider: options?.provider,
  };
}

/**
 * Format environment info as a system prompt section string.
 *
 * Mirrors Claude Code's `computeSimpleEnvInfo()`.
 */
export function formatEnvironmentSection(info: EnvironmentInfo): string {
  const lines = [
    '# Environment',
    `- Working directory: ${info.cwd}`,
    `- Platform: ${info.platform}`,
    `- Shell: ${info.shell}`,
    `- Date: ${info.date}`,
  ];

  if (info.isGit && info.gitBranch) {
    lines.push(`- Git branch: ${info.gitBranch}`);
  }

  if (info.model) {
    const providerLabel = info.provider ? ` (${info.provider})` : '';
    lines.push(`- Model: ${info.model}${providerLabel}`);
  }

  return lines.join('\n');
}

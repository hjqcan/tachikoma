/**
 * 核心工具模块入口
 *
 * 导出所有核心工具
 */

export { fileReadTool } from './file-read';
export { fileWriteTool } from './file-write';
export { fileListTool } from './file-list';
export { shellRunTool } from './shell-run';
export { codeSearchTool } from './code-search';
export { applyPatchTool } from './file-patch';

// Agent/子任务工具
export { spawnSubagentTool } from './spawn-subagent';

export { todoWriteTool, todoReadTool } from './todo';

// 后台进程管理 (Claude Code-like /bashes)
export { 
  listBackgroundProcesses, 
  killBackgroundProcess, 
  getBackgroundProcessOutput,
  startBackgroundProcess,
  cleanupBackgroundProcesses,
  cleanupBackgroundProcessesForTask,
} from './shell-run';

// 安全工具函数
export {
  DEFAULT_ENV_WHITELIST,
  isEnvAllowed,
  filterEnvRequests,
  isDangerousScript,
  DANGEROUS_SCRIPT_PATTERNS,
  truncateWithNotice,
  DEFAULT_MAX_OUTPUT,
  detectPackageManager,
} from './security';

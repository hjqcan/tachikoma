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
export { replaceBetweenMarkersTool } from './file-replace-markers';

// 扩展工具
export { runTestsTool } from './run-tests';
export { typeCheckTool } from './type-check';
export { packageInfoTool } from './package-info';
export { envGetTool } from './env-get';

// Agent/子任务工具
export { spawnSubagentTool } from './spawn-subagent';
export { reportBackTool } from './report-back';

// 项目生成工具
export { scaffoldProjectTool } from './scaffold-project';
export { runLocalTool } from './run-local';
export { dockerizeTool } from './dockerize';

// 技能工具
export { createSkillTool } from './create-skill';

// 开发服务器工具
export { devServerTool, cleanupAllServers, cleanupServersForTask } from './dev-server';

// 后台进程管理工具 (Agent-facing, like Claude Code /bashes)
export { shellBgTool } from './shell-bg';

// 浏览器验证工具 (需要 playwright)
export { browserVerifyTool } from './browser-verify';

// 后台进程管理 (Claude Code-like /bashes)
export { 
  listBackgroundProcesses, 
  killBackgroundProcess, 
  getBackgroundProcessOutput,
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

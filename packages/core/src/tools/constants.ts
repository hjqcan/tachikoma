/**
 * Tool System Constants
 * 
 * 统一的默认值和配置常量
 */

/**
 * 默认资源限制
 * 
 * 所有工具应使用这些默认值以保持一致性
 */
export const DEFAULT_RESOURCE_LIMITS = {
  /** 最大文件大小（50MB） */
  maxFileSize: 50 * 1024 * 1024,
  
  /** 最大输出大小（50KB） */
  maxOutputSize: 50 * 1000,
  
  /** 最大执行时间（30秒） */
  maxExecutionTime: 30000,
} as const;

/**
 * 环境变量白名单
 * 
 * 允许继承的安全环境变量
 */
export const ENV_WHITELIST = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'NODE_ENV',
] as const;

/**
 * Shell安全限制
 */
export const SHELL_SAFETY = {
  /** 默认超时时间 */
  defaultTimeout: 30000,
  
  /** 最大超时时间 */
  maxTimeout: 300000, // 5分钟
  
  /** 禁用颜色输出 */
  forceColor: '0',
  
  /** 终端类型 */
  termType: 'dumb',
} as const;

/**
 * file_list 默认排除目录
 * 
 * 递归列表时自动排除这些大目录，防止 token 爆炸
 * 参考 Codex/Claude Code/Gemini CLI 等工具的常见排除列表
 */
export const FILE_LIST_DEFAULT_EXCLUDES = [
  // 包管理器
  'node_modules',
  '.npm',
  '.pnpm',
  '.yarn',
  'vendor',        // PHP/Go
  
  // VCS
  '.git',
  '.hg',
  '.svn',
  
  // 构建产物
  'dist',
  'build',
  'out',
  'target',        // Java/Scala/Rust
  
  // 缓存目录
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.gradle',
  
  // 框架特定
  '.next',
  '.nuxt',
  
  // Python
  '__pycache__',
  '.venv',
  '.tox',
  
  // 测试/覆盖率
  'coverage',
  
  // IDE
  '.idea',
  '.vscode',
  
  // 基础设施
  '.terraform',
  
  // 系统/项目
  '.tachikoma',
  '.DS_Store',
] as const;

/**
 * file_list 最大返回结果数
 * 
 * 超过此数量时截断并提示
 */
export const FILE_LIST_MAX_RESULTS = 500;

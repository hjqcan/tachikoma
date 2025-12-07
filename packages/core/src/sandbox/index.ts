/**
 * Sandbox 模块入口
 *
 * 导出沙盒相关的类型、基类和工具函数
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // 运行时类型
  SandboxRuntime,
  RuntimeConfig,
  DockerRuntimeConfig,
  FirecrackerRuntimeConfig,
  LocalRuntimeConfig,

  // 网络配置
  NetworkMode,
  SandboxNetworkConfig,

  // 资源配置
  SandboxResources,
  MountConfig,
  FilesystemConfig,

  // 主配置
  SandboxConfig,
  SandboxConfigOptions,

  // 状态
  SandboxStatus,
  SandboxStateInfo,
  ResourceUsage,

  // 执行相关
  ExecutionOptions,
  ExecutionResult,
  CommandResult,
  CodeExecutionResult,

  // 接口
  Sandbox,
  SandboxFactory,
  SandboxCreateOptions,
  SandboxLifecycleHooks,
} from './types';

// ============================================================================
// 值导出
// ============================================================================

export {
  // 默认配置
  DEFAULT_SANDBOX_RESOURCES,
  DEFAULT_SANDBOX_NETWORK,
  DEFAULT_SANDBOX_CONFIG,

  // 工具函数
  createSandboxConfig,
} from './types';

// ============================================================================
// 基类导出
// ============================================================================

export { BaseSandbox, TimeoutError, type SandboxLogContext } from './base';

// ============================================================================
// 驱动导出（后续子任务实现后添加）
// ============================================================================

// TODO: Task 5.2 - Docker 驱动
// export { DockerSandbox } from './drivers/docker';

// TODO: Task 5.3 - Local 驱动
// export { LocalSandbox } from './drivers/local';

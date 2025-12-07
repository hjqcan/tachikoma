/**
 * 沙盒驱动模块入口
 *
 * 导出所有沙盒驱动实现
 */

// ============================================================================
// 本地驱动（仅开发/测试）
// ============================================================================

export {
  LocalSandbox,
  createLocalSandbox,
  CommandNotAllowedError,
  PathOutOfBoundsError,
} from './local';

// ============================================================================
// Docker 驱动
// ============================================================================

export {
  DockerSandbox,
  DockerSandboxPool,
  isDockerAvailable,
  getDockerVersion,
  type DockerSandboxPoolConfig,
} from './docker';

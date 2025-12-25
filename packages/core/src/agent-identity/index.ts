/**
 * Agent Identity 模块
 *
 * 实现 Letta-Code 风格的 Agent 身份持久化：
 * - Memory Blocks 分层架构
 * - Agent Identity 持久化
 * - Core Memory 进化
 *
 * @module agent-identity
 */

// ============================================================================
// Blocks - 分层 Memory Block 系统
// ============================================================================

export {
  // 类型
  type BlockScope,
  type GlobalBlockLabel,
  type ProjectBlockLabel,
  type ReadOnlyBlockLabel,
  type BlockLabel,
  type MemoryBlock,
  type BlockConfig,
  type BlockWriteResult,
  type BlockWriteOptions,
  // 常量
  BLOCK_LABELS,
  BLOCK_DESCRIPTIONS,
  DEFAULT_BLOCK_CONTENT,
  DEFAULT_GLOBAL_MEMORY_DIR,
  DEFAULT_MAX_FILE_SIZE,
  BLOCK_FILE_EXTENSION,
  TRUSTED_SOURCES,
  type TrustedSource,
  // 工具函数
  getBlockScope,
  isReadOnlyBlock,
  getGlobalBlocksDir,
  getProjectBlocksDir,
  // 类
  BlockLoader,
  BlockWriter,
  // 工厂函数
  createBlockLoader,
  createBlockWriter,
} from './blocks';

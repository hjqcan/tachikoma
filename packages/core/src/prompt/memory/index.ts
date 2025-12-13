/**
 * 记忆模块
 *
 * 提供持久化记忆存储和工作记忆管理
 *
 * @module prompt/memory
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  MemoryType,
  MemoryEntry,
  MemoryMetadata,
  RetrieveOptions,
  IMemoryStore,
} from './types';

export { createMemoryEntry, DEFAULT_RETRIEVE_OPTIONS } from './types';

// ============================================================================
// 笔记系统（向后兼容）
// ============================================================================

export { NoteManager, createNoteManager } from './note-taking';

// ============================================================================
// 文件系统存储
// ============================================================================

export {
  FileSystemMemoryStore,
  createFileSystemMemoryStore,
  DEFAULT_FILE_STORE_CONFIG,
  type FileStoreConfig,
  type FileStoreStats,
} from './file-store';

// ============================================================================
// 工作记忆管理
// ============================================================================

export {
  WorkingMemoryManager,
  createWorkingMemoryManager,
  DEFAULT_WORKING_MEMORY_CONFIG,
  type WorkingMemoryConfig,
  type ContextSnapshot,
} from './working-memory';


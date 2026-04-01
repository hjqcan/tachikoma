/**
 * Read File State Cache
 *
 * Tracks which files have been read in the current session.
 * Used by validateInput() to enforce "read before edit" rules.
 *
 * Ported from Claude Code's `FileStateCache` concept.
 *
 * @module tools/read-file-state
 */

// ============================================================================
// Types
// ============================================================================

interface FileReadEntry {
  /** When the file was last read */
  timestamp: number;
  /** File size at read time (bytes) */
  size: number;
  /** Optional content hash for freshness checks */
  hash?: string | undefined;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Tracks which files have been read during the current task/session.
 *
 * The primary use case is enforcing Claude Code's "read before edit" rule:
 * tools like apply_patch and file_write can check `readFileState.has(path)`
 * before executing, and reject the call if the file hasn't been read first.
 *
 * This prevents the LLM from editing files it hasn't seen, which is a
 * common source of incorrect patches.
 *
 * @example
 * ```ts
 * const state = new ReadFileStateCache();
 *
 * // file_read tool marks files as read
 * state.markRead('/src/index.ts', 1234);
 *
 * // apply_patch tool checks before editing
 * if (!state.has('/src/index.ts')) {
 *   return { success: false, error: 'Read the file first' };
 * }
 * ```
 */
export class ReadFileStateCache {
  private readFiles = new Map<string, FileReadEntry>();

  /**
   * Mark a file as having been read.
   */
  markRead(filePath: string, size: number, hash?: string): void {
    this.readFiles.set(filePath, {
      timestamp: Date.now(),
      size,
      hash,
    });
  }

  /**
   * Check if a file has been read in this session.
   */
  has(filePath: string): boolean {
    return this.readFiles.has(filePath);
  }

  /**
   * Get the read entry for a file (if read).
   */
  get(filePath: string): FileReadEntry | undefined {
    return this.readFiles.get(filePath);
  }

  /**
   * Remove a file from the read state.
   * Call this when a file is known to have changed externally.
   */
  invalidate(filePath: string): void {
    this.readFiles.delete(filePath);
  }

  /**
   * Get the number of tracked files.
   */
  get size(): number {
    return this.readFiles.size;
  }

  /**
   * Get all tracked file paths.
   */
  paths(): string[] {
    return Array.from(this.readFiles.keys());
  }

  /**
   * Clear all state.
   * Call on task completion or session reset.
   */
  clear(): void {
    this.readFiles.clear();
  }
}

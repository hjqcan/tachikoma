/**
 * Workspace Structure Cache
 *
 * Captures and caches the workspace directory structure from file_list calls
 * to provide context to the agent about what actually exists in the project.
 * This helps prevent the agent from trying to access non-existent paths.
 */

/**
 * A cached directory entry
 */
export interface CachedDirectory {
  /** Absolute path of the directory */
  path: string;
  /** Subdirectories within this directory */
  subdirectories: string[];
  /** Files within this directory */
  files: string[];
  /** When this entry was cached */
  cachedAt: number;
  /** Whether the directory exists */
  exists: boolean;
}

/**
 * Configuration for workspace cache
 */
export interface WorkspaceCacheConfig {
  /** Maximum number of directories to cache */
  maxEntries?: number;
  /** Cache TTL in milliseconds */
  ttlMs?: number;
}

const DEFAULT_CONFIG: Required<WorkspaceCacheConfig> = {
  maxEntries: 100,
  ttlMs: 10 * 60 * 1000, // 10 minutes
};

/**
 * Caches workspace structure from file_list tool calls
 *
 * @example
 * ```typescript
 * const cache = new WorkspaceStructureCache();
 *
 * // Record a file_list result
 * cache.recordDirectoryListing('/project', ['src', 'tests'], ['package.json', 'README.md']);
 *
 * // Generate context for the system prompt
 * const context = cache.generateContext();
 * // Returns: "## Workspace Structure\n/project\n  📁 src\n  📁 tests\n  📄 package.json..."
 * ```
 */
export class WorkspaceStructureCache {
  private readonly directories: Map<string, CachedDirectory> = new Map();
  private readonly config: Required<WorkspaceCacheConfig>;
  private readonly nonExistentPaths: Set<string> = new Set();

  constructor(config: WorkspaceCacheConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Records a directory listing from file_list
   */
  recordDirectoryListing(
    path: string,
    subdirectories: string[],
    files: string[]
  ): void {
    const normalizedPath = this.normalizePath(path);
    
    this.directories.set(normalizedPath, {
      path: normalizedPath,
      subdirectories: subdirectories.map(d => this.basename(d)),
      files: files.map(f => this.basename(f)),
      cachedAt: Date.now(),
      exists: true,
    });

    // Remove from non-existent if it was there
    this.nonExistentPaths.delete(normalizedPath);
    
    this.pruneOldEntries();
  }

  /**
   * Records that a path does not exist
   */
  recordNonExistent(path: string): void {
    const normalizedPath = this.normalizePath(path);
    this.nonExistentPaths.add(normalizedPath);
    
    // Remove from directories if it was cached as existing
    this.directories.delete(normalizedPath);
  }

  /**
   * Checks if a directory is known to exist
   */
  isKnownDirectory(path: string): boolean {
    const normalizedPath = this.normalizePath(path);
    const entry = this.directories.get(normalizedPath);
    return entry !== undefined && entry.exists;
  }

  /**
   * Checks if a path is known to not exist
   */
  isKnownNonExistent(path: string): boolean {
    const normalizedPath = this.normalizePath(path);
    return this.nonExistentPaths.has(normalizedPath);
  }

  /**
   * Normalizes a path for consistent caching
   */
  private normalizePath(path: string): string {
    // Remove trailing slashes, handle duplicates
    return path.replace(/\/+$/, '').replace(/\/+/g, '/');
  }

  /**
   * Gets the basename of a path
   */
  private basename(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  }

  /**
   * Removes old entries beyond TTL
   */
  private pruneOldEntries(): void {
    const cutoff = Date.now() - this.config.ttlMs;
    
    for (const [key, entry] of this.directories) {
      if (entry.cachedAt < cutoff) {
        this.directories.delete(key);
      }
    }

    // Limit size
    if (this.directories.size > this.config.maxEntries) {
      const sorted = Array.from(this.directories.entries())
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt);
      const toRemove = sorted.slice(0, this.directories.size - this.config.maxEntries);
      for (const [key] of toRemove) {
        this.directories.delete(key);
      }
    }
  }

  /**
   * Generates context string for system prompt injection
   */
  generateContext(): string | null {
    if (this.directories.size === 0 && this.nonExistentPaths.size === 0) {
      return null;
    }

    const lines: string[] = [];

    // Insert known workspace structure
    if (this.directories.size > 0) {
      lines.push('## Known Workspace Structure');
      lines.push('The following directories have been verified to exist:');
      lines.push('');

      // Sort by path for consistent output
      const sortedDirs = Array.from(this.directories.values())
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, 10); // Limit to top 10 for context size

      for (const dir of sortedDirs) {
        lines.push(`📁 ${dir.path}/`);
        
        // List subdirectories
        for (const subdir of dir.subdirectories.slice(0, 5)) {
          lines.push(`  └── 📁 ${subdir}/`);
        }
        if (dir.subdirectories.length > 5) {
          lines.push(`  └── ... and ${dir.subdirectories.length - 5} more directories`);
        }
        
        // List files (smaller)
        const fileCount = dir.files.length;
        if (fileCount > 0) {
          const shownFiles = dir.files.slice(0, 3);
          for (const file of shownFiles) {
            lines.push(`  └── 📄 ${file}`);
          }
          if (fileCount > 3) {
            lines.push(`  └── ... and ${fileCount - 3} more files`);
          }
        }
      }
    }

    // Insert non-existent path warnings
    if (this.nonExistentPaths.size > 0) {
      lines.push('');
      lines.push('## ⚠️ Non-Existent Paths (DO NOT attempt to access)');
      const paths = Array.from(this.nonExistentPaths).slice(0, 10);
      for (const path of paths) {
        lines.push(`  ❌ ${path}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Gets non-existent paths for validation
   */
  getNonExistentPaths(): string[] {
    return Array.from(this.nonExistentPaths);
  }

  /**
   * Clears the cache
   */
  clear(): void {
    this.directories.clear();
    this.nonExistentPaths.clear();
  }

  /**
   * Gets the number of cached entries
   */
  get size(): number {
    return this.directories.size;
  }

  /**
   * Gets the number of non-existent paths
   */
  get nonExistentCount(): number {
    return this.nonExistentPaths.size;
  }
}

/**
 * Parses file_list tool output to extract directories and files
 */
export function parseFileListOutput(
  output: unknown
): { isDirectory: boolean; subdirectories: string[]; files: string[] } | null {
  if (typeof output !== 'object' || output === null) {
    return null;
  }

  const result = output as Record<string, unknown>;

  // Variant A: Tachikoma ToolResult shape (file_list tool)
  // { success: boolean, data: { files: Array<{ path,name,isDirectory }> } }
  if (typeof result.success === 'boolean') {
    if (result.success !== true) {
      return null;
    }

    const data = (typeof result.data === 'object' && result.data !== null)
      ? (result.data as Record<string, unknown>)
      : null;
    const files = data && Array.isArray(data.files) ? data.files : null;
    if (!files) {
      return null;
    }

    const subdirectories = new Set<string>();
    const leafFiles = new Set<string>();

    for (const item of files) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;

      const relPath = typeof entry.path === 'string' ? entry.path : undefined;
      const isDirectory = typeof entry.isDirectory === 'boolean' ? entry.isDirectory : undefined;
      if (!relPath) continue;

      const trimmed = relPath.replace(/^\.\/+/, '').replace(/^\/+/, '');
      if (!trimmed) continue;
      const [first] = trimmed.split('/');
      if (!first) continue;

      // If recursive result includes nested paths, treat top-level segment as a known directory.
      if (trimmed.includes('/')) {
        subdirectories.add(first);
        continue;
      }

      // Non-recursive: direct children
      if (isDirectory) {
        subdirectories.add(first);
      } else {
        leafFiles.add(first);
      }
    }

    return {
      isDirectory: true,
      subdirectories: Array.from(subdirectories),
      files: Array.from(leafFiles),
    };
  }

  // Variant B: Legacy directory listing shape
  // { type: 'directory', items: Array<{ name, type: 'file'|'directory' }> }
  if (result.type !== 'directory' && !Array.isArray(result.items)) {
    return null;
  }

  const items = (result.items || []) as Array<{
    name: string;
    type: 'file' | 'directory';
  }>;

  const subdirectories: string[] = [];
  const files: string[] = [];

  for (const item of items) {
    if (item.type === 'directory') {
      subdirectories.push(item.name);
    } else if (item.type === 'file') {
      files.push(item.name);
    }
  }

  return { isDirectory: true, subdirectories, files };
}
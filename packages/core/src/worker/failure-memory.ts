/**
 * Failure Memory System
 *
 * Tracks patterns of failures across agent execution to provide
 * contextual warnings that help prevent repetitive errors.
 * Unlike ToolCallTracker which operates per-call, this system
 * detects higher-level patterns (e.g., "directory doesn't exist").
 */

/**
 * Types of failure patterns we can detect
 */
export type FailurePatternType =
  | 'file_not_found'
  | 'directory_not_found'
  | 'permission_denied'
  | 'invalid_params'
  | 'timeout'
  | 'rate_limit'
  | 'unknown';

/**
 * A detected failure pattern
 */
export interface DetectedPattern {
  /** Type of failure */
  type: FailurePatternType;
  /** Human-readable pattern description */
  pattern: string;
  /** Number of occurrences */
  count: number;
  /** Tools involved */
  tools: string[];
  /** Sample error message */
  sampleError?: string | undefined;
  /** First seen timestamp */
  firstSeen: number;
  /** Last seen timestamp */
  lastSeen: number;
  /** Extracted path or query from the pattern */
  affectedPath?: string | undefined;
}

/**
 * Configuration for failure memory
 */
export interface FailureMemoryConfig {
  /** Maximum patterns to track */
  maxPatterns?: number;
  /** Time window for pattern detection (ms) */
  patternWindowMs?: number;
  /** Minimum occurrences to report a pattern */
  minOccurrences?: number;
}

const DEFAULT_CONFIG: Required<FailureMemoryConfig> = {
  maxPatterns: 50,
  patternWindowMs: 10 * 60 * 1000, // 10 minutes
  minOccurrences: 2,
};

/**
 * Pattern matchers for extracting failure information from tool results
 */
const FAILURE_PATTERNS = [
  {
    type: 'file_not_found' as const,
    regex: /(?:file|path)\s+(?:not\s+found|does\s+not\s+exist|doesn't\s+exist)[:\s]*["']?([^"'\n]+)["']?/i,
    pathGroup: 1,
  },
  {
    type: 'directory_not_found' as const,
    regex: /(?:directory|folder|dir)\s+(?:not\s+found|does\s+not\s+exist|doesn't\s+exist)[:\s]*["']?([^"'\n]+)["']?/i,
    pathGroup: 1,
  },
  {
    type: 'file_not_found' as const,
    regex: /ENOENT[:\s]+(?:no such file or directory)[,\s]*(?:open\s+)?["']?([^"'\n]+)["']?/i,
    pathGroup: 1,
  },
  {
    type: 'permission_denied' as const,
    regex: /(?:permission\s+denied|access\s+denied|EACCES)[:\s]*["']?([^"'\n]+)["']?/i,
    pathGroup: 1,
  },
  {
    type: 'invalid_params' as const,
    regex: /(?:invalid|missing)\s+(?:parameter|argument|input)[s]?[:\s]*["']?([^"'\n]+)["']?/i,
    pathGroup: 1,
  },
  {
    type: 'timeout' as const,
    regex: /(?:timeout|timed?\s*out|ETIMEDOUT)/i,
    pathGroup: undefined,
  },
  {
    type: 'rate_limit' as const,
    regex: /(?:rate\s+limit|too\s+many\s+requests|429)/i,
    pathGroup: undefined,
  },
];

/**
 * Tracks failure patterns across agent execution
 *
 * @example
 * ```typescript
 * const memory = new FailureMemory();
 *
 * // Record a failure
 * memory.recordFailure('file_read', { path: '/foo/bar' }, 'File not found: /foo/bar');
 *
 * // Get warnings to inject into context
 * const warnings = memory.generateWarnings();
 * // Returns: "⚠️ KNOWN ISSUES:\n- Directory '/foo' does not exist (accessed 3 times)"
 * ```
 */
export class FailureMemory {
  private readonly patterns: Map<string, DetectedPattern> = new Map<string, DetectedPattern>();
  private readonly config: Required<FailureMemoryConfig>;

  constructor(config: FailureMemoryConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generates a unique key for a pattern
   */
  private patternKey(type: FailurePatternType, affectedPath?: string): string {
    return `${type}:${affectedPath || 'unknown'}`;
  }

  /**
   * Extracts a parent directory from a path
   */
  private extractParentDir(path: string): string | undefined {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 1) {
      return '/' + parts.slice(0, -1).join('/');
    }
    return undefined;
  }

  /**
   * Records a tool failure and extracts patterns
   *
   * @param toolName - Name of the tool that failed
   * @param input - Input parameters to the tool
   * @param errorMessage - Error message or result
   */
  recordFailure(toolName: string, input: unknown, errorMessage: string): void {
    const now = Date.now();
    
    // Truncate long error messages to prevent regex performance issues
    const truncatedError = errorMessage.length > 1000 
      ? errorMessage.substring(0, 1000) 
      : errorMessage;

    let matchedKnownPattern = false;

    // Try to match known failure patterns
    for (const matcher of FAILURE_PATTERNS) {
      const match = truncatedError.match(matcher.regex);
      if (!match) continue;

      matchedKnownPattern = true;
      const affectedPath =
        matcher.pathGroup !== undefined ? match[matcher.pathGroup] : undefined;
      const key = this.patternKey(matcher.type, affectedPath);

      const existing = this.patterns.get(key);
      if (existing) {
        existing.count++;
        existing.lastSeen = now;
        if (!existing.tools.includes(toolName)) {
          existing.tools.push(toolName);
        }
      } else {
        this.patterns.set(key, {
          type: matcher.type,
          pattern: this.generatePatternDescription(matcher.type, affectedPath),
          count: 1,
          tools: [toolName],
          sampleError: errorMessage.substring(0, 200),
          firstSeen: now,
          lastSeen: now,
          affectedPath,
        });
      }

      // Also track parent directory for file not found errors
      if (matcher.type === 'file_not_found' && affectedPath) {
        const parentDir = this.extractParentDir(affectedPath);
        if (parentDir) {
          const dirKey = this.patternKey('directory_not_found', parentDir);
          const dirPattern = this.patterns.get(dirKey);
          if (dirPattern) {
            // Increment if we have multiple file-not-found in the same directory
            dirPattern.count++;
            dirPattern.lastSeen = now;
          }
        }
      }

      break; // Found a match, stop searching
    }

    // Try to extract path from input if no pattern matched
    if (!matchedKnownPattern) {
      const inputPath = this.extractPathFromInput(input);
      if (inputPath) {
        const key = this.patternKey('unknown', inputPath);
        const existing = this.patterns.get(key);
        if (existing) {
          existing.count++;
          existing.lastSeen = now;
          if (!existing.tools.includes(toolName)) {
            existing.tools.push(toolName);
          }
        } else {
          this.patterns.set(key, {
            type: 'unknown',
            pattern: `Error with "${inputPath}"`,
            count: 1,
            tools: [toolName],
            sampleError: errorMessage.substring(0, 200),
            firstSeen: now,
            lastSeen: now,
            affectedPath: inputPath,
          });
        }
      }
    }

    // IMPORTANT: always prune (even when we matched a known pattern) so maxPatterns/window work.
    this.pruneOldPatterns();
  }

  /**
   * Extracts a path from tool input
   */
  private extractPathFromInput(input: unknown): string | undefined {
    if (typeof input !== 'object' || input === null) {
      return undefined;
    }
    const obj = input as Record<string, unknown>;
    if (typeof obj.path === 'string') return obj.path;
    if (typeof obj.file === 'string') return obj.file;
    if (typeof obj.directory === 'string') return obj.directory;
    if (typeof obj.dir === 'string') return obj.dir;
    return undefined;
  }

  /**
   * Generates a human-readable description for a pattern
   */
  private generatePatternDescription(type: FailurePatternType, path?: string): string {
    switch (type) {
      case 'file_not_found':
        return path ? `File "${path}" does not exist` : 'File not found';
      case 'directory_not_found':
        return path ? `Directory "${path}" does not exist` : 'Directory not found';
      case 'permission_denied':
        return path ? `Permission denied for "${path}"` : 'Permission denied';
      case 'invalid_params':
        return path ? `Invalid parameter: ${path}` : 'Invalid parameters';
      case 'timeout':
        return 'Operation timed out';
      case 'rate_limit':
        return 'Rate limit exceeded';
      default:
        return path ? `Error with "${path}"` : 'Unknown error';
    }
  }

  /**
   * Removes patterns outside the time window
   */
  private pruneOldPatterns(): void {
    const cutoff = Date.now() - this.config.patternWindowMs;
    for (const [key, pattern] of this.patterns) {
      if (pattern.lastSeen < cutoff) {
        this.patterns.delete(key);
      }
    }

    // Also limit total patterns
    if (this.patterns.size > this.config.maxPatterns) {
      const sorted = Array.from(this.patterns.entries())
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      const toRemove = sorted.slice(0, this.patterns.size - this.config.maxPatterns);
      for (const [key] of toRemove) {
        this.patterns.delete(key);
      }
    }
  }

  /**
   * Gets patterns that should be reported (above threshold)
   */
  getReportablePatterns(): DetectedPattern[] {
    const cutoff = Date.now() - this.config.patternWindowMs;
    return Array.from(this.patterns.values())
      .filter((p) => p.count >= this.config.minOccurrences && p.lastSeen >= cutoff)
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Generates warning text for injection into agent context
   *
   * @returns Warning string or null if no significant patterns
   */
  generateWarnings(): string | null {
    const patterns = this.getReportablePatterns();

    if (patterns.length === 0) {
      return null;
    }

    const lines = ['⚠️ KNOWN ISSUES (avoid repeating these errors):'];

    for (const pattern of patterns.slice(0, 5)) {
      let line = `  - ${pattern.pattern}`;
      if (pattern.count > 1) {
        line += ` (occurred ${pattern.count}x)`;
      }
      lines.push(line);
    }

    // Add specific advice based on patterns
    const hasFileNotFound = patterns.some((p) => p.type === 'file_not_found');
    const hasDirNotFound = patterns.some((p) => p.type === 'directory_not_found');
    const hasInvalidParams = patterns.some((p) => p.type === 'invalid_params');

    if (hasFileNotFound || hasDirNotFound) {
      lines.push('');
      lines.push('💡 TIP: Use file_list to verify paths before accessing files.');
    }

    if (hasInvalidParams) {
      lines.push('');
      lines.push('💡 TIP: Check tool documentation for required parameters.');
    }

    return lines.join('\n');
  }

  /**
   * Gets non-existent directories for path validation
   */
  getNonExistentDirectories(): string[] {
    return Array.from(this.patterns.values())
      .filter((p): p is DetectedPattern & { affectedPath: string } => 
        p.type === 'directory_not_found' && typeof p.affectedPath === 'string')
      .map((p) => p.affectedPath)
      .filter((v, i, a) => a.indexOf(v) === i); // Unique
  }

  /**
   * Clears all tracked patterns
   */
  clear(): void {
    this.patterns.clear();
  }

  /**
   * Gets the number of tracked patterns
   */
  get size(): number {
    return this.patterns.size;
  }
}
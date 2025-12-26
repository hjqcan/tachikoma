/**
 * Tool Call Tracker
 *
 * Tracks recent tool calls to detect and prevent repetitive patterns that
 * waste turns without making progress. This helps prevent MaxTurnsExceededError
 * caused by the LLM repeatedly making the same failed calls.
 */

import { createHash } from 'crypto';

/**
 * Represents a tracked tool call
 */
export interface TrackedCall {
  /** Name of the tool that was called */
  toolName: string;
  /** SHA256 hash of the input for comparison */
  inputHash: string;
  /** Original input (for debugging) */
  input: unknown;
  /** When the call was made */
  timestamp: number;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if the call failed */
  errorMessage?: string | undefined;
}

/**
 * Represents a detected failure pattern
 */
export interface FailurePattern {
  /** Description of the pattern */
  pattern: string;
  /** Number of times this pattern occurred */
  count: number;
  /** The tool involved */
  toolName: string;
  /** Sample error message */
  sampleError?: string | undefined;
}

/**
 * Result of duplicate check
 */
export interface DuplicateCheckResult {
  /** Whether this is a duplicate call */
  isDuplicate: boolean;
  /** Number of times this exact call has been made */
  count: number;
  /** Number of times it failed */
  failureCount: number;
  /** Warning message to inject into the response */
  warning?: string | undefined;
  /** Whether execution should be blocked */
  shouldBlock: boolean;
}

/**
 * Doom-loop detection result
 */
export interface DoomLoopCheckResult {
  /** Number of identical calls in the current window (including this one) */
  count: number;
  /** Whether the doom-loop threshold is reached */
  isLoop: boolean;
}

/**
 * Configuration for the tool call tracker
 */
export interface ToolCallTrackerConfig {
  /** Maximum number of calls to keep in history */
  maxHistory?: number;
  /** Time window in ms to consider for duplicates (default: 5 minutes) */
  duplicateWindowMs?: number;
  /** Number of failures before blocking execution */
  blockAfterFailures?: number;
  /** Whether to enable blocking (default: true) */
  enableBlocking?: boolean;
}

const DEFAULT_CONFIG: Required<ToolCallTrackerConfig> = {
  maxHistory: 100,
  duplicateWindowMs: 5 * 60 * 1000, // 5 minutes
  blockAfterFailures: 3,
  enableBlocking: true,
};

/**
 * Metrics for tool call tracking
 */
export interface TrackerMetrics {
  /** Total calls tracked */
  totalCalls: number;
  /** Calls that were blocked */
  blockedCalls: number;
  /** Calls detected as duplicates */
  duplicateCalls: number;
  /** Duplicate detection rate (0-1) */
  duplicateRate: number;
  /** Average failure rate */
  failureRate: number;
}

/**
 * Tracks tool calls to detect repetitive patterns and prevent wasted turns.
 *
 * @example
 * ```typescript
 * const tracker = new ToolCallTracker();
 *
 * // Before executing a tool
 * const check = tracker.checkDuplicate('file_read', { path: '/foo/bar' });
 * if (check.shouldBlock) {
 *   return { error: check.warning };
 * }
 *
 * // After execution
 * tracker.record('file_read', { path: '/foo/bar' }, false, 'File not found');
 *
 * // Get metrics
 * const metrics = tracker.getMetrics();
 * console.log(`Blocked ${metrics.blockedCalls} calls`);
 * ```
 */
export class ToolCallTracker {
  private readonly recentCalls: TrackedCall[] = [];
  private readonly config: Required<ToolCallTrackerConfig>;
  
  // Metrics counters
  private _blockedCalls = 0;
  private _duplicateCalls = 0;


  constructor(config: ToolCallTrackerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Computes a hash of the tool input for comparison.
   * Handles null, undefined, arrays, and primitive types safely.
   */
  private hashInput(input: unknown): string {
    const serialized = this.stableSerialize(input);
    return createHash('sha256').update(serialized).digest('hex').substring(0, 16);
  }

  /**
   * Stable (deterministic) serialization for hashing.
   *
   * IMPORTANT:
   * - We must preserve nested object keys/values; using JSON.stringify(value, string[])
   *   will drop nested keys and cause collisions.
   * - Tool inputs should be JSON-like; we still guard against cycles/non-JSON values.
   */
  private stableSerialize(input: unknown): string {
    if (input === null || input === undefined) {
      return String(input);
    }

    if (typeof input === 'bigint') {
      // JSON.stringify throws on BigInt
      return `${input.toString()}n`;
    }

    if (typeof input === 'function') {
      return '[Function]';
    }

    if (typeof input !== 'object') {
      // Primitive types: string, number, boolean, symbol
      return JSON.stringify(input);
    }

    const seen = new WeakSet<object>();

    const normalize = (value: unknown): unknown => {
      if (value === null || value === undefined) return value;
      if (typeof value === 'bigint') return `${value.toString()}n`;
      if (typeof value === 'function') return '[Function]';
      if (typeof value !== 'object') return value;

      // Buffer / Uint8Array
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
        return { __type: 'Buffer', base64: value.toString('base64') };
      }
      if (value instanceof Uint8Array) {
        return { __type: 'Uint8Array', base64: Buffer.from(value).toString('base64') };
      }
      if (value instanceof Date) {
        return { __type: 'Date', iso: value.toISOString() };
      }

      const obj = value as object;
      if (seen.has(obj)) return '[Circular]';
      seen.add(obj);

      if (Array.isArray(value)) {
        return value.map((item) => normalize(item));
      }

      const record = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = normalize(record[key]);
      }
      return sorted;
    };

    const normalized = normalize(input);
    const json = JSON.stringify(normalized);
    return json ?? String(input);
  }

  /**
   * Gets calls within the duplicate detection window
   */
  private getRecentWindowCalls(): TrackedCall[] {
    const cutoff = Date.now() - this.config.duplicateWindowMs;
    return this.recentCalls.filter((call) => call.timestamp >= cutoff);
  }

  /**
   * Checks if a tool call is a duplicate of recent calls
   *
   * @param toolName - Name of the tool being called
   * @param input - Input parameters for the tool
   * @returns Check result with duplicate info and optional warning
   */
  checkDuplicate(toolName: string, input: unknown): DuplicateCheckResult {
    const inputHash = this.hashInput(input);
    const recentCalls = this.getRecentWindowCalls();

    // Find matching calls
    const matchingCalls = recentCalls.filter(
      (call) => call.toolName === toolName && call.inputHash === inputHash
    );

    if (matchingCalls.length === 0) {
      return {
        isDuplicate: false,
        count: 0,
        failureCount: 0,
        shouldBlock: false,
      };
    }

    // Track duplicate detection
    this._duplicateCalls++;

    const failureCount = matchingCalls.filter((call) => !call.success).length;
    const lastCall = matchingCalls[matchingCalls.length - 1];

    // Generate warning message
    let warning: string | undefined;
    if (failureCount > 0) {
      warning = `⚠️ WARNING: You have already called '${toolName}' with the same parameters ${matchingCalls.length} time(s), and it failed ${failureCount} time(s). `;
      if (lastCall?.errorMessage) {
        warning += `Last error: "${lastCall.errorMessage}". `;
      }
      warning += 'Please try a different approach.';
    } else if (matchingCalls.length >= 2) {
      warning = `ℹ️ NOTE: You have already called '${toolName}' with the same parameters ${matchingCalls.length} time(s). Consider if you need to call it again.`;
    }

    // Determine if we should block
    const shouldBlock =
      this.config.enableBlocking && failureCount >= this.config.blockAfterFailures;

    if (shouldBlock) {
      this._blockedCalls++;
      warning = `🚫 BLOCKED: '${toolName}' has failed ${failureCount} times with the same parameters. `;
      if (lastCall?.errorMessage) {
        warning += `Error: "${lastCall.errorMessage}". `;
      }
      warning +=
        'This call is being blocked to prevent further wasted turns. Please use different parameters or a different approach.';
    }

    return {
      isDuplicate: true,
      count: matchingCalls.length,
      failureCount,
      warning,
      shouldBlock,
    };
  }

  /**
   * Checks for potential doom-loop based on repeated identical calls.
   *
   * @param toolName - Name of the tool being called
   * @param input - Input parameters for the tool
   * @param threshold - Trigger threshold (default: 3)
   */
  checkDoomLoop(toolName: string, input: unknown, threshold = 3): DoomLoopCheckResult {
    const inputHash = this.hashInput(input);
    const recentCalls = this.getRecentWindowCalls();
    const matchingCalls = recentCalls.filter(
      (call) => call.toolName === toolName && call.inputHash === inputHash
    );

    const count = matchingCalls.length + 1; // include current call
    return {
      count,
      isLoop: count >= threshold,
    };
  }

  /**
   * Records a completed tool call
   *
   * @param toolName - Name of the tool that was called
   * @param input - Input parameters used
   * @param success - Whether the call succeeded
   * @param errorMessage - Error message if the call failed
   */
  record(toolName: string, input: unknown, success: boolean, errorMessage?: string): void {
    const call: TrackedCall = {
      toolName,
      inputHash: this.hashInput(input),
      input,
      timestamp: Date.now(),
      success,
      errorMessage,
    };

    this.recentCalls.push(call);

    // Trim history if needed
    while (this.recentCalls.length > this.config.maxHistory) {
      this.recentCalls.shift();
    }
  }

  /**
   * Gets detected failure patterns for context injection
   *
   * @returns Array of failure patterns with counts
   */
  getFailurePatterns(): FailurePattern[] {
    const patterns = new Map<string, FailurePattern>();
    const recentCalls = this.getRecentWindowCalls();

    for (const call of recentCalls) {
      if (!call.success) {
        const key = `${call.toolName}:${call.inputHash}`;
        const existing = patterns.get(key);

        if (existing) {
          existing.count++;
        } else {
          // Try to extract a meaningful pattern from the input
          let pattern = call.toolName;
          if (typeof call.input === 'object' && call.input !== null) {
            const inputObj = call.input as Record<string, unknown>;
            if ('path' in inputObj) {
              pattern = `${call.toolName} on "${inputObj.path}"`;
            } else if ('query' in inputObj) {
              pattern = `${call.toolName} with query "${inputObj.query}"`;
            } else if ('command' in inputObj) {
              pattern = `${call.toolName} running "${inputObj.command}"`;
            }
          }

          patterns.set(key, {
            pattern,
            count: 1,
            toolName: call.toolName,
            sampleError: call.errorMessage,
          });
        }
      }
    }

    // Return patterns with count > 1, sorted by count descending
    return Array.from(patterns.values())
      .filter((p) => p.count > 1)
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Generates a warning summary for injection into the agent's context
   *
   * @returns Warning text or null if no patterns detected
   */
  generateContextWarning(): string | null {
    const patterns = this.getFailurePatterns();

    if (patterns.length === 0) {
      return null;
    }

    const lines = ['⚠️ KNOWN ISSUES (avoid repeating these failures):'];

    for (const pattern of patterns.slice(0, 5)) {
      // Top 5 patterns
      let line = `  - ${pattern.pattern} failed ${pattern.count} times`;
      if (pattern.sampleError) {
        // Truncate long error messages
        const error =
          pattern.sampleError.length > 100
            ? pattern.sampleError.substring(0, 100) + '...'
            : pattern.sampleError;
        line += `: "${error}"`;
      }
      lines.push(line);
    }

    return lines.join('\n');
  }

  /**
   * Gets tracking metrics for observability
   */
  getMetrics(): TrackerMetrics {
    const totalCalls = this.recentCalls.length;
    const failedCalls = this.recentCalls.filter((c) => !c.success).length;
    
    return {
      totalCalls,
      blockedCalls: this._blockedCalls,
      duplicateCalls: this._duplicateCalls,
      duplicateRate: totalCalls > 0 ? this._duplicateCalls / totalCalls : 0,
      failureRate: totalCalls > 0 ? failedCalls / totalCalls : 0,
    };
  }

  /**
   * Clears all tracked calls and resets metrics
   */
  clear(): void {
    this.recentCalls.length = 0;
    this._blockedCalls = 0;
    this._duplicateCalls = 0;
  }

  /**
   * Gets the number of tracked calls
   */
  get size(): number {
    return this.recentCalls.length;
  }

  /**
   * Gets all tracked calls (for debugging)
   */
  getCalls(): readonly TrackedCall[] {
    return this.recentCalls;
  }
}

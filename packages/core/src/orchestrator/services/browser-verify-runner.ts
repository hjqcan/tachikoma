/**
 * Browser verification runner
 *
 * Wraps the browser_verify tool for orchestrator services usage.
 */

import type { ExecutionContext } from '../../types';
import { browserVerifyTool } from '../../tools/core/browser-verify';
import { globalToolExecutor } from '../../tools/tool-executor';

export interface BrowserVerifyRunnerInput {
  workDir: string;
  url: string;
  requiredSelectors?: string[];
  screenshotPath?: string;
  checkConsoleErrors?: boolean;
  timeout?: number;
  headless?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  trackNetwork?: boolean;
  taskId?: string;
  agentId?: string;
  traceId?: string;
}

export interface BrowserVerifyRunnerResult {
  passed: boolean;
  consoleErrors: string[];
  missingSelectors: string[];
  screenshotPath?: string;
  title?: string;
  url?: string;
  visibleText?: string;
  fetchSummary?: {
    total: number;
    success: number;
    failed: number;
    failures?: Array<{
      url: string;
      status?: number;
      method?: string;
      error?: string;
    }>;
  };
  error?: string;
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

function buildContext(input: BrowserVerifyRunnerInput): ExecutionContext {
  return {
    taskId: input.taskId ?? 'browser-verify',
    agentId: input.agentId ?? 'orchestrator',
    traceId: input.traceId ?? `trace-${Date.now()}`,
    workDir: input.workDir,
    env: buildEnv(),
    sandboxId: 'orchestrator',
  };
}

export async function runBrowserVerify(
  input: BrowserVerifyRunnerInput
): Promise<BrowserVerifyRunnerResult> {
  const context = buildContext(input);

  const toolInput = {
    url: input.url,
    screenshotPath: input.screenshotPath,
    waitForSelectors: input.requiredSelectors,
    checkConsoleErrors: input.checkConsoleErrors ?? true,
    timeout: input.timeout,
    headless: input.headless ?? true,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    ...(input.trackNetwork !== undefined ? { trackNetwork: input.trackNetwork } : {}),
  };

  const result = await globalToolExecutor.execute(browserVerifyTool, toolInput, context, {
    throwOnError: false,
  });

  const data = (result.data ?? {}) as {
    success?: boolean;
    title?: string;
    url?: string;
    screenshotPath?: string;
    consoleErrors?: string[];
    missingSelectors?: string[];
    visibleText?: string;
    fetchSummary?: {
      total: number;
      success: number;
      failed: number;
      failures?: Array<{
        url: string;
        status?: number;
        method?: string;
        error?: string;
      }>;
    };
    error?: string;
  };

  const consoleErrors = Array.isArray(data.consoleErrors) ? data.consoleErrors : [];
  const missingSelectors = Array.isArray(data.missingSelectors) ? data.missingSelectors : [];

  const resultData: BrowserVerifyRunnerResult = {
    passed: Boolean(result.success && data.success),
    consoleErrors,
    missingSelectors,
  };

  if (typeof data.screenshotPath === 'string') {
    resultData.screenshotPath = data.screenshotPath;
  }
  if (typeof data.title === 'string') {
    resultData.title = data.title;
  }
  if (typeof data.url === 'string') {
    resultData.url = data.url;
  }
  if (typeof data.visibleText === 'string') {
    resultData.visibleText = data.visibleText;
  }
  if (data.fetchSummary !== undefined) {
    resultData.fetchSummary = data.fetchSummary;
  }
  
  const errorValue = result.success ? data.error : result.error ?? data.error;
  if (errorValue !== undefined) {
    resultData.error = errorValue;
  }

  return resultData;
}

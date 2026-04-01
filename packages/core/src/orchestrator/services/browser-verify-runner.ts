/**
 * Browser verification service
 *
 * Orchestrator-facing Playwright verification. This is an internal service,
 * not an LLM-facing tool.
 */

import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

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

type PlaywrightModule = typeof import('playwright');

async function getPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

async function ensureWorkDir(workDir: string): Promise<void> {
  const info = await stat(workDir).catch(() => null);
  if (!info) {
    throw new Error(`workDir does not exist: ${workDir}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`workDir is not a directory: ${workDir}`);
  }
}

function resolveScreenshotPath(workDir: string, screenshotPath: string): string {
  const fullPath = isAbsolute(screenshotPath)
    ? screenshotPath
    : resolve(workDir, screenshotPath);
  const rel = relative(resolve(workDir), fullPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Screenshot path escapes workDir: ${screenshotPath}`);
  }
  return fullPath;
}

export async function runBrowserVerify(
  input: BrowserVerifyRunnerInput
): Promise<BrowserVerifyRunnerResult> {
  const {
    workDir,
    url,
    requiredSelectors = [],
    screenshotPath,
    checkConsoleErrors = true,
    timeout = 30000,
    headless = true,
    viewportWidth = 1280,
    viewportHeight = 720,
    trackNetwork = true,
  } = input;

  await ensureWorkDir(workDir);

  const playwright = await getPlaywright();
  if (!playwright) {
    return {
      passed: false,
      consoleErrors: [],
      missingSelectors: [],
      error: 'Playwright is not installed. Run: bun add playwright && bunx playwright install chromium',
    };
  }

  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | null = null;

  try {
    browser = await playwright.chromium.launch({ headless });
    const browserContext = await browser.newContext({
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
      },
    });
    const page = await browserContext.newPage();

    const consoleErrors: string[] = [];
    if (checkConsoleErrors) {
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });
      page.on('pageerror', (error) => {
        consoleErrors.push(`Page Error: ${error.message}`);
      });
    }

    const fetchResponses: Array<{ url: string; status: number; method: string }> = [];
    const fetchFailures: Array<{ url: string; method: string; error?: string }> = [];
    if (trackNetwork) {
      page.on('response', (response) => {
        const request = response.request();
        const resourceType = request.resourceType();
        if (resourceType !== 'xhr' && resourceType !== 'fetch') return;
        fetchResponses.push({
          url: response.url(),
          status: response.status(),
          method: request.method(),
        });
      });
      page.on('requestfailed', (request) => {
        const resourceType = request.resourceType();
        if (resourceType !== 'xhr' && resourceType !== 'fetch') return;
        const errorText = request.failure()?.errorText;
        fetchFailures.push({
          url: request.url(),
          method: request.method(),
          ...(errorText !== undefined ? { error: errorText } : {}),
        });
      });
    }

    try {
      await page.goto(url, {
        timeout,
        waitUntil: 'domcontentloaded',
      });
    } catch (error) {
      return {
        passed: false,
        consoleErrors,
        missingSelectors: [],
        error: `Navigation failed: ${(error as Error).message}`,
      };
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch {
      // Ignore networkidle timeout; DOM may already be sufficient.
    }

    const foundSelectors: string[] = [];
    const missingSelectors: string[] = [];
    const selectorTimeout = Math.min(10000, timeout);
    for (const selector of requiredSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: selectorTimeout });
        foundSelectors.push(selector);
      } catch {
        missingSelectors.push(selector);
      }
    }

    const title = await page.title();
    const finalUrl = page.url();

    let visibleText: string | undefined;
    try {
      visibleText = (await page.evaluate(
        'document.body?.innerText?.slice(0, 500) || ""'
      )) as string;
    } catch {
      // Ignore visible text extraction failures.
    }

    let savedScreenshotPath: string | undefined;
    if (screenshotPath) {
      const fullPath = resolveScreenshotPath(workDir, screenshotPath);
      await mkdir(dirname(fullPath), { recursive: true });
      await page.screenshot({
        path: fullPath,
        fullPage: false,
      });
      savedScreenshotPath = screenshotPath;
    }

    await browser.close();
    browser = null;

    const criticalErrorPatterns = [
      'SyntaxError',
      'TypeError',
      'ReferenceError',
      'Uncaught',
      'Unhandled',
      'Objects are not valid as a React child',
      'Error boundary',
      'Error: Rendered fewer hooks',
      'Error: Too many re-renders',
      'ChunkLoadError',
      'Loading chunk',
      'Failed to fetch dynamically imported module',
      'Cannot find module',
      'Module not found',
      'Failed to resolve module',
    ];

    const hasPageErrors = consoleErrors.some((error) =>
      criticalErrorPatterns.some((pattern) => error.includes(pattern))
    );
    const isBlankPage = !visibleText || visibleText.trim().length === 0;
    if (isBlankPage && !hasPageErrors) {
      consoleErrors.push(
        'Warning: Page appears blank (no visible text). Check if app mounting completed correctly.'
      );
    }

    let fetchSummary: BrowserVerifyRunnerResult['fetchSummary'];
    if (trackNetwork) {
      const isSuccessStatus = (status: number) => status >= 200 && status < 400;
      const successfulResponses = fetchResponses.filter((res) => isSuccessStatus(res.status));
      const failedResponses = fetchResponses.filter((res) => !isSuccessStatus(res.status));
      const failureDetails = [
        ...failedResponses.map((res) => ({
          url: res.url,
          status: res.status,
          method: res.method,
        })),
        ...fetchFailures.map((failure) => ({
          url: failure.url,
          method: failure.method,
          ...(failure.error !== undefined ? { error: failure.error } : {}),
        })),
      ];
      fetchSummary = {
        total: fetchResponses.length + fetchFailures.length,
        success: successfulResponses.length,
        failed: failedResponses.length + fetchFailures.length,
        ...(failureDetails.length > 0
          ? { failures: failureDetails.slice(0, 10) }
          : {}),
      };
    }

    const passed = !hasPageErrors && missingSelectors.length === 0 && !isBlankPage;
    return {
      passed,
      consoleErrors,
      missingSelectors,
      ...(savedScreenshotPath ? { screenshotPath: savedScreenshotPath } : {}),
      ...(title ? { title } : {}),
      ...(finalUrl ? { url: finalUrl } : {}),
      ...(visibleText ? { visibleText } : {}),
      ...(fetchSummary ? { fetchSummary } : {}),
    };
  } catch (error) {
    return {
      passed: false,
      consoleErrors: [],
      missingSelectors: [],
      error: (error as Error).message || 'Unknown error during browser verification',
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

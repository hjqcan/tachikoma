/**
 * browser_verify tool
 *
 * Uses Playwright to verify a page load: screenshot, console error checks, and element checks.
 */

import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { ensureWorkDir, validatePath } from './utils';

// =============================================================================
// 类型定义
// =============================================================================

interface BrowserVerifyInput {
  /** 要访问的 URL */
  url: string;
  /** 截图保存路径（相对于 workDir），不填则不截图 */
  screenshotPath?: string;
  /** 等待指定 CSS 选择器出现 */
  waitForSelector?: string;
  /** 是否收集控制台错误 */
  checkConsoleErrors?: boolean;
  /** 页面加载超时 (ms)，默认 30000 */
  timeout?: number;
  /** 是否无头模式，默认 true */
  headless?: boolean;
  /** 视口宽度，默认 1280 */
  viewportWidth?: number;
  /** 视口高度，默认 720 */
  viewportHeight?: number;
}

interface BrowserVerifyOutput {
  /** 页面是否成功加载 */
  success: boolean;
  /** 页面标题 */
  title?: string | undefined;
  /** 最终 URL（可能有重定向） */
  url?: string | undefined;
  /** 截图保存路径 */
  screenshotPath?: string | undefined;
  /** 控制台错误列表 */
  consoleErrors?: string[] | undefined;
  /** waitForSelector 是否找到元素 */
  elementFound?: boolean | undefined;
  /** 页面可见文本（前 500 字符） */
  visibleText?: string | undefined;
  /** 错误信息 */
  error?: string | undefined;
}

// =============================================================================
// Playwright 动态导入
// =============================================================================

/**
 * 动态导入 Playwright（避免未安装时报错）
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PlaywrightModule = typeof import('playwright');

async function getPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

// =============================================================================
// 浏览器验证实现
// =============================================================================

async function verifyPage(
  input: BrowserVerifyInput,
  context: ExecutionContext
): Promise<ToolResult<BrowserVerifyOutput>> {
  const {
    url,
    screenshotPath,
    waitForSelector,
    checkConsoleErrors = true,
    timeout = 30000,
    headless = true,
    viewportWidth = 1280,
    viewportHeight = 720,
  } = input;

  // 动态导入 Playwright
  const playwright = await getPlaywright();
  if (!playwright) {
    return {
      success: false,
      error: 'Playwright is not installed. Run: bun add playwright && bunx playwright install chromium',
    };
  }

  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | null = null;

  try {
    // 启动浏览器
    browser = await playwright.chromium.launch({
      headless,
    });

    const browserContext = await browser.newContext({
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
      },
    });

    const page = await browserContext.newPage();

    // 收集控制台错误
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

    // 导航到页面
    try {
      await page.goto(url, {
        timeout,
        waitUntil: 'domcontentloaded',
      });
    } catch (navError) {
      const err = navError as Error;
      return {
        success: false,
        data: {
          success: false,
          url,
          consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
          error: `Navigation failed: ${err.message}`,
        },
        error: `Navigation failed: ${err.message}`,
      };
    }

    // 等待网络空闲（最多 5 秒）
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch {
      // 忽略超时，继续执行
    }

    // 等待指定元素
    let elementFound: boolean | undefined;
    if (waitForSelector) {
      try {
        await page.waitForSelector(waitForSelector, { timeout: 10000 });
        elementFound = true;
      } catch {
        elementFound = false;
      }
    }

    // 获取页面信息
    const title = await page.title();
    const finalUrl = page.url();

    // 获取可见文本
    let visibleText: string | undefined;
    try {
      // Note: document is available in page.evaluate() browser context
      visibleText = (await page.evaluate('document.body?.innerText?.slice(0, 500) || ""')) as string;
    } catch {
      // 忽略错误
    }

    // 截图
    let savedScreenshotPath: string | undefined;
    if (screenshotPath) {
      const fullPath = validatePath(screenshotPath, context.workDir);
      await mkdir(dirname(fullPath), { recursive: true });

      await page.screenshot({
        path: fullPath,
        fullPage: false,
      });
      savedScreenshotPath = screenshotPath;
    }

    // 关闭浏览器
    await browser.close();
    browser = null;

    // 判断成功：页面加载成功且没有严重错误
    const hasPageErrors = consoleErrors.some(
      (e) =>
        e.includes('SyntaxError') ||
        e.includes('TypeError') ||
        e.includes('ReferenceError') ||
        e.includes('Uncaught')
    );

    return {
      success: !hasPageErrors,
      data: {
        success: !hasPageErrors,
        title,
        url: finalUrl,
        screenshotPath: savedScreenshotPath,
        consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
        elementFound,
        visibleText,
      },
    };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      error: err.message || 'Unknown error during browser verification',
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

// =============================================================================
// 工具定义
// =============================================================================

export const browserVerifyTool: Tool = {
  name: 'browser_verify',
  title: 'Browser Page Verification',
  description: `Verify a web page using Playwright.

Features:
- Navigate to a URL
- Optional screenshot
- Collect console errors (helps detect blank pages / JS errors)
- Wait for a selector (optional)
- Extract title and a short visible-text preview

Note: Playwright must be installed:
\`\`\`
bun add playwright
bunx playwright install chromium
\`\`\``,

  isCommandBased: false,

  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to visit (e.g. http://localhost:3000)',
      },
      screenshotPath: {
        type: 'string',
        description: 'Screenshot path (relative to workDir), e.g. screenshots/verify.png',
      },
      waitForSelector: {
        type: 'string',
        description: 'CSS selector to wait for',
      },
      checkConsoleErrors: {
        type: 'boolean',
        description: 'Collect console errors (default true)',
      },
      timeout: {
        type: 'number',
        description: 'Page load timeout in ms (default 30000)',
      },
      headless: {
        type: 'boolean',
        description: 'Run headless (default true)',
      },
      viewportWidth: {
        type: 'number',
        description: 'Viewport width (default 1280)',
      },
      viewportHeight: {
        type: 'number',
        description: 'Viewport height (default 720)',
      },
    },
    required: ['url'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          title: { type: 'string' },
          url: { type: 'string' },
          screenshotPath: { type: 'string' },
          consoleErrors: {
            type: 'array',
            items: { type: 'string' },
          },
          elementFound: { type: 'boolean' },
          visibleText: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.6,
    idempotent: true,
    estimatedDuration: 30000,
  },

  // 权限对齐到现有体系
  permissions: ['process:spawn', 'network:read', 'fs:write'],
  layer: ToolLayer.Sandbox,
  category: ToolCategory.Browser,

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<BrowserVerifyOutput>> {
    const typedInput = input as BrowserVerifyInput;

    // 确保工作目录存在
    const workDirCheck = await ensureWorkDir(context.workDir);
    if (!workDirCheck.valid) {
      return {
        success: false,
        error: workDirCheck.error ?? 'Unknown workDir error',
      };
    }

    return verifyPage(typedInput, context);
  },
};

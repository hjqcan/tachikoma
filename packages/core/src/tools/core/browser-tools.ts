/**
 * Browser Tools - 浏览器自动化工具集
 *
 * 使用 Playwright 提供浏览器导航、点击、输入、截图等功能
 *
 * @layer Atomic
 * @category Browser
 * @permissions NetworkRead, FileSystemWrite (截图)
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';

// Playwright 类型（延迟导入以支持可选依赖）
type Browser = import('playwright').Browser;
type Page = import('playwright').Page;
type BrowserContext = import('playwright').BrowserContext;

// 全局浏览器实例（复用以提高性能）
let globalBrowser: Browser | null = null;
let globalContext: BrowserContext | null = null;
let globalPage: Page | null = null;

/**
 * 获取或创建浏览器实例
 */
async function getOrCreateBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  // 延迟导入 Playwright
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error(
      'Playwright is not installed. Run: bun add playwright && bunx playwright install chromium'
    );
  }

  if (!globalBrowser || !globalBrowser.isConnected()) {
    globalBrowser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    globalContext = await globalBrowser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    globalPage = await globalContext.newPage();
  }

  return {
    browser: globalBrowser,
    context: globalContext!,
    page: globalPage!,
  };
}

/**
 * 关闭浏览器（可选调用）
 */
export async function closeBrowser(): Promise<void> {
  if (globalBrowser) {
    await globalBrowser.close();
    globalBrowser = null;
    globalContext = null;
    globalPage = null;
  }
}

// ============================================================================
// browser_navigate - 页面导航
// ============================================================================

interface NavigateOutput {
  url: string;
  title: string;
  status: number;
  loadTime: number;
}

export const browserNavigateTool: Tool = {
  name: 'browser_navigate',
  title: 'Browser Navigate',
  description: '导航到指定URL。使用 Playwright 控制 Chromium 浏览器。',

  layer: ToolLayer.Atomic,
  category: ToolCategory.Browser,
  permissions: [ToolPermission.NetworkRead],

  annotations: {
    idempotent: true,
    cacheable: false,
    estimatedDuration: 5000,
  },

  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标URL' },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        description: '等待条件（默认load）',
        default: 'load',
      },
      timeout: {
        type: 'number',
        description: '超时时间（毫秒，默认30000）',
        default: 30000,
      },
    },
    required: ['url'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'number' },
      loadTime: { type: 'number' },
    },
  },

  async execute(_input: unknown, _context: ExecutionContext): Promise<ToolResult<NavigateOutput>> {
    if (!_input || typeof _input !== 'object') {
      return { success: false, error: 'Input must be an object' };
    }
    const obj = _input as Record<string, unknown>;
    
    if (!obj.url || typeof obj.url !== 'string') {
      return { success: false, error: 'url is required and must be a string' };
    }
    
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(obj.url);
    } catch {
      return { success: false, error: `Invalid URL: ${obj.url}` };
    }

    const url = parsedUrl.toString();
    const waitUntil = (obj.waitUntil as 'load' | 'domcontentloaded' | 'networkidle') || 'load';
    const timeout = (obj.timeout as number) || 30000;
    const startTime = Date.now();

    try {
      const { page } = await getOrCreateBrowser();

      const response = await page.goto(url, {
        waitUntil,
        timeout,
      });

      const title = await page.title();
      const loadTime = Date.now() - startTime;

      return {
        success: true,
        data: {
          url: page.url(),
          title,
          status: response?.status() ?? 0,
          loadTime,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: `Navigation failed: ${err.message}`,
      };
    }
  },
};

// ============================================================================
// browser_click - 元素点击
// ============================================================================

interface ClickOutput {
  clicked: boolean;
  selector: string;
  elementText?: string;
}

export const browserClickTool: Tool = {
  name: 'browser_click',
  title: 'Browser Click',
  description: '点击页面元素。支持CSS选择器或XPath。',

  layer: ToolLayer.Atomic,
  category: ToolCategory.Browser,
  permissions: [ToolPermission.NetworkRead],

  annotations: {
    idempotent: false,
    cacheable: false,
    estimatedDuration: 1000,
  },

  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS选择器或XPath' },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: '鼠标按钮（默认left）',
        default: 'left',
      },
      clickCount: {
        type: 'number',
        description: '点击次数（默认1）',
        default: 1,
      },
      timeout: {
        type: 'number',
        description: '等待元素超时（毫秒，默认5000）',
        default: 5000,
      },
    },
    required: ['selector'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      clicked: { type: 'boolean' },
      selector: { type: 'string' },
      elementText: { type: 'string' },
    },
  },

  async execute(_input: unknown, _context: ExecutionContext): Promise<ToolResult<ClickOutput>> {
    if (!_input || typeof _input !== 'object') {
      return { success: false, error: 'Input must be an object' };
    }
    const obj = _input as Record<string, unknown>;
    
    if (!obj.selector || typeof obj.selector !== 'string') {
      return { success: false, error: 'selector is required and must be a string' };
    }

    const selector = obj.selector;
    const button = (obj.button as 'left' | 'right' | 'middle') || 'left';
    const clickCount = (obj.clickCount as number) || 1;
    const timeout = (obj.timeout as number) || 5000;

    try {
      const { page } = await getOrCreateBrowser();

      // 等待元素可见
      await page.waitForSelector(selector, { timeout, state: 'visible' });

      // 获取元素文本
      const elementText = await page.$eval(selector, (el) => el.textContent?.trim() ?? '');

      // 点击
      await page.click(selector, { button, clickCount });

      return {
        success: true,
        data: {
          clicked: true,
          selector,
          elementText: elementText.substring(0, 100), // 截断过长文本
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: `Click failed on "${selector}": ${err.message}`,
      };
    }
  },
};

// ============================================================================
// browser_input - 文本输入
// ============================================================================

interface InputOutput {
  success: boolean;
  selector: string;
  textEntered: string;
}

export const browserInputTool: Tool = {
  name: 'browser_input',
  title: 'Browser Input',
  description: '在页面输入框中输入文本。支持清空现有内容和模拟打字延迟。',

  layer: ToolLayer.Atomic,
  category: ToolCategory.Browser,
  permissions: [ToolPermission.NetworkRead],

  annotations: {
    idempotent: false,
    cacheable: false,
    estimatedDuration: 2000,
  },

  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: '输入框的CSS选择器' },
      text: { type: 'string', description: '要输入的文本' },
      clearFirst: {
        type: 'boolean',
        description: '是否先清空输入框（默认true）',
        default: true,
      },
      delay: {
        type: 'number',
        description: '字符间延迟（毫秒，默认50）',
        default: 50,
      },
      timeout: {
        type: 'number',
        description: '等待元素超时（毫秒，默认5000）',
        default: 5000,
      },
    },
    required: ['selector', 'text'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      selector: { type: 'string' },
      textEntered: { type: 'string' },
    },
  },

  async execute(_input: unknown, _context: ExecutionContext): Promise<ToolResult<InputOutput>> {
    if (!_input || typeof _input !== 'object') {
      return { success: false, error: 'Input must be an object' };
    }
    const obj = _input as Record<string, unknown>;
    
    if (!obj.selector || typeof obj.selector !== 'string') {
      return { success: false, error: 'selector is required and must be a string' };
    }
    if (!obj.text || typeof obj.text !== 'string') {
      return { success: false, error: 'text is required and must be a string' };
    }

    const selector = obj.selector;
    const text = obj.text;
    const clearFirst = obj.clearFirst !== false; // 默认true
    const delay = (obj.delay as number) || 50;
    const timeout = (obj.timeout as number) || 5000;

    try {
      const { page } = await getOrCreateBrowser();

      // 等待元素
      await page.waitForSelector(selector, { timeout, state: 'visible' });

      // 清空（如果需要）
      if (clearFirst) {
        await page.click(selector, { clickCount: 3 }); // 选中全部
        await page.keyboard.press('Backspace');
      }

      // 输入文本
      await page.type(selector, text, { delay });

      return {
        success: true,
        data: {
          success: true,
          selector,
          textEntered: text,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: `Input failed on "${selector}": ${err.message}`,
      };
    }
  },
};

// ============================================================================
// browser_screenshot - 页面截图
// ============================================================================

interface ScreenshotOutput {
  path: string;
  width: number;
  height: number;
  size: number;
  base64?: string | undefined;
}

export const browserScreenshotTool: Tool = {
  name: 'browser_screenshot',
  title: 'Browser Screenshot',
  description: '对当前页面或指定元素进行截图。可保存到文件或返回base64。',

  layer: ToolLayer.Atomic,
  category: ToolCategory.Browser,
  permissions: [ToolPermission.NetworkRead, ToolPermission.FileSystemWrite],

  annotations: {
    idempotent: true,
    cacheable: false,
    estimatedDuration: 2000,
  },

  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '保存路径（可选，不指定则返回base64）' },
      fullPage: {
        type: 'boolean',
        description: '是否截取整页（默认false）',
        default: false,
      },
      selector: { type: 'string', description: '仅截取指定元素' },
      quality: {
        type: 'number',
        description: 'JPEG质量（0-100，默认80）',
        default: 80,
      },
      type: {
        type: 'string',
        enum: ['png', 'jpeg'],
        description: '图片格式（默认png）',
        default: 'png',
      },
    },
    required: [],
  },

  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      width: { type: 'number' },
      height: { type: 'number' },
      size: { type: 'number' },
      base64: { type: 'string' },
    },
  },

  async execute(_input: unknown, context: ExecutionContext): Promise<ToolResult<ScreenshotOutput>> {
    const obj = (_input as Record<string, unknown>) || {};

    const inputPath = obj.path as string | undefined;
    const fullPage = (obj.fullPage as boolean) || false;
    const selector = obj.selector as string | undefined;
    const quality = (obj.quality as number) || 80;
    const type = (obj.type as 'png' | 'jpeg') || 'png';

    try {
      const { page } = await getOrCreateBrowser();

      // 确定保存路径
      const screenshotPath = inputPath
        ? inputPath
        : join(context.workDir, '.tachikoma', 'screenshots', `screenshot-${Date.now()}.${type}`);

      // 确保目录存在
      await mkdir(dirname(screenshotPath), { recursive: true });

      let buffer: Buffer;

      if (selector) {
        // 元素截图
        const element = await page.$(selector);
        if (!element) {
          return { success: false, error: `Element not found: ${selector}` };
        }
        buffer = await element.screenshot({
          path: screenshotPath,
          type,
          ...(type === 'jpeg' ? { quality } : {}),
        });
      } else {
        // 页面截图
        buffer = await page.screenshot({
          path: screenshotPath,
          fullPage,
          type,
          ...(type === 'jpeg' ? { quality } : {}),
        });
      }

      // 获取视口大小
      const viewport = page.viewportSize() ?? { width: 1280, height: 720 };

      // 如果没有指定路径，也写入文件
      if (!inputPath) {
        await writeFile(screenshotPath, buffer);
      }

      return {
        success: true,
        data: {
          path: screenshotPath,
          width: viewport.width,
          height: viewport.height,
          size: buffer.length,
          base64: inputPath ? undefined : buffer.toString('base64'),
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: `Screenshot failed: ${err.message}`,
      };
    }
  },
};

// ============================================================================
// 导出
// ============================================================================

export const browserTools = {
  browserNavigateTool,
  browserClickTool,
  browserInputTool,
  browserScreenshotTool,
  closeBrowser,
};

export default browserTools;

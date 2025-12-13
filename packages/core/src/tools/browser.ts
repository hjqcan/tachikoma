/**
 * Browser tools entrypoint (optional dependency: Playwright).
 *
 * 该模块会引入 Playwright（以及其可选依赖），请仅在需要浏览器自动化时显式导入：
 * - `import { browserToolsArray } from '@tachikoma/core/tools/browser'`
 */

import type { Tool } from '../types';
import {
  browserNavigateTool,
  browserClickTool,
  browserInputTool,
  browserScreenshotTool,
  browserTools,
} from './core/browser-tools';

export {
  browserNavigateTool,
  browserClickTool,
  browserInputTool,
  browserScreenshotTool,
  browserTools,
};

export const browserToolsArray: Tool[] = [
  browserNavigateTool,
  browserClickTool,
  browserInputTool,
  browserScreenshotTool,
];


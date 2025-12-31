/**
 * SmokeGateService
 * 
 * Performs smoke tests to verify application is runnable:
 * 1. Start dev server (FE + BE)
 * 2. Wait for server to become available
 * 3. HTTP health check
 * 4. Browser verification (console errors, key selectors)
 * 5. Capture screenshot
 */

import { DevServerManager, type DevServerHandle, type DevServerConfig } from './dev-server-manager';
import { ProjectDetector, type ProjectConfig } from './project-detector';
import { runBrowserVerify } from './browser-verify-runner';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// =============================================================================
// Types
// =============================================================================

export interface SmokeTestConfig {
  /** Working directory */
  workDir: string;
  
  /** Port to use (will auto-detect from project if not provided) */
  port?: number;
  
  /** URLs to check (if not provided, will use dev server URL) */
  urls?: string[];
  
  /** Selectors that must exist on the page */
  requiredSelectors?: string[];
  
  /** Max time to wait for server to start (ms) */
  serverStartTimeout?: number;
  
  /** Max time for each page check (ms) */
  pageTimeout?: number;
  
  /** Whether to capture screenshots */
  captureScreenshot?: boolean;
  
  /** Screenshot output path */
  screenshotPath?: string;
  
  /** Whether to check for console errors */
  checkConsoleErrors?: boolean;

  /** Whether browser verification is required (default true) */
  requireBrowser?: boolean;

  /** Require at least one successful fetch/xhr during page load (auto-detected if undefined) */
  requireDataFetch?: boolean;

  /** Minimum successful fetch/xhr count when requireDataFetch is true (default 1) */
  minSuccessfulFetches?: number;
}

export interface SmokeTestResult {
  /** Overall pass/fail */
  passed: boolean;
  
  /** Server start result */
  serverStarted: boolean;
  
  /** Server URL */
  serverUrl?: string;
  
  /** HTTP health check result */
  httpCheckPassed: boolean;
  
  /** Browser check result */
  browserCheckPassed: boolean;

  /** Data fetch check result */
  dataFetchPassed: boolean;
  
  /** Console errors found */
  consoleErrors: string[];
  
  /** Missing selectors */
  missingSelectors: string[];

  /** Fetch/xhr summary */
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
  
  /** Screenshot path (if captured) */
  screenshotPath?: string;
  
  /** Duration in ms */
  duration: number;
  
  /** Error message if failed */
  error?: string;
  
  /** Detailed summary */
  summary: string;
}

// =============================================================================
// SmokeGateService
// =============================================================================

export class SmokeGateService {
  private readonly devServerManager: DevServerManager;
  private readonly projectDetector: ProjectDetector;
  private activeServer: DevServerHandle | null = null;

  constructor() {
    this.devServerManager = new DevServerManager();
    this.projectDetector = new ProjectDetector();
  }

  /**
   * Run smoke test
   */
  async check(config: SmokeTestConfig): Promise<SmokeTestResult> {
    const startTime = Date.now();
    
    const result: SmokeTestResult = {
      passed: false,
      serverStarted: false,
      httpCheckPassed: false,
      browserCheckPassed: false,
      dataFetchPassed: true,
      consoleErrors: [],
      missingSelectors: [],
      duration: 0,
      summary: '',
    };

    try {
      // 1. Detect project config (allow fallback to nested frontend project)
      const { targetDir, projectConfig } = await this.resolveSmokeTarget(config.workDir);
      
      if (!projectConfig.devCommand) {
        result.summary = 'No dev command found in project';
        result.duration = Date.now() - startTime;
        return result;
      }

      // 1.5 Check entry file structure (Vite vs CRA)
      const entryCheck = this.checkEntryFile(targetDir, projectConfig);
      if (!entryCheck.valid) {
        result.summary = entryCheck.error ?? 'Entry file check failed';
        result.duration = Date.now() - startTime;
        return result;
      }

      // 2. Determine port
      const port = config.port ?? this.detectPort(projectConfig, targetDir);
      
      // 3. Start dev server
      console.info(`[SmokeGate] Starting dev server...`);
      const serverConfig: DevServerConfig = {
        command: projectConfig.devCommand,
        cwd: targetDir,
        port,
        startTimeout: config.serverStartTimeout ?? 60000,
      };

      this.activeServer = await this.devServerManager.start(serverConfig);
      result.serverStarted = true;
      result.serverUrl = this.activeServer.url;
      console.info(`[SmokeGate] Dev server started: ${this.activeServer.url}`);

      // 4. HTTP health check
      const urls = config.urls ?? [this.activeServer.url];
      result.httpCheckPassed = await this.checkHttpHealth(urls);
      
      if (!result.httpCheckPassed) {
        result.summary = 'HTTP health check failed';
        result.duration = Date.now() - startTime;
        return result;
      }
      console.info(`[SmokeGate] HTTP check passed`);

      // 5. Browser verification (if available)
      const screenshotPath = config.screenshotPath ?? 'smoke-test-screenshot.png';
      const browserResult = await this.checkBrowser({
        workDir: targetDir,
        url: this.activeServer.url,
        requiredSelectors: config.requiredSelectors ?? [],
        captureScreenshot: config.captureScreenshot ?? false,
        screenshotPath,
        checkConsoleErrors: config.checkConsoleErrors ?? true,
        timeout: config.pageTimeout ?? 30000,
        requireBrowser: config.requireBrowser ?? true,
      });

      result.browserCheckPassed = browserResult.passed;
      result.consoleErrors = browserResult.consoleErrors;
      result.missingSelectors = browserResult.missingSelectors;
      if (browserResult.fetchSummary) {
        result.fetchSummary = browserResult.fetchSummary;
      }
      if (browserResult.screenshotPath) {
        result.screenshotPath = browserResult.screenshotPath;
      }

      const shouldRequireDataFetch = config.requireDataFetch ?? this.shouldRequireDataFetch(config.workDir, targetDir, projectConfig);
      if (shouldRequireDataFetch) {
        const minSuccessful = config.minSuccessfulFetches ?? 1;
        const successCount = browserResult.fetchSummary?.success ?? 0;
        result.dataFetchPassed = successCount >= minSuccessful;
        if (!result.dataFetchPassed) {
          result.consoleErrors.push(
            `Data fetch check failed: expected >= ${minSuccessful} successful fetch/xhr, got ${successCount}.`
          );
        }
      }

      // 6. Determine overall result
      result.passed = result.httpCheckPassed && 
                      result.browserCheckPassed &&
                      result.dataFetchPassed &&
                      result.consoleErrors.length === 0;

      if (result.passed) {
        result.summary = 'Smoke test passed';
      } else if (!result.dataFetchPassed) {
        result.summary = 'Data fetch check failed';
      } else if (result.consoleErrors.length > 0) {
        result.summary = `Console errors: ${result.consoleErrors.slice(0, 3).join('; ')}`;
      } else if (result.missingSelectors.length > 0) {
        result.summary = `Missing selectors: ${result.missingSelectors.join(', ')}`;
      } else {
        result.summary = 'Browser check failed';
      }

    } catch (error) {
      result.error = (error as Error).message;
      result.summary = `Smoke test failed: ${result.error}`;
    } finally {
      // Clean up: stop server
      if (this.activeServer) {
        await this.activeServer.stop().catch(() => undefined);
        this.activeServer = null;
      }
      result.duration = Date.now() - startTime;
    }

    return result;
  }

  /**
   * Stop any running smoke test
   */
  async cleanup(): Promise<void> {
    await this.devServerManager.stopAll();
    this.activeServer = null;
  }

  /**
   * Check entry file structure (Vite vs CRA)
   * 
   * Vite requires index.html at project root
   * CRA requires index.html in public/ folder
   * 
   * This detects common misconfigurations that cause blank pages
   */
  private checkEntryFile(workDir: string, config: ProjectConfig): { valid: boolean; error?: string } {
    const viteEntry = join(workDir, 'index.html');
    const craEntry = join(workDir, 'public', 'index.html');
    const hasViteEntry = existsSync(viteEntry);
    const hasCraEntry = existsSync(craEntry);

    // Check if this is a Vite project
    const isViteProject = config.devCommand?.includes('vite') || 
                          config.testFramework === 'vitest' ||
                          existsSync(join(workDir, 'vite.config.ts')) ||
                          existsSync(join(workDir, 'vite.config.js'));

    // Check if this is a CRA project
    const isCraProject = config.devCommand?.includes('react-scripts');

    // Vite project checks
    if (isViteProject) {
      if (!hasViteEntry) {
        if (hasCraEntry) {
          return {
            valid: false,
            error: `Vite project detected but index.html is in public/ (CRA structure). ` +
                   `Move public/index.html to project root for Vite.`
          };
        }
        return {
          valid: false,
          error: `Vite project detected but no index.html found at project root. ` +
                 `Create index.html at ${workDir}`
        };
      }
    }

    // CRA project checks
    if (isCraProject) {
      if (!hasCraEntry) {
        if (hasViteEntry) {
          return {
            valid: false,
            error: `CRA project detected but index.html is at root (Vite structure). ` +
                   `Move index.html to public/ folder for CRA.`
          };
        }
        return {
          valid: false,
          error: `CRA project detected but no public/index.html found.`
        };
      }
    }

    // Neither Vite nor CRA - check if any entry exists
    if (!hasViteEntry && !hasCraEntry) {
      console.warn(`[SmokeGate] No index.html found at root or public/ - project may not be a frontend project`);
    }

    return { valid: true };
  }

  /**
   * Detect default port from project config
   * Priority: 1) --port in command, 2) vite.config port, 3) defaults
   */
  private detectPort(config: ProjectConfig, projectPath: string): number {
    // Check if dev command has an explicit port
    if (config.devCommand) {
      const portMatch = config.devCommand.match(/--port[= ](\d+)/);
      if (portMatch?.[1]) {
        return parseInt(portMatch[1], 10);
      }
    }

    // Try to read port from vite.config.ts/js (sync for simplicity, config is small)
    const vitePort = this.readViteConfigPort(projectPath);
    if (vitePort !== null) {
      return vitePort;
    }

    // Check if this is a Vite project (Vite defaults to 5173)
    if (config.devCommand) {
      const isViteProject = 
        config.devCommand.match(/\bvite\b/i) ||
        config.testFramework === 'vitest';
      if (isViteProject) {
        return 5173;
      }
    }

    // Default ports by test framework (vitest implies Vite)
    if (config.testFramework === 'vitest') {
      return 5173; // Vite default port
    }
    
    return 3000; // Generic default (CRA, Next.js, etc.)
  }

  /**
   * Try to read port from vite.config.ts or vite.config.js
   */
  private readViteConfigPort(projectPath: string): number | null {
    const configFiles = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
    
    for (const configFile of configFiles) {
      const configPath = join(projectPath, configFile);
      try {
        if (!existsSync(configPath)) continue;
        
        const content = readFileSync(configPath, 'utf-8');
        // Match patterns like: port: 3000 or port:3000 or "port": 3000
        const portMatch = content.match(/["']?port["']?\s*:\s*(\d+)/);
        if (portMatch?.[1]) {
          console.info(`[SmokeGate] Found port ${portMatch[1]} in ${configFile}`);
          return parseInt(portMatch[1], 10);
        }
      } catch {
        // Ignore read errors
      }
    }
    
    return null;
  }

  /**
   * HTTP health check
   */
  private async checkHttpHealth(urls: string[]): Promise<boolean> {
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          console.warn(`[SmokeGate] HTTP check failed for ${url}: ${response.status}`);
          return false;
        }
      } catch (error) {
        console.warn(`[SmokeGate] HTTP check failed for ${url}: ${(error as Error).message}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Browser verification
   * 
   */
  private async checkBrowser(options: {
    workDir: string;
    url: string;
    requiredSelectors: string[];
    captureScreenshot: boolean;
    screenshotPath: string;
    checkConsoleErrors: boolean;
    timeout: number;
    requireBrowser: boolean;
  }): Promise<{
    passed: boolean;
    consoleErrors: string[];
    missingSelectors: string[];
    screenshotPath: string;
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
  }> {
    const result: {
      passed: boolean;
      consoleErrors: string[];
      missingSelectors: string[];
      screenshotPath: string;
      fetchSummary?: {
        total: number;
        success: number;
        failed: number;
        failures?: {
          url: string;
          status?: number;
          method?: string;
          error?: string;
        }[];
      };
    } = {
      passed: false,
      consoleErrors: [],
      missingSelectors: [],
      screenshotPath: options.screenshotPath,
    };

    const browserVerifyInput: Parameters<typeof runBrowserVerify>[0] = {
      workDir: options.workDir,
      url: options.url,
      requiredSelectors: options.requiredSelectors,
      checkConsoleErrors: options.checkConsoleErrors,
      timeout: options.timeout,
      trackNetwork: true,
    };
    if (options.captureScreenshot && options.screenshotPath) {
      browserVerifyInput.screenshotPath = options.screenshotPath;
    }
    const browserResult = await runBrowserVerify(browserVerifyInput);

    if (!browserResult.passed) {
      const errorMsg = browserResult.error ?? 'Browser verification failed';
      const missingPlaywright = errorMsg.includes('Playwright is not installed');
      if (!options.requireBrowser && missingPlaywright) {
        return await this.checkBrowserFallback(options);
      }
    }

    result.passed = browserResult.passed;
    result.consoleErrors = browserResult.consoleErrors;
    result.missingSelectors = browserResult.missingSelectors;
    if (browserResult.fetchSummary !== undefined) {
      result.fetchSummary = browserResult.fetchSummary;
    }
    result.screenshotPath = browserResult.screenshotPath ?? options.screenshotPath;

    if (!browserResult.passed && browserResult.error) {
      result.consoleErrors = [...result.consoleErrors, browserResult.error];
    }

    return result;
  }

  private async checkBrowserFallback(options: {
    workDir: string;
    url: string;
    requiredSelectors: string[];
    captureScreenshot: boolean;
    screenshotPath: string;
    checkConsoleErrors: boolean;
    timeout: number;
    requireBrowser: boolean;
  }): Promise<{
    passed: boolean;
    consoleErrors: string[];
    missingSelectors: string[];
    screenshotPath: string;
  }> {
    const result = {
      passed: true,
      consoleErrors: [] as string[],
      missingSelectors: [] as string[],
      screenshotPath: options.screenshotPath,
    };

    try {
      const response = await fetch(options.url, {
        signal: AbortSignal.timeout(options.timeout),
      });

      const html = await response.text();

      if (
        html.includes('Cannot GET') ||
        (html.includes('Error:') && html.includes('at ')) ||
        html.includes('Internal Server Error')
      ) {
        result.passed = false;
        result.consoleErrors.push('Page contains error content');
      }

      if (options.requiredSelectors.length > 0) {
        for (const selector of options.requiredSelectors) {
          let pattern: RegExp;
          if (selector.startsWith('#')) {
            pattern = new RegExp(`id=["']${selector.slice(1)}["']`);
          } else if (selector.startsWith('.')) {
            pattern = new RegExp(`class=["'][^"']*${selector.slice(1)}[^"']*["']`);
          } else {
            pattern = new RegExp(`<${selector}[\\s>]`);
          }

          if (!pattern.test(html)) {
            result.missingSelectors.push(selector);
            result.passed = false;
          }
        }
      }
    } catch (error) {
      result.passed = false;
      result.consoleErrors.push((error as Error).message);
    }

    return result;
  }

  /**
   * Format smoke test result for worker
   */
  static formatForWorker(result: SmokeTestResult): string {
    const lines: string[] = [];
    
    lines.push('## Smoke Test Results');
    lines.push('');
    lines.push(`- Server Started: ${result.serverStarted ? '✅' : '❌'}`);
    lines.push(`- HTTP Check: ${result.httpCheckPassed ? '✅' : '❌'}`);
    lines.push(`- Browser Check: ${result.browserCheckPassed ? '✅' : '❌'}`);
    lines.push(`- Data Fetch: ${result.dataFetchPassed ? '✅' : '❌'}`);
    lines.push('');
    
    if (result.consoleErrors.length > 0) {
      lines.push('### Console Errors');
      for (const error of result.consoleErrors) {
        lines.push(`- ${error}`);
      }
      lines.push('');
    }
    
    if (result.missingSelectors.length > 0) {
      lines.push('### Missing Selectors');
      for (const selector of result.missingSelectors) {
        lines.push(`- ${selector}`);
      }
      lines.push('');
    }

    if (result.fetchSummary) {
      lines.push('### Fetch/XHR Summary');
      lines.push(`- Total: ${result.fetchSummary.total}`);
      lines.push(`- Success: ${result.fetchSummary.success}`);
      lines.push(`- Failed: ${result.fetchSummary.failed}`);
      if (result.fetchSummary.failures && result.fetchSummary.failures.length > 0) {
        lines.push('### Fetch Failures (sample)');
        for (const failure of result.fetchSummary.failures.slice(0, 5)) {
          const status = failure.status !== undefined ? ` status=${failure.status}` : '';
          const method = failure.method ? ` ${failure.method}` : '';
          const error = failure.error ? ` error=${failure.error}` : '';
          lines.push(`- ${failure.url}${method}${status}${error}`);
        }
      }
      lines.push('');
    }
    
    if (result.error) {
      lines.push(`### Error`);
      lines.push(result.error);
    }
    
    return lines.join('\n');
  }

  private async resolveSmokeTarget(workDir: string): Promise<{ targetDir: string; projectConfig: ProjectConfig }> {
    const rootConfig = await this.projectDetector.detect(workDir);
    if (rootConfig.devCommand) {
      return { targetDir: workDir, projectConfig: rootConfig };
    }

    const candidates = await this.projectDetector.detectAll(workDir);
    const frontendCandidate = candidates.find((candidate) =>
      candidate.config.devCommand && this.looksLikeFrontend(candidate.path, candidate.config)
    );
    if (frontendCandidate) {
      return { targetDir: frontendCandidate.path, projectConfig: frontendCandidate.config };
    }

    return { targetDir: workDir, projectConfig: rootConfig };
  }

  private shouldRequireDataFetch(rootDir: string, frontendDir: string, config: ProjectConfig): boolean {
    if (!this.looksLikeFrontend(frontendDir, config)) {
      return false;
    }
    return this.hasBackendSignals(rootDir);
  }

  private looksLikeFrontend(workDir: string, config: ProjectConfig): boolean {
    if (config.devCommand?.includes('vite') || config.devCommand?.includes('next') || config.devCommand?.includes('react-scripts')) {
      return true;
    }
    if (
      existsSync(join(workDir, 'index.html')) ||
      existsSync(join(workDir, 'public', 'index.html')) ||
      existsSync(join(workDir, 'vite.config.ts')) ||
      existsSync(join(workDir, 'vite.config.js')) ||
      existsSync(join(workDir, 'next.config.js')) ||
      existsSync(join(workDir, 'next.config.ts'))
    ) {
      return true;
    }
    return existsSync(join(workDir, 'app')) || existsSync(join(workDir, 'pages'));
  }

  private hasBackendSignals(workDir: string): boolean {
    const markers = [
      'requirements.txt',
      'pyproject.toml',
      'setup.py',
      'Pipfile',
      'main.py',
      'app.py',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      '*.csproj',
      '*.fsproj',
      '*.sln',
    ];

    for (const marker of markers) {
      if (marker.includes('*')) {
        const entries = readdirSync(workDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (marker.startsWith('*.') && entry.name.endsWith(marker.slice(1))) {
            return true;
          }
        }
        continue;
      }
      if (existsSync(join(workDir, marker))) {
        return true;
      }
    }

    const nodeBackendDirs = ['backend', 'server', 'api'];
    for (const dir of nodeBackendDirs) {
      if (
        existsSync(join(workDir, dir, 'package.json')) ||
        existsSync(join(workDir, dir, 'tsconfig.json'))
      ) {
        return true;
      }
    }

    return false;
  }
}

/**
 * Factory function
 */
export function createSmokeGateService(): SmokeGateService {
  return new SmokeGateService();
}

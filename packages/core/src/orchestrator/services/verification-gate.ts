/**
 * VerificationGateService
 * 
 * Multi-layer verification service that integrates:
 * - Type checking (tsc, pyright, mypy)
 * - Build verification (npm run build)
 * - Test execution (vitest, jest, bun test)
 * - E2E browser verification (browser_verify tool)
 */

import { ProjectDetector, type ProjectConfig } from './project-detector';
import { BuildGateService, type BuildError } from './build-gate';
import { SmokeGateService, type SmokeTestConfig } from './smoke-gate';
import { runBrowserVerify } from './browser-verify-runner';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

// =============================================================================
// Types
// =============================================================================

export interface VerificationLayerResult {
  /** Layer name */
  layer: 'deps' | 'type' | 'build' | 'test' | 'lint' | 'e2e' | 'smoke';
  
  /** Whether verification passed */
  passed: boolean;
  
  /** Errors found */
  errors: VerificationError[];
  
  /** Warnings found */
  warnings: VerificationError[];
  
  /** Command executed */
  command: string;
  
  /** Duration in ms */
  duration: number;
  
  /** Raw output */
  output?: string;
  
  /** Summary message */
  summary: string;
}

export interface VerificationError {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface VerificationOptions {
  /** Which layers to run */
  layers?: ('deps' | 'type' | 'build' | 'test' | 'lint' | 'e2e' | 'smoke')[];

  /** Preset for layer selection */
  preset?: 'fast' | 'full';
  
  /** Dev server URL for E2E verification */
  devServerUrl?: string;

  /** Required selectors for browser verification */
  requiredSelectors?: string[];

  /** Screenshot path (relative to workDir) */
  screenshotPath?: string;

  /** Require browser verification to pass */
  requireBrowser?: boolean;

  /** Whether to auto-install dependencies when missing (default true) */
  installDeps?: boolean;
  
  /** Changed files for diff-based gating */
  changedFiles?: string[];
  
  /** Timeout for each layer in ms */
  timeout?: number;
  
  /** Whether to fail on warnings */
  failOnWarnings?: boolean;

  /** P9: Whether to verify ALL detected projects regardless of changedFiles (default: false) */
  verifyAllProjects?: boolean;
}

export interface VerificationResult {
  /** Overall pass/fail */
  passed: boolean;
  
  /** Results per layer */
  layers: VerificationLayerResult[];
  
  /** Total duration */
  duration: number;
  
  /** Detected project config */
  projectConfig: ProjectConfig;
  
  /** Summary message */
  summary: string;
}

export interface VerificationGateConfig {
  /** Timeout for commands in ms */
  timeout?: number;
  
  /** Max output length */
  maxOutput?: number;
  
  /** Whether to use LSP for type checking */
  useLsp?: boolean;

  /** Default preset to use when none is provided */
  defaultPreset?: 'fast' | 'full';

  /** Override layer set for fast preset */
  fastLayers?: VerificationOptions['layers'];

  /** Override layer set for full preset */
  fullLayers?: VerificationOptions['layers'];

  /** Include build layer in fast preset when available */
  fastIncludeBuild?: boolean;

  /** Auto-install dependencies when missing */
  autoInstallDeps?: boolean;

  /** Timeout for dependency install command in ms */
  installDepsTimeout?: number;
}

// =============================================================================
// VerificationGateService
// =============================================================================

export class VerificationGateService {
  /**
   * Format errors for worker output
   */
  static formatErrorsForWorker(result: VerificationResult): string {
    const lines: string[] = [];
    
    if (result.passed) {
      lines.push('✅ Verification Passed');
      return lines.join('\n');
    }
    
    lines.push(`❌ Verification Failed: ${result.summary}`);
    lines.push('');
    
    for (const layer of result.layers) {
      if (!layer.passed) {
        lines.push(`### ${layer.layer.toUpperCase()} Layer Failed`);
        if (layer.summary) lines.push(`Summary: ${layer.summary}`);
        lines.push('');
        
        if (layer.errors.length > 0) {
          lines.push('Errors:');
          const shownErrors = layer.errors.slice(0, 20); // Limit output
          for (const error of shownErrors) {
            const loc = error.file ? `${error.file}:${error.line ?? 0}:${error.column ?? 0}` : '';
            lines.push(`- ${loc ? `[${loc}] ` : ''}${error.message}`);
          }
          if (layer.errors.length > 20) {
            lines.push(`... and ${layer.errors.length - 20} more errors`);
          }
        }
        lines.push('');
      }
    }
    
    return lines.join('\n');
  }

  private readonly projectDetector: ProjectDetector;
  private readonly buildGateService: BuildGateService;
  private readonly smokeGateService: SmokeGateService;
  private readonly config: VerificationGateConfig & {
    timeout: number;
    maxOutput: number;
    useLsp: boolean;
    defaultPreset: 'fast' | 'full';
  };

  constructor(config: VerificationGateConfig = {}) {
    this.config = {
      timeout: config.timeout ?? 120000,
      maxOutput: config.maxOutput ?? 10000,
      useLsp: config.useLsp ?? true,
      defaultPreset: config.defaultPreset ?? 'fast',
      fastLayers: config.fastLayers,
      fullLayers: config.fullLayers,
      fastIncludeBuild: config.fastIncludeBuild ?? false,
      autoInstallDeps: config.autoInstallDeps ?? true,
      installDepsTimeout: config.installDepsTimeout ?? 300000,
    };
    
    this.projectDetector = new ProjectDetector();
    this.buildGateService = new BuildGateService({
      timeout: this.config.timeout,
      useLsp: this.config.useLsp,
    });
    this.smokeGateService = new SmokeGateService();
  }

  /**
   * Run multi-layer verification
   */
  /**
   * Run multi-layer verification
   */
  async verify(workDir: string, options: VerificationOptions = {}): Promise<VerificationResult> {
    const startTime = Date.now();
    
    // P7: Detect all projects in the workspace (Monorepo support)
    const allProjects = await this.projectDetector.detectAll(workDir);
    
    // If no projects found, fallback to root context
    const detectedProjects = allProjects.length > 0 
      ? allProjects 
      : [{ path: workDir, config: await this.projectDetector.detect(workDir) }];

    // P9: Multi-project verification is opt-in
    // Only verify multiple projects if:
    // 1. verifyAllProjects is explicitly true, OR
    // 2. changedFiles is provided (scoped verification)
    // Otherwise, only verify the root project
    const changedFiles = options.changedFiles;
    let relevantProjects: { path: string, config: ProjectConfig }[];
    
    if (options.verifyAllProjects) {
      // Explicit opt-in: verify all detected projects
      relevantProjects = detectedProjects;
    } else if (changedFiles && changedFiles.length > 0) {
      // Scoped verification: only projects affected by changed files
      relevantProjects = detectedProjects.filter((p: { path: string, config: ProjectConfig }) => 
        // Root project is always relevant if it's the only one
        (detectedProjects.length === 1 && p.path === workDir) ||
        // P9 Fix: Use proper path boundary check to avoid /app matching /app2
        changedFiles.some(f => {
          const absoluteFile = isAbsolute(f) ? resolve(f) : resolve(workDir, f);
          const projectRoot = resolve(p.path);
          const rel = relative(projectRoot, absoluteFile);
          return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        })
      );
    } else {
      // Default: only verify root project to avoid "unrelated package failure" regression
      relevantProjects = detectedProjects.filter(p => p.path === workDir);
      // If root is not in detected projects (e.g., only sub-projects found), use first detected
      if (relevantProjects.length === 0 && detectedProjects.length > 0) {
        // Safe to assert since we checked length > 0
        relevantProjects = [detectedProjects[0]!];
      }
    }

    console.info(`[VerificationGate] Found ${detectedProjects.length} projects, verifying ${relevantProjects.length} affected projects`);

    const allLayerResults: VerificationLayerResult[] = [];
    
    // P6: Check for file extension conflicts at the root/project level before anything else
    for (const project of relevantProjects) {
      const conflictErrors = await this.checkFileConflicts(project.path);
      if (conflictErrors.length > 0) {
        allLayerResults.push({
          layer: 'build',
          passed: false,
          errors: conflictErrors,
          warnings: [],
          command: 'file-conflict-check',
          duration: 0,
          summary: `Found ${conflictErrors.length} file extension conflicts in ${project.path}`,
        });
        
        // Fail fast if conflicts found
        return {
          passed: false,
          layers: allLayerResults,
          duration: Date.now() - startTime,
          projectConfig: project.config,
          summary: `File extension conflict in ${project.path}`,
        };
      }
      // P8: Fail if infrastructure is incomplete (e.g. TS files but no tsconfig)
      if (project.config.incompleteInfra.length > 0) {
        const infraErrors: VerificationError[] = project.config.incompleteInfra.map(msg => ({
          message: `INCOMPLETE INFRASTRUCTURE: ${msg}`,
          severity: 'error',
        }));

        allLayerResults.push({
          layer: 'build',
          passed: false,
          errors: infraErrors,
          warnings: [],
          command: 'infra-check',
          duration: 0,
          summary: `Missing mandatory infrastructure in ${project.path}`,
        });

        return {
          passed: false,
          layers: allLayerResults,
          duration: Date.now() - startTime,
          projectConfig: project.config,
          summary: `Project at ${project.path} is missing required infrastructure`,
        };
      }

      console.info(`[VerificationGate] Verifying project at ${project.path} (${project.config.projectType})`);
      
      const layers = options.layers ?? this.getLayersForPreset(project.config, options);
      
      // Ensure dependencies for this project
      const depsResult = await this.ensureDependencies(project.path, project.config, options);
      if (depsResult) {
        allLayerResults.push(depsResult);
        if (!depsResult.passed) {
          return {
            passed: false,
            layers: allLayerResults,
            duration: Date.now() - startTime,
            projectConfig: project.config,
            summary: `[${project.path}] ${depsResult.summary}`,
          };
        }
      }

      // Run layers for this project
      const activeLayers = layers ?? [];
      for (const layer of activeLayers) {
        const layerResult = await this.runLayer(project.path, layer, project.config, options);
        allLayerResults.push(layerResult);
        
        if (layerResult.passed) {
          console.info(`[VerificationGate] [${project.path}] ${layer.toUpperCase()} PASSED in ${layerResult.duration}ms`);
        } else {
          console.error(`[VerificationGate] [${project.path}] ${layer.toUpperCase()} FAILED: ${layerResult.summary}`);
          
          // If a critical layer fails, we might want to stop early
          if (['type', 'build'].includes(layer)) {
            return {
              passed: false,
              layers: allLayerResults,
              duration: Date.now() - startTime,
              projectConfig: project.config,
              summary: `[${project.path}] ${layerResult.summary}`,
            };
          }
        }
      }
    }

    const passed = allLayerResults.every(r => r.passed);
    const failedLayer = allLayerResults.find(r => !r.passed);
    
    return {
      passed,
      layers: allLayerResults,
      duration: Date.now() - startTime,
      projectConfig: (relevantProjects.length > 0 
        ? relevantProjects[0]?.config 
        : (detectedProjects.length > 0 ? detectedProjects[0]?.config : undefined)) ?? ({} as ProjectConfig),
      summary: passed 
        ? (allLayerResults.length > 0 ? 'All verifications passed' : 'No verification layers configured')
        : (failedLayer ? failedLayer.summary : 'Verification failed'),
    };
  }

  /**
   * Resolve layers based on preset and project config
   */
  private getLayersForPreset(
    config: ProjectConfig,
    options: VerificationOptions
  ): VerificationOptions['layers'] {
    const preset = options.preset ?? this.config.defaultPreset;
    const override = preset === 'fast' ? this.config.fastLayers : this.config.fullLayers;
    if (override && override.length > 0) {
      return override;
    }
    return preset === 'full' ? this.getFullLayers(config, options) : this.getFastLayers(config);
  }

  private getFastLayers(config: ProjectConfig): VerificationOptions['layers'] {
    const layers: VerificationOptions['layers'] = [];
    if (config.typeCheckCommand) {
      layers.push('type');
    }
    // Optional build layer for fast preset (opt-in)
    if (this.config.fastIncludeBuild && config.buildCommand) {
      layers.push('build');
    }
    // Fall back to lint (or build if that's the only signal)
    if (layers.length === 0) {
      if (config.lintCommand) {
        layers.push('lint');
      } else if (config.buildCommand) {
        layers.push('build');
      }
    }
    return layers;
  }

  private getFullLayers(
    config: ProjectConfig,
    options: VerificationOptions
  ): VerificationOptions['layers'] {
    const layers: VerificationOptions['layers'] = [];

    if (config.typeCheckCommand) {
      layers.push('type');
    }
    if (config.lintCommand) {
      layers.push('lint');
    }
    if (config.buildCommand) {
      layers.push('build');
    }
    if (config.testCommand) {
      layers.push('test');
    }
    if (config.devCommand) {
      layers.push('smoke');
    }
    if (options.devServerUrl) {
      layers.push('e2e');
    }

    return layers;
  }

  /**
   * Run a single verification layer
   */
  private async runLayer(
    workDir: string,
    layer: 'deps' | 'type' | 'build' | 'test' | 'lint' | 'e2e' | 'smoke',
    projectConfig: ProjectConfig,
    options: VerificationOptions
  ): Promise<VerificationLayerResult> {
    const startTime = Date.now();
    
    switch (layer) {
      case 'deps':
        return this.runDepsInstall(workDir, projectConfig, startTime, options);
      case 'type':
        return this.runTypeCheck(workDir, projectConfig, startTime);
      case 'build':
        return this.runBuild(workDir, projectConfig, startTime);
      case 'test':
        return this.runTests(workDir, projectConfig, startTime, options);
      case 'lint':
        return this.runLint(workDir, projectConfig, startTime);
      case 'e2e':
        return this.runE2E(workDir, projectConfig, startTime, options);
      case 'smoke':
        return this.runSmoke(workDir, projectConfig, startTime, options);
      default:
        return {
          layer,
          passed: true,
          errors: [],
          warnings: [],
          command: 'none',
          duration: 0,
          summary: 'Unknown layer, skipped',
        };
    }
  }

  private async ensureDependencies(
    workDir: string,
    projectConfig: ProjectConfig,
    options: VerificationOptions
  ): Promise<VerificationLayerResult | null> {
    if (options.installDeps === false || this.config.autoInstallDeps === false) {
      return null;
    }

    if (projectConfig.projectType !== 'typescript' && projectConfig.projectType !== 'javascript') {
      return null;
    }

    if (!projectConfig.installCommand) {
      return null;
    }

    const nodeModulesPath = join(workDir, 'node_modules');
    if (existsSync(nodeModulesPath)) {
      return null;
    }

    return this.runDepsInstall(workDir, projectConfig, Date.now(), options);
  }

  private async runDepsInstall(
    workDir: string,
    projectConfig: ProjectConfig,
    startTime: number,
    options: VerificationOptions
  ): Promise<VerificationLayerResult> {
    const command = projectConfig.installCommand ?? 'npm install';
    const result = await this.runCommand(command, workDir, {
      timeout: options.timeout ?? (this.config.installDepsTimeout || 300000),
    });

    const passed = result.exitCode === 0;
    const errors: VerificationError[] = passed
      ? []
      : [{ message: result.output, severity: 'error' }];

    return {
      layer: 'deps',
      passed,
      errors,
      warnings: [],
      command,
      duration: Date.now() - startTime,
      output: result.output,
      summary: passed ? 'Dependencies installed' : `Dependency install failed with exit code ${result.exitCode}`,
    };
  }

  /**
   * Run type check layer using BuildGateService
   */
  private async runTypeCheck(
    workDir: string,
    projectConfig: ProjectConfig,
    startTime: number
  ): Promise<VerificationLayerResult> {
    if (!projectConfig.typeCheckCommand) {
      return {
        layer: 'type',
        passed: true,
        errors: [],
        warnings: [],
        command: 'none',
        duration: Date.now() - startTime,
        summary: 'No type checker configured',
      };
    }
    
    // Use BuildGateService for type checking (it has LSP support)
    const result = await this.buildGateService.check(workDir, {
      projectType: projectConfig.projectType,
      typeCheckCommand: projectConfig.typeCheckCommand ?? undefined,
    });
    
    const command =
      result.command === 'lsp_diagnostics' && projectConfig.typeCheckCommand
        ? projectConfig.typeCheckCommand
        : result.command ?? projectConfig.typeCheckCommand;

    return {
      layer: 'type',
      passed: result.passed,
      errors: result.errors.map(this.convertBuildError),
      warnings: result.warnings.map(this.convertBuildError),
      command: command ?? 'type-check',
      duration: result.duration ?? (Date.now() - startTime),
      summary: result.summary,
    };
  }

  /**
   * Run build layer
   */
  private async runBuild(
    workDir: string,
    projectConfig: ProjectConfig,
    startTime: number
  ): Promise<VerificationLayerResult> {
    if (!projectConfig.buildCommand) {
      return {
        layer: 'build',
        passed: true,
        errors: [],
        warnings: [],
        command: 'none',
        duration: Date.now() - startTime,
        summary: 'No build command configured',
      };
    }
    
    const result = await this.runCommand(projectConfig.buildCommand, workDir);
    const errors: VerificationError[] = result.exitCode !== 0
      ? this.parseBuildErrors(result.output, workDir)
      : [];
    
    return {
      layer: 'build',
      passed: result.exitCode === 0,
      errors,
      warnings: [],
      command: projectConfig.buildCommand,
      duration: Date.now() - startTime,
      output: result.output,
      summary: result.exitCode === 0 
        ? 'Build passed'
        : `Build failed with exit code ${result.exitCode}`,
    };
  }

  /**
   * P6/P9: Check for file extension conflicts (e.g., App.js and App.tsx both exist)
   * This causes module resolution confusion in CRA/Vite
   * 
   * P9: Extended to scan app/, pages/, lib/, components/ directories (Next.js support)
   * Added performance guards: max file count and depth limits
   */
  private async checkFileConflicts(workDir: string): Promise<VerificationError[]> {
    const errors: VerificationError[] = [];
    
    // P9: Scan multiple common source directories
    const sourceDirs = ['src', 'app', 'pages', 'lib', 'components'];
    const MAX_FILES_PER_DIR = 500; // Performance guard
    
    for (const dirName of sourceDirs) {
      const dir = join(workDir, dirName);
      if (!existsSync(dir)) continue;
      
      try {
        // P9: Use sync readdir with limited depth (3 levels max)
        const files = this.scanDirForConflicts(dir, 3, MAX_FILES_PER_DIR);
        
        // Group files by basename (without extension)
        const fileGroups = new Map<string, string[]>();
        
        for (const file of files) {
          // Only check .js, .jsx, .ts, .tsx files
          if (!/\.(js|jsx|ts|tsx)$/.test(file)) continue;
          
          const basename = file.replace(/\.(js|jsx|ts|tsx)$/, '');
          const existing = fileGroups.get(basename) ?? [];
          existing.push(file);
          fileGroups.set(basename, existing);
        }
        
        // Find conflicts: same basename with both .js/.jsx and .ts/.tsx
        for (const [_basename, fileList] of fileGroups) {
          if (fileList.length < 2) continue;
          
          const hasJs = fileList.some(f => /\.(js|jsx)$/.test(f));
          const hasTs = fileList.some(f => /\.(ts|tsx)$/.test(f));
          
          if (hasJs && hasTs) {
            const jsFile = fileList.find(f => /\.(js|jsx)$/.test(f));
            const tsFile = fileList.find(f => /\.(ts|tsx)$/.test(f));
            if (jsFile && tsFile) {
              errors.push({
                file: join(dir, jsFile),
                message: `FILE CONFLICT: Both '${jsFile}' and '${tsFile}' exist in ${dirName}/. ` +
                  `CRA/Vite will load '${jsFile}' and ignore '${tsFile}'. ` +
                  `DELETE the .js file if you want to use TypeScript, or delete the .tsx file if using JavaScript.`,
                severity: 'error',
              });
            }
          }
        }
      } catch {
        // P9: Silent skip on error to avoid blocking verification
      }
    }
    
    return errors;
  }

  /**
   * P9: Scan directory for file conflicts with depth and count limits
   */
  private scanDirForConflicts(dir: string, maxDepth: number, maxFiles: number): string[] {
    const results: string[] = [];
    
    const scan = (currentDir: string, depth: number, basePath: string) => {
      if (depth <= 0 || results.length >= maxFiles) return;
      
      try {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxFiles) break;
          
          const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
          
          if (entry.isDirectory()) {
            // Skip node_modules and hidden directories
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            scan(join(currentDir, entry.name), depth - 1, relativePath);
          } else {
            results.push(relativePath);
          }
        }
      } catch {
        // Ignore errors
      }
    };
    
    scan(dir, maxDepth, '');
    return results;
  }

  /**
   * P5: Parse BUILD errors to extract file paths and structured error info
   * Supports CRA/Webpack, Vite/esbuild error formats
   */
  private parseBuildErrors(output: string, workDir: string): VerificationError[] {
    const errors: VerificationError[] = [];
    
    // CRA/Webpack: "Module not found: Error: Can't resolve './App' in '/path/to/dir'"
    const moduleNotFound = /Module not found.*Can't resolve '([^']+)' in '([^']+)'/g;
    for (const match of output.matchAll(moduleNotFound)) {
      const importPath = match[1] ?? '';
      const directory = match[2] ?? workDir;
      // Construct likely file path
      const likelyFile = importPath.startsWith('.') 
        ? `${directory}/${importPath.replace(/^\.\//, '')}.tsx`
        : directory;
      errors.push({
        file: likelyFile,
        message: `Cannot import '${importPath}'. Check: 1) File exists, 2) Export name matches import (e.g., if file has 'export default AppContent', import should be 'import AppContent' not 'import App')`,
        severity: 'error',
      });
    }
    
    // Vite/esbuild: "✘ [ERROR] No matching export in "file.tsx" for import "Name""
    const exportMismatch = /No matching export in "([^"]+)" for import "([^"]+)"/g;
    for (const match of output.matchAll(exportMismatch)) {
      const filePath = match[1] ?? workDir;
      const importName = match[2] ?? 'unknown';
      errors.push({
        file: filePath,
        message: `Export mismatch: '${importName}' is not exported from this file. Check the actual export name.`,
        severity: 'error',
      });
    }
    
    // CRA: "Failed to compile" with file path on next line
    const failedCompile = /Failed to compile\.\s*\n\s*([^\n]+\.tsx?)/g;
    for (const match of output.matchAll(failedCompile)) {
      const filePath = match[1] ?? workDir;
      if (!errors.some(e => e.file === filePath)) {
        errors.push({
          file: filePath,
          message: 'Compilation failed. Check syntax and imports.',
          severity: 'error',
        });
      }
    }
    
    // Fallback: if no pattern matched, return raw output with workDir hint
    if (errors.length === 0) {
      errors.push({ 
        file: workDir,
        message: output.slice(0, 2000), // Truncate to avoid token explosion
        severity: 'error',
      });
    }
    
    return errors;
  }

  /**
   * Run test layer
   */
  private async runTests(
    workDir: string,
    projectConfig: ProjectConfig,
    startTime: number,
    _options: VerificationOptions
  ): Promise<VerificationLayerResult> {
    if (!projectConfig.testCommand) {
      return {
        layer: 'test',
        passed: true,
        errors: [],
        warnings: [],
        command: 'none',
        duration: Date.now() - startTime,
        summary: 'No test command configured',
      };
    }
    
    const result = await this.runCommand(projectConfig.testCommand, workDir, {
      timeout: this.config.timeout * 2, // Tests get more time
    });
    
    const errors: VerificationError[] = result.exitCode !== 0
      ? this.parseTestErrors(result.output, projectConfig.testFramework)
      : [];
    
    return {
      layer: 'test',
      passed: result.exitCode === 0,
      errors,
      warnings: [],
      command: projectConfig.testCommand,
      duration: Date.now() - startTime,
      output: result.output,
      summary: result.exitCode === 0
        ? 'Tests passed'
        : `Tests failed with exit code ${result.exitCode}`,
    };
  }

  /**
   * Run lint layer
   */
  private async runLint(
    workDir: string,
    projectConfig: ProjectConfig,
    startTime: number
  ): Promise<VerificationLayerResult> {
    if (!projectConfig.lintCommand) {
      return {
        layer: 'lint',
        passed: true,
        errors: [],
        warnings: [],
        command: 'none',
        duration: Date.now() - startTime,
        summary: 'No lint command configured',
      };
    }
    
    const result = await this.runCommand(projectConfig.lintCommand, workDir);
    const errors = result.exitCode !== 0
      ? this.parseEslintErrors(result.output)
      : [];
    
    return {
      layer: 'lint',
      passed: result.exitCode === 0,
      errors,
      warnings: [],
      command: projectConfig.lintCommand,
      duration: Date.now() - startTime,
      output: result.output,
      summary: result.exitCode === 0
        ? 'Lint passed'
        : `Lint failed with ${errors.length} errors`,
    };
  }

  /**
   * Run E2E browser verification
   */
  private async runE2E(
    workDir: string,
    _projectConfig: ProjectConfig,
    startTime: number,
    options: VerificationOptions
  ): Promise<VerificationLayerResult> {
    if (!options.devServerUrl) {
      return {
        layer: 'e2e',
        passed: true,
        errors: [],
        warnings: [],
        command: 'none',
        duration: Date.now() - startTime,
        summary: 'No dev server URL provided for E2E',
      };
    }
    
    const requireBrowser = options.requireBrowser ?? true;
    const browserResult = await runBrowserVerify({
      workDir,
      url: options.devServerUrl,
      requiredSelectors: options.requiredSelectors ?? [],
      screenshotPath: options.screenshotPath ?? 'e2e-screenshot.png',
      checkConsoleErrors: true,
      timeout: options.timeout ?? 30000,
    });

    if (!browserResult.passed) {
      const errorMsg = browserResult.error ?? 'Browser verification failed';
      const missingPlaywright = errorMsg.includes('Playwright is not installed');

      if (!requireBrowser && missingPlaywright) {
        try {
          const response = await fetch(options.devServerUrl, {
            signal: AbortSignal.timeout(10000),
          });

          if (response.ok) {
            return {
              layer: 'e2e',
              passed: true,
              errors: [],
              warnings: [],
              command: `fetch ${options.devServerUrl}`,
              duration: Date.now() - startTime,
              summary: `Page loaded successfully (status ${response.status})`,
            };
          }

          return {
            layer: 'e2e',
            passed: false,
            errors: [{ message: `HTTP ${response.status}: ${response.statusText}`, severity: 'error' }],
            warnings: [],
            command: `fetch ${options.devServerUrl}`,
            duration: Date.now() - startTime,
            summary: `Page returned error status ${response.status}`,
          };
        } catch (error) {
          return {
            layer: 'e2e',
            passed: false,
            errors: [{ message: (error as Error).message, severity: 'error' }],
            warnings: [],
            command: `fetch ${options.devServerUrl}`,
            duration: Date.now() - startTime,
            summary: `Failed to reach dev server: ${(error as Error).message}`,
          };
        }
      }

      const errors = browserResult.consoleErrors.map((msg) => ({
        message: msg,
        severity: 'error' as const,
      }));
      const selectorErrors = browserResult.missingSelectors.map((selector) => ({
        message: `Missing selector: ${selector}`,
        severity: 'error' as const,
      }));
      if (browserResult.error) {
        errors.push({ message: browserResult.error, severity: 'error' as const });
      }

      return {
        layer: 'e2e',
        passed: false,
        errors: errors.concat(selectorErrors),
        warnings: [],
        command: `browser_verify ${options.devServerUrl}`,
        duration: Date.now() - startTime,
        summary: browserResult.error ?? 'Browser verification failed',
      };
    }

    return {
      layer: 'e2e',
      passed: true,
      errors: [],
      warnings: [],
      command: `browser_verify ${options.devServerUrl}`,
      duration: Date.now() - startTime,
      summary: 'Browser verification passed',
    };
  }

  /**
   * Run smoke test layer
   */
  private async runSmoke(
    workDir: string,
    _projectConfig: ProjectConfig,
    _startTime: number,
    options: VerificationOptions
  ): Promise<VerificationLayerResult> {
    // Determine port if devServerUrl provided
    let port: number | undefined;
    if (options.devServerUrl) {
      const match = options.devServerUrl.match(/:(\d+)/);
      if (match?.[1]) {
        port = parseInt(match[1], 10);
      }
    }

    const smokeConfig: SmokeTestConfig = {
      workDir,
      serverStartTimeout: 60000,
      pageTimeout: 30000,
      checkConsoleErrors: true,
      captureScreenshot: true,
      screenshotPath: options.screenshotPath ?? 'smoke-test-screenshot.png',
      requireBrowser: options.requireBrowser ?? true,
      ...(options.requiredSelectors ? { requiredSelectors: options.requiredSelectors } : {}),
    };
    
    if (port !== undefined) {
      smokeConfig.port = port;
    }
    
    if (options.devServerUrl) {
      smokeConfig.urls = [options.devServerUrl];
    }

    const result = await this.smokeGateService.check(smokeConfig);

    return {
      layer: 'smoke',
      passed: result.passed,
      errors: result.error ? [{ message: result.error, severity: 'error' as const }] : 
              result.consoleErrors.map(msg => ({ message: msg, severity: 'error' as const }))
              .concat(result.missingSelectors.map(sel => ({ message: `Missing selector: ${sel}`, severity: 'error' as const }))),
      warnings: [],
      command: result.serverUrl ? `dev-server ${result.serverUrl}` : 'smoke-test',
      duration: result.duration,
      summary: result.summary,
    };
  }

  /**
   * Run a shell command
   */
  private async runCommand(
    command: string,
    cwd: string,
    options: { timeout?: number } = {}
  ): Promise<{ output: string; exitCode: number }> {
    const timeout = options.timeout ?? this.config.timeout;
    
    return new Promise((resolve) => {
      const [cmd, ...args] = command.split(' ');
      if (!cmd) {
        resolve({ output: 'Invalid command', exitCode: 1 });
        return;
      }
      
      const child: ChildProcess = spawn(cmd, args, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      
      let output = '';
      let timedOut = false;
      
      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });
      
      child.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
      });
      
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
      }, timeout);
      
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        // Truncate output
        if (output.length > this.config.maxOutput) {
          output = output.slice(0, this.config.maxOutput) + '\n[Output truncated]';
        }
        resolve({
          output: timedOut ? output + '\n[Command timed out]' : output,
          exitCode: timedOut ? 124 : (code ?? 1),
        });
      });
      
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        resolve({
          output: output + '\n' + error.message,
          exitCode: 1,
        });
      });
    });
  }

  /**
   * Convert BuildError to VerificationError
   */
  private convertBuildError(error: BuildError): VerificationError {
    return {
      file: error.file,
      line: error.line,
      column: error.column,
      message: error.message,
      severity: error.severity,
    };
  }

  /**
   * Parse test output for errors
   */
  private parseTestErrors(
    output: string,
    _framework: ProjectConfig['testFramework']
  ): VerificationError[] {
    const errors: VerificationError[] = [];
    
    // Simple line-by-line parsing for common patterns
    const lines = output.split('\n');
    for (const line of lines) {
      // Vitest/Jest failure pattern
      if (line.includes('FAIL') || line.includes('✗') || line.includes('✘')) {
        errors.push({ message: line.trim(), severity: 'error' });
      }
      // Error stack traces
      if (line.includes('Error:') && !line.includes('at ')) {
        errors.push({ message: line.trim(), severity: 'error' });
      }
    }
    
    // If no specific errors found, add generic one
    if (errors.length === 0) {
      errors.push({ message: 'Tests failed - see output for details', severity: 'error' });
    }
    
    return errors.slice(0, 20); // Limit to 20 errors
  }

  /**
   * Parse ESLint output for errors
   */
  private parseEslintErrors(output: string): VerificationError[] {
    const errors: VerificationError[] = [];
    const lines = output.split('\n');
    
    // ESLint format: /path/to/file.ts
    //                  1:2  error  message  rule-name
    const errorRegex = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}/;
    let currentFile = '';
    
    for (const line of lines) {
      if (line.startsWith('/') || line.startsWith('.')) {
        currentFile = line.trim();
      } else {
        const match = line.match(errorRegex);
        if (match) {
          errors.push({
            file: currentFile,
            line: parseInt(match[1] ?? '0', 10),
            column: parseInt(match[2] ?? '0', 10),
            message: match[4] ?? 'Unknown error',
            severity: (match[3] ?? 'error') as 'error' | 'warning',
          });
        }
      }
    }
    
    return errors.slice(0, 50); // Limit to 50 errors
  }


}

/**
 * Factory function for creating VerificationGateService
 */
export function createVerificationGateService(
  config?: VerificationGateConfig
): VerificationGateService {
  return new VerificationGateService(config);
}

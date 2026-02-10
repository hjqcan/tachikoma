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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

  /** Require at least one successful fetch/xhr during smoke check */
  requireDataFetch?: boolean;

  /** Minimum successful fetch/xhr count for smoke check */
  minSuccessfulFetches?: number;

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

  /**
   * Format errors for a specific layer (used to generate targeted fix tasks).
   */
  static formatLayerErrorsForWorker(
    result: VerificationResult,
    layer?: VerificationLayerResult['layer']
  ): string {
    if (!layer) return VerificationGateService.formatErrorsForWorker(result);
    const target = result.layers.find((entry) => entry.layer === layer);
    if (!target) return VerificationGateService.formatErrorsForWorker(result);

    const lines: string[] = [];
    lines.push(`❌ Verification Failed: ${target.summary || result.summary}`);
    lines.push('');
    lines.push(`### ${target.layer.toUpperCase()} Layer Failed`);
    if (target.summary) lines.push(`Summary: ${target.summary}`);
    lines.push('');

    if (target.errors.length > 0) {
      lines.push('Errors:');
      const shownErrors = target.errors.slice(0, 20);
      for (const error of shownErrors) {
        const loc = error.file ? `${error.file}:${error.line ?? 0}:${error.column ?? 0}` : '';
        lines.push(`- ${loc ? `[${loc}] ` : ''}${error.message}`);
      }
      if (target.errors.length > 20) {
        lines.push(`... and ${target.errors.length - 20} more errors`);
      }
    }
    lines.push('');

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
      const entrypointErrors = this.checkEntrypointConsistency(project.path);
      if (entrypointErrors.length > 0) {
        allLayerResults.push({
          layer: 'build',
          passed: false,
          errors: entrypointErrors,
          warnings: [],
          command: 'entrypoint-check',
          duration: 0,
          summary: `Entrypoint mismatch detected in ${project.path}`,
        });
        return {
          passed: false,
          layers: allLayerResults,
          duration: Date.now() - startTime,
          projectConfig: project.config,
          summary: `Entrypoint mismatch detected in ${project.path}`,
        };
      }
      const boundaryErrors = this.checkProjectBoundaryViolations(
        workDir,
        detectedProjects,
        options.changedFiles
      );
      if (boundaryErrors.length > 0) {
        allLayerResults.push({
          layer: 'build',
          passed: false,
          errors: boundaryErrors,
          warnings: [],
          command: 'project-boundary-check',
          duration: 0,
          summary: `Project boundary violation detected in ${project.path}`,
        });
        return {
          passed: false,
          layers: allLayerResults,
          duration: Date.now() - startTime,
          projectConfig: project.config,
          summary: `Project boundary violation detected in ${project.path}`,
        };
      }
      const testFrameworkErrors = this.checkTestFrameworkConsistency(project.path, project.config);
      if (testFrameworkErrors.length > 0) {
        allLayerResults.push({
          layer: 'build',
          passed: false,
          errors: testFrameworkErrors,
          warnings: [],
          command: 'test-framework-check',
          duration: 0,
          summary: `Test framework conflict detected in ${project.path}`,
        });
        return {
          passed: false,
          layers: allLayerResults,
          duration: Date.now() - startTime,
          projectConfig: project.config,
          summary: `Test framework conflict detected in ${project.path}`,
        };
      }
      const testingLibraryErrors = this.checkTestingLibrarySetup(project.path);
      if (testingLibraryErrors.length > 0) {
        allLayerResults.push({
          layer: 'build',
          passed: false,
          errors: testingLibraryErrors,
          warnings: [],
          command: 'testing-library-setup-check',
          duration: 0,
          summary: `Testing Library setup missing in ${project.path}`,
        });
        return {
          passed: false,
          layers: allLayerResults,
          duration: Date.now() - startTime,
          projectConfig: project.config,
          summary: `Testing Library setup missing in ${project.path}`,
        };
      }
      const forbiddenTestDirErrors = this.checkForbiddenTestDirs(project.path);
      if (forbiddenTestDirErrors.length > 0) {
        allLayerResults.push({
          layer: 'build',
          passed: false,
          errors: forbiddenTestDirErrors,
          warnings: [],
          command: 'forbidden-tests-dir-check',
          duration: 0,
          summary: `Forbidden __tests__ directory found in ${project.path}`,
        });
        return {
          passed: false,
          layers: allLayerResults,
          duration: Date.now() - startTime,
          projectConfig: project.config,
          summary: `Forbidden __tests__ directory found in ${project.path}`,
        };
      }
      const duplicateTestSuffixErrors = this.checkDuplicateTestSuffixes(project.path);
      if (duplicateTestSuffixErrors.length > 0) {
        allLayerResults.push({
          layer: 'build',
          passed: false,
          errors: duplicateTestSuffixErrors,
          warnings: [],
          command: 'test-file-naming-check',
          duration: 0,
          summary: `Duplicate test suffix detected in ${project.path}`,
        });
        return {
          passed: false,
          layers: allLayerResults,
          duration: Date.now() - startTime,
          projectConfig: project.config,
          summary: `Duplicate test suffix detected in ${project.path}`,
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
          const detail = VerificationGateService.formatLayerErrorsForWorker(
            {
              passed: false,
              layers: [layerResult],
              duration: layerResult.duration,
              projectConfig: project.config,
              summary: layerResult.summary,
            },
            layerResult.layer
          );
          console.error(detail);
          
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
        return this.runTypeCheck(workDir, projectConfig, startTime, options);
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
    startTime: number,
    options: VerificationOptions
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
      changedFiles: options.changedFiles,
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
          
          const hasJs = fileList.some(f => /\.js$/.test(f));
          const hasJsx = fileList.some(f => /\.jsx$/.test(f));
          const hasTs = fileList.some(f => /\.ts$/.test(f));
          const hasTsx = fileList.some(f => /\.tsx$/.test(f));
          
          if ((hasJs || hasJsx) && (hasTs || hasTsx)) {
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
          if (hasTs && hasTsx) {
            const tsFile = fileList.find(f => /\.ts$/.test(f));
            const tsxFile = fileList.find(f => /\.tsx$/.test(f));
            if (tsFile && tsxFile) {
              errors.push({
                file: join(dir, tsFile),
                message: `FILE CONFLICT: Both '${tsFile}' and '${tsxFile}' exist in ${dirName}/. ` +
                  `TypeScript module resolution may pick the wrong entry. ` +
                  `DELETE the unused file so only one entry remains.`,
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
   * P11: Entrypoint consistency checks for Vite/React projects
   * - index.html must reference the correct entry file
   * - React projects should not keep vanilla Vite scaffold (main.ts + counter.ts)
   */
  private checkEntrypointConsistency(workDir: string): VerificationError[] {
    const errors: VerificationError[] = [];
    const indexPath = join(workDir, 'index.html');
    if (!existsSync(indexPath)) return errors;

    let indexHtml = '';
    try {
      indexHtml = readFileSync(indexPath, 'utf-8');
    } catch {
      return errors;
    }

    const entryMatch = indexHtml.match(/<script[^>]+src=["']\/src\/(main\.(?:ts|tsx|js|jsx))["'][^>]*><\/script>/i);
    const rootMatch = indexHtml.match(/<div[^>]+id=["']([^"']+)["']/i);
    const entryFile = entryMatch?.[1];
    const rootId = rootMatch?.[1];

    const mainTsPath = join(workDir, 'src', 'main.ts');
    const mainTsxPath = join(workDir, 'src', 'main.tsx');
    const hasMainTs = existsSync(mainTsPath);
    const hasMainTsx = existsSync(mainTsxPath);
    const counterTsPath = join(workDir, 'src', 'counter.ts');
    const hasCounterTs = existsSync(counterTsPath);

    const pkgPath = join(workDir, 'package.json');
    let isReactProject = false;
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        isReactProject = Boolean(deps?.react || deps?.['react-dom']);
      } catch {
        // ignore
      }
    }

    let mainTsContent = '';
    if (hasMainTs) {
      try {
        mainTsContent = readFileSync(mainTsPath, 'utf-8');
      } catch {
        // ignore
      }
    }
    const looksLikeViteScaffold =
      mainTsContent.includes('setupCounter') ||
      mainTsContent.includes('Vite + TypeScript') ||
      mainTsContent.includes('#app');

    if (entryFile && entryFile.endsWith('.ts') && hasMainTsx) {
      errors.push({
        file: indexPath,
        message: `ENTRYPOINT MISMATCH: index.html references ${entryFile} but src/main.tsx exists. ` +
          `Update index.html to use main.tsx or remove the unused entry file.`,
        severity: 'error',
      });
    }

    if (isReactProject && hasMainTs && hasMainTsx) {
      errors.push({
        file: mainTsPath,
        message: 'ENTRYPOINT CONFLICT: React project has both src/main.ts and src/main.tsx. ' +
          'Remove the unused vanilla Vite entry (main.ts) to avoid confusion.',
        severity: 'error',
      });
    }

    if (isReactProject && (looksLikeViteScaffold || hasCounterTs)) {
      errors.push({
        file: mainTsPath,
        message: 'VITE SCAFFOLD LEFTOVER: React project still contains vanilla Vite scaffold (main.ts/counter.ts). ' +
          'Delete the scaffold files and keep the React entry only.',
        severity: 'error',
      });
    }

    if (rootId === 'root' && looksLikeViteScaffold) {
      errors.push({
        file: mainTsPath,
        message: 'ROOT ID MISMATCH: index.html uses #root but src/main.ts still targets #app. ' +
          'Remove the unused Vite scaffold or align the entry file.',
        severity: 'error',
      });
    }

    return errors;
  }

  private checkProjectBoundaryViolations(
    workDir: string,
    detectedProjects: { path: string; config: ProjectConfig }[],
    changedFiles?: string[]
  ): VerificationError[] {
    const errors: VerificationError[] = [];
    if (detectedProjects.length === 0) return errors;

    const normalizedWorkDir = resolve(workDir);
    const rootIsProject = detectedProjects.some((project) => resolve(project.path) === normalizedWorkDir);
    if (rootIsProject) return errors;

    const sourceRoots = new Set(['src', 'app', 'pages', 'components', 'lib']);
    const isWithinProject = (filePath: string) =>
      detectedProjects.some((project) => {
        const rel = relative(resolve(project.path), filePath);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      });

    if (changedFiles && changedFiles.length > 0) {
      for (const file of changedFiles) {
        const absoluteFile = isAbsolute(file) ? resolve(file) : resolve(workDir, file);
        const relToRoot = relative(normalizedWorkDir, absoluteFile);
        if (relToRoot.startsWith('..') || relToRoot === '') continue;
        if (isWithinProject(absoluteFile)) continue;
        const top = relToRoot.split(/[\\/]/)[0];
        if (!top || !sourceRoots.has(top)) continue;
        errors.push({
          file: absoluteFile,
          message:
            `PROJECT BOUNDARY: "${top}" was written at workspace root, ` +
            `but no root project exists. Move this file under a detected project (e.g., ${detectedProjects.map(p => p.path).join(', ')}).`,
          severity: 'error',
        });
      }
      return errors;
    }

    // No changedFiles info: detect root-level source trees when workspace is not a project root.
    for (const dirName of sourceRoots) {
      const candidate = join(workDir, dirName);
      if (!existsSync(candidate)) continue;
      errors.push({
        file: candidate,
        message:
          `PROJECT BOUNDARY: "${dirName}" exists at workspace root, ` +
          `but no root project was detected. Keep source under detected project roots instead.`,
        severity: 'error',
      });
    }

    return errors;
  }

  private checkTestFrameworkConsistency(workDir: string, config: ProjectConfig): VerificationError[] {
    const errors: VerificationError[] = [];
    const packageJsonPath = join(workDir, 'package.json');
    if (!existsSync(packageJsonPath)) return errors;

    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
    try {
      pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    } catch {
      return errors;
    }
    if (!pkg) return errors;

    const scripts = pkg.scripts ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scriptText = Object.values(scripts).join(' ').toLowerCase();
    const hasVitest = scriptText.includes('vitest') || Boolean(deps.vitest);
    const hasJest = scriptText.includes('jest') || Boolean(deps.jest);
    const hasJestConfig =
      existsSync(join(workDir, 'jest.config.js')) ||
      existsSync(join(workDir, 'jest.config.cjs')) ||
      existsSync(join(workDir, 'jest.config.mjs')) ||
      existsSync(join(workDir, 'jest.config.ts'));

    if (hasVitest && hasJest) {
      errors.push({
        file: packageJsonPath,
        message:
          'TEST FRAMEWORK CONFLICT: Both Vitest and Jest are configured. Use a single framework (Vitest only) and remove Jest scripts/deps/config.',
        severity: 'error',
      });
      return errors;
    }

    if ((config.testFramework === 'vitest' || hasVitest) && hasJestConfig) {
      errors.push({
        file: packageJsonPath,
        message:
          'TEST FRAMEWORK CONFLICT: Jest config detected in a Vitest project. Remove jest.config.* or switch entirely to Jest.',
        severity: 'error',
      });
    }

    return errors;
  }

  /**
   * P10: Fail if forbidden __tests__ directories exist (even empty)
   */
  private checkForbiddenTestDirs(workDir: string): VerificationError[] {
    const errors: VerificationError[] = [];
    const sourceDirs = ['src', 'app', 'pages', 'lib', 'components'];
    const MAX_DIRS_PER_DIR = 200;
    const MAX_DEPTH = 4;

    const record = (dirPath: string) => {
      errors.push({
        file: dirPath,
        message: `FORBIDDEN DIRECTORY: "__tests__" is not allowed. Tests must be co-located with source files.`,
        severity: 'error',
      });
    };

    const scan = (currentDir: string, depth: number, visited: { count: number }) => {
      if (depth <= 0 || visited.count >= MAX_DIRS_PER_DIR) return;
      try {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (visited.count >= MAX_DIRS_PER_DIR) break;
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(currentDir, entry.name);
          visited.count += 1;
          if (entry.name === '__tests__') {
            record(fullPath);
            continue;
          }
          scan(fullPath, depth - 1, visited);
        }
      } catch {
        // Ignore errors
      }
    };

    // Check root-level __tests__
    const rootTestsDir = join(workDir, '__tests__');
    if (existsSync(rootTestsDir)) {
      record(rootTestsDir);
    }

    for (const dirName of sourceDirs) {
      const dir = join(workDir, dirName);
      if (!existsSync(dir)) continue;
      scan(dir, MAX_DEPTH, { count: 0 });
    }

    return errors;
  }

  /**
   * P10: Detect duplicate test suffixes (e.g., .test.test.tsx)
   */
  private checkDuplicateTestSuffixes(workDir: string): VerificationError[] {
    const errors: VerificationError[] = [];
    const sourceDirs = ['src', 'app', 'pages', 'lib', 'components'];
    const MAX_FILES_PER_DIR = 500;
    const duplicatePattern = /(?:\.test|\.spec){2}(\.|$)/i;

    for (const dirName of sourceDirs) {
      const dir = join(workDir, dirName);
      if (!existsSync(dir)) continue;

      try {
        const files = this.scanDirForConflicts(dir, 3, MAX_FILES_PER_DIR);
        for (const file of files) {
          if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
          if (!duplicatePattern.test(file)) continue;
          errors.push({
            file: join(dir, file),
            message: `DUPLICATE TEST SUFFIX: "${file}" contains repeated ".test"/".spec". Use a single suffix (e.g., Component.test.tsx).`,
            severity: 'error',
          });
        }
      } catch {
        // Ignore errors
      }
    }

    return errors;
  }

  /**
   * P12: Ensure Testing Library setup when toBeInTheDocument is used.
   */
  private checkTestingLibrarySetup(workDir: string): VerificationError[] {
    const errors: VerificationError[] = [];
    const testFiles = this.findTestFiles(workDir, 4, 400);
    if (testFiles.length === 0) return errors;

    let usesDomMatchers = false;
    for (const file of testFiles) {
      try {
        const content = readFileSync(file, 'utf-8');
        if (content.includes('toBeInTheDocument')) {
          usesDomMatchers = true;
          break;
        }
      } catch {
        // ignore read errors
      }
    }
    if (!usesDomMatchers) return errors;

    const tsconfigPath = join(workDir, 'tsconfig.json');
    const tsconfigTypes = this.readTsconfigTypes(tsconfigPath);
    if (!tsconfigTypes.includes('@testing-library/jest-dom')) {
      errors.push({
        file: tsconfigPath,
        message:
          'TEST SETUP: toBeInTheDocument is used but tsconfig.json is missing "@testing-library/jest-dom" in compilerOptions.types.',
        severity: 'error',
      });
    }

    const setupFile = this.findTestSetupFile(workDir);
    if (!setupFile) {
      errors.push({
        file: join(workDir, 'src'),
        message:
          'TEST SETUP: toBeInTheDocument is used but no test setup file was found (expected src/test-setup.ts). Add it and import "@testing-library/jest-dom".',
        severity: 'error',
      });
      return errors;
    }

    try {
      const setupContent = readFileSync(setupFile, 'utf-8');
      if (!setupContent.includes('@testing-library/jest-dom')) {
        errors.push({
          file: setupFile,
          message:
            'TEST SETUP: Test setup file must import "@testing-library/jest-dom" to register DOM matchers.',
          severity: 'error',
        });
      }
    } catch {
      errors.push({
        file: setupFile,
        message:
          'TEST SETUP: Unable to read test setup file to verify jest-dom import.',
        severity: 'error',
      });
    }

    return errors;
  }

  private findTestFiles(workDir: string, maxDepth: number, maxFiles: number): string[] {
    const results: string[] = [];
    const baseDirs = ['src', 'app', 'pages', 'components', 'lib'];

    const scan = (dir: string, depth: number): void => {
      if (depth <= 0 || results.length >= maxFiles) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxFiles) break;
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            scan(fullPath, depth - 1);
          } else if (entry.isFile()) {
            if (/\.test\.(ts|tsx|js|jsx)$/.test(entry.name)) {
              results.push(fullPath);
            }
          }
        }
      } catch {
        // ignore
      }
    };

    for (const dirName of baseDirs) {
      const dir = join(workDir, dirName);
      if (!existsSync(dir)) continue;
      scan(dir, maxDepth);
    }

    return results;
  }

  private readTsconfigTypes(tsconfigPath: string): string[] {
    if (!existsSync(tsconfigPath)) return [];
    try {
      const raw = readFileSync(tsconfigPath, 'utf-8');
      const sanitized = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const parsed = JSON.parse(sanitized) as { compilerOptions?: { types?: string[] } };
      const types = parsed.compilerOptions?.types;
      return Array.isArray(types) ? types : [];
    } catch {
      return [];
    }
  }

  private findTestSetupFile(workDir: string): string | null {
    const candidates = [
      join(workDir, 'src', 'test-setup.ts'),
      join(workDir, 'src', 'test-setup.tsx'),
      join(workDir, 'src', 'test', 'setup.ts'),
      join(workDir, 'src', 'test', 'setup.tsx'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
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
    if (result.exitCode !== 0 && this.isEslintConfigError(result.output)) {
      return {
        layer: 'lint',
        passed: true,
        errors: [],
        warnings: [{
          file: workDir,
          line: 0,
          column: 0,
          message: 'Lint skipped: ESLint configuration not found or incompatible with version.',
          severity: 'warning',
        }],
        command: projectConfig.lintCommand,
        duration: Date.now() - startTime,
        output: result.output,
        summary: 'Lint skipped due to missing/incompatible ESLint config',
      };
    }

    const errors = result.exitCode !== 0
      ? this.parseEslintErrors(result.output)
      : [];
    
    // Fallback: if lint failed but no errors parsed, include raw output as error
    if (result.exitCode !== 0 && errors.length === 0) {
      errors.push({
        file: workDir,
        line: 0,
        column: 0,
        message: `Lint failed with exit code ${result.exitCode}. Output: ${result.output.slice(0, 500)}`,
        severity: 'error',
      });
    }

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
      ...(options.requireDataFetch !== undefined ? { requireDataFetch: options.requireDataFetch } : {}),
      ...(options.minSuccessfulFetches !== undefined ? { minSuccessfulFetches: options.minSuccessfulFetches } : {}),
      ...(options.requiredSelectors ? { requiredSelectors: options.requiredSelectors } : {}),
    };
    
    if (port !== undefined) {
      smokeConfig.port = port;
    }
    
    if (options.devServerUrl) {
      smokeConfig.urls = [options.devServerUrl];
    }

    const result = await this.smokeGateService.check(smokeConfig);
    const fetchFailures = result.fetchSummary?.failures ?? [];
    const fetchErrors = fetchFailures.map((failure) => {
      const status = failure.status !== undefined ? ` status=${failure.status}` : '';
      const method = failure.method ? ` ${failure.method}` : '';
      const error = failure.error ? ` error=${failure.error}` : '';
      return {
        message: `Fetch failure: ${failure.url}${method}${status}${error}`,
        severity: 'error' as const,
      };
    });

    return {
      layer: 'smoke',
      passed: result.passed,
      errors: result.error ? [{ message: result.error, severity: 'error' as const }] :
              result.consoleErrors.map(msg => ({ message: msg, severity: 'error' as const }))
              .concat(result.missingSelectors.map(sel => ({ message: `Missing selector: ${sel}`, severity: 'error' as const })))
              .concat(fetchErrors),
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

  private isEslintConfigError(output: string): boolean {
    const normalized = output.toLowerCase();
    return (
      normalized.includes("eslint couldn't find a configuration file") ||
      normalized.includes("eslint couldn't find an eslint.config") ||
      normalized.includes('failed to load config') ||
      normalized.includes('configuration file')
    );
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

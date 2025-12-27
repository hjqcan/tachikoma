/**
 * ProjectDetector Service
 * 
 * Auto-detects project type, build commands, test framework, and type checker
 * based on project files and package.json configuration.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// =============================================================================
// Types
// =============================================================================

export interface ProjectConfig {
  /** Detected project type */
  projectType: 'typescript' | 'javascript' | 'python' | 'unknown';
  
  /** Type check command (e.g., 'npx tsc --noEmit', 'npx pyright') */
  typeCheckCommand: string | null;
  
  /** Build command (e.g., 'npm run build', 'vite build') */
  buildCommand: string | null;
  
  /** Test command (e.g., 'vitest run', 'jest', 'bun test') */
  testCommand: string | null;
  
  /** Test framework name for logging */
  testFramework: 'vitest' | 'jest' | 'bun' | 'pytest' | 'mocha' | 'npm' | null;
  
  /** Dev server command (e.g., 'npm run dev') */
  devCommand: string | null;

  /** Lint command (e.g., 'npx eslint .') */
  lintCommand: string | null;

  /** Dependency install command (e.g., 'npm install') */
  installCommand: string | null;
  
  /** Whether project has TypeScript config */
  hasTypeScript: boolean;
  
  /** Whether project uses ESLint */
  hasEslint: boolean;
  
  /** Package manager detected */
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' | null;
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

// =============================================================================
// ProjectDetector
// =============================================================================

export class ProjectDetector {
  /**
   * Detect project configuration from the given directory
   */
  async detect(workDir: string): Promise<ProjectConfig> {
    const packageJson = await this.readPackageJson(workDir);
    
    const projectType = this.detectProjectType(workDir, packageJson);
    const packageManager = this.detectPackageManager(workDir, packageJson);
    const hasTypeScript = existsSync(join(workDir, 'tsconfig.json'));
    const hasEslint = this.detectEslint(workDir, packageJson);
    
    return {
      projectType,
      typeCheckCommand: this.detectTypeChecker(workDir, packageJson, projectType, packageManager),
      buildCommand: this.detectBuildCommand(packageJson, packageManager),
      testCommand: this.detectTestCommand(packageJson, packageManager),
      testFramework: this.detectTestFramework(packageJson),
      devCommand: this.detectDevCommand(packageJson, packageManager),
      lintCommand: hasEslint ? this.getExecCommand(packageManager, 'eslint . --ext .ts,.tsx,.js,.jsx') : null,
      installCommand: packageJson ? this.getInstallCommand(packageManager) : null,
      hasTypeScript,
      hasEslint,
      packageManager,
    };
  }

  /**
   * Read and parse package.json
   */
  private async readPackageJson(workDir: string): Promise<PackageJson | null> {
    const pkgPath = join(workDir, 'package.json');
    if (!existsSync(pkgPath)) {
      return null;
    }
    
    try {
      const content = await readFile(pkgPath, 'utf-8');
      return JSON.parse(content) as PackageJson;
    } catch {
      return null;
    }
  }

  /**
   * Detect project type
   */
  private detectProjectType(
    workDir: string,
    packageJson: PackageJson | null
  ): ProjectConfig['projectType'] {
    // TypeScript
    if (existsSync(join(workDir, 'tsconfig.json'))) {
      return 'typescript';
    }
    
    // Python
    if (
      existsSync(join(workDir, 'requirements.txt')) ||
      existsSync(join(workDir, 'pyproject.toml')) ||
      existsSync(join(workDir, 'setup.py'))
    ) {
      return 'python';
    }
    
    // JavaScript (has package.json but no tsconfig)
    if (packageJson) {
      return 'javascript';
    }
    
    return 'unknown';
  }

  /**
   * Detect package manager
   */
  private detectPackageManager(
    workDir: string,
    packageJson: PackageJson | null
  ): ProjectConfig['packageManager'] {
    // Check packageManager field in package.json
    if (packageJson?.packageManager) {
      if (packageJson.packageManager.startsWith('pnpm')) return 'pnpm';
      if (packageJson.packageManager.startsWith('yarn')) return 'yarn';
      if (packageJson.packageManager.startsWith('bun')) return 'bun';
      if (packageJson.packageManager.startsWith('npm')) return 'npm';
    }
    
    // Check lock files
    if (existsSync(join(workDir, 'bun.lockb')) || existsSync(join(workDir, 'bun.lock'))) {
      return 'bun';
    }
    if (existsSync(join(workDir, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (existsSync(join(workDir, 'yarn.lock'))) {
      return 'yarn';
    }
    if (existsSync(join(workDir, 'package-lock.json'))) {
      return 'npm';
    }
    
    return packageJson ? 'npm' : null;
  }

  /**
   * Detect type checker command
   */
  private detectTypeChecker(
    workDir: string,
    packageJson: PackageJson | null,
    projectType: ProjectConfig['projectType'],
    packageManager: ProjectConfig['packageManager']
  ): string | null {
    // TypeScript
    if (projectType === 'typescript' || existsSync(join(workDir, 'tsconfig.json'))) {
      return this.getExecCommand(packageManager, 'tsc --noEmit');
    }
    
    // Python with pyright
    if (existsSync(join(workDir, 'pyrightconfig.json'))) {
      return this.getExecCommand(packageManager, 'pyright');
    }
    
    // Python with mypy
    if (
      existsSync(join(workDir, 'mypy.ini')) ||
      existsSync(join(workDir, '.mypy.ini')) ||
      existsSync(join(workDir, 'setup.cfg'))
    ) {
      return 'python -m mypy .';
    }
    
    // JavaScript with ESLint (as a fallback type-ish check)
    if (projectType === 'javascript' && this.detectEslint(workDir, packageJson)) {
      return this.getExecCommand(packageManager, 'eslint . --ext .js,.jsx');
    }
    
    return null;
  }

  /**
   * Detect ESLint presence
   */
  private detectEslint(workDir: string, packageJson: PackageJson | null): boolean {
    if (
      existsSync(join(workDir, '.eslintrc.json')) ||
      existsSync(join(workDir, '.eslintrc.js')) ||
      existsSync(join(workDir, '.eslintrc.cjs')) ||
      existsSync(join(workDir, '.eslintrc.yaml')) ||
      existsSync(join(workDir, 'eslint.config.js')) ||
      existsSync(join(workDir, 'eslint.config.mjs'))
    ) {
      return true;
    }
    
    const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
    return Boolean(deps?.eslint);
  }

  /**
   * Detect build command
   */
  private detectBuildCommand(
    packageJson: PackageJson | null,
    packageManager: ProjectConfig['packageManager']
  ): string | null {
    const scripts = packageJson?.scripts;
    if (!scripts) return null;
    
    // Common build script names
    if (scripts.build) return this.getRunCommand(packageManager, 'build');
    if (scripts['build:prod']) return this.getRunCommand(packageManager, 'build:prod');
    if (scripts['build:production']) return this.getRunCommand(packageManager, 'build:production');
    
    return null;
  }

  /**
   * Detect test framework
   */
  private detectTestFramework(packageJson: PackageJson | null): ProjectConfig['testFramework'] {
    const scripts = packageJson?.scripts;
    const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
    
    // Check test script content
    const testScript = scripts?.test ?? '';
    
    if (testScript.includes('vitest') || deps?.vitest) {
      return 'vitest';
    }
    if (testScript.includes('jest') || deps?.jest) {
      return 'jest';
    }
    if (testScript.includes('bun test') || testScript.includes('bun:test')) {
      return 'bun';
    }
    if (testScript.includes('mocha') || deps?.mocha) {
      return 'mocha';
    }
    if (deps?.pytest) {
      return 'pytest';
    }
    
    // Has test script but unknown framework
    if (scripts?.test) {
      return 'npm';
    }
    
    return null;
  }

  /**
   * Detect test command
   */
  private detectTestCommand(
    packageJson: PackageJson | null,
    packageManager: ProjectConfig['packageManager']
  ): string | null {
    const scripts = packageJson?.scripts;
    if (!scripts?.test) return null;
    
    const testScript = scripts.test;
    
    // Vitest - prefer direct command for better output
    if (testScript.includes('vitest')) {
      return this.getExecCommand(packageManager, 'vitest run');
    }
    
    // Jest - add passWithNoTests to avoid failure on new projects
    if (testScript.includes('jest')) {
      return this.getExecCommand(packageManager, 'jest --passWithNoTests');
    }
    
    // Bun test
    if (testScript.includes('bun test') || packageManager === 'bun') {
      return 'bun test';
    }
    
    // Mocha
    if (testScript.includes('mocha')) {
      return this.getExecCommand(packageManager, 'mocha');
    }
    
    // Fallback to npm test
    return this.getRunCommand(packageManager, 'test');
  }

  /**
   * Detect dev server command
   */
  private detectDevCommand(
    packageJson: PackageJson | null,
    packageManager: ProjectConfig['packageManager']
  ): string | null {
    const scripts = packageJson?.scripts;
    if (!scripts) return null;
    
    // Common dev script names
    if (scripts.dev) return this.getRunCommand(packageManager, 'dev');
    if (scripts.start) return this.getRunCommand(packageManager, 'start');
    if (scripts.serve) return this.getRunCommand(packageManager, 'serve');
    if (scripts['dev:server']) return this.getRunCommand(packageManager, 'dev:server');
    
    return null;
  }

  private getRunCommand(
    packageManager: ProjectConfig['packageManager'],
    script: string
  ): string {
    switch (packageManager) {
      case 'pnpm':
        return `pnpm run ${script}`;
      case 'yarn':
        return `yarn run ${script}`;
      case 'bun':
        return `bun run ${script}`;
      case 'npm':
      default:
        return `npm run ${script}`;
    }
  }

  private getExecCommand(
    packageManager: ProjectConfig['packageManager'],
    command: string
  ): string {
    switch (packageManager) {
      case 'pnpm':
        return `pnpm exec ${command}`;
      case 'yarn':
        return `yarn ${command}`;
      case 'bun':
        return `bunx ${command}`;
      case 'npm':
      default:
        return `npx ${command}`;
    }
  }

  private getInstallCommand(packageManager: ProjectConfig['packageManager']): string {
    switch (packageManager) {
      case 'pnpm':
        return 'pnpm install';
      case 'yarn':
        return 'yarn install';
      case 'bun':
        return 'bun install';
      case 'npm':
      default:
        return 'npm install';
    }
  }
}

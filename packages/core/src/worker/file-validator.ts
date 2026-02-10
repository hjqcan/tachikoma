/**
 * File Validator
 * 
 * Post-validation of created files to enforce code quality rules that prompts alone cannot guarantee.
 * Detects problematic patterns and reports violations for agent to fix.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FileViolation {
  /** Absolute file path */
  file: string;
  /** Rule identifier */
  rule: string;
  /** Human-readable message explaining the violation and how to fix */
  message: string;
  /** Severity level */
  severity: 'error' | 'warning';
}

export interface FileValidationResult {
  /** Whether all files passed validation */
  valid: boolean;
  /** List of detected violations */
  violations: FileViolation[];
  /** User-friendly summary of violations */
  summary: string;
}

/**
 * Validation rules configuration
 */
const VALIDATION_RULES = {
  /**
   * Rule: No __tests__ folders
   * Tests should be co-located with source files (e.g., Button.test.tsx next to Button.tsx)
   * __tests__ folders cause import path issues and are not recommended
   */
  noTestsFolder: {
    id: 'no-tests-folder',
    pattern: /(^|[\\/])__tests__([\\/]|$)/,
    message: (_file: string) => 
      `Test files must be co-located with source files. ` +
      `Move this file next to the component it tests (e.g., Header.test.tsx next to Header.tsx). ` +
      `__tests__ folders break import paths and cause "Failed to resolve import" errors.`,
    severity: 'error' as const,
  },

  /**
   * Rule: No duplicate test suffixes (e.g., .test.test.tsx)
   */
  duplicateTestSuffix: {
    id: 'duplicate-test-suffix',
    pattern: /(?:\.test|\.spec){2}(\.|$)/i,
    message: (_file: string) =>
      `Test files must NOT contain duplicate suffixes like ".test.test" or ".spec.spec". ` +
      `Use a single suffix (e.g., Component.test.tsx).`,
    severity: 'error' as const,
  },
  
  /**
   * Rule: No nested BrowserRouter detection (best effort)
   * Detects if BrowserRouter is imported in files that might be nested
   */
  // This is handled at prompt level, not file validation

  /**
   * Rule: No duplicate Router in main.jsx and App.jsx
   */
  duplicateRouter: {
    id: 'duplicate-router-risk',
    // This rule is context-aware, handled separately
    severity: 'warning' as const,
  },
  
  /**
   * Rule: Test files must use explicit vitest imports
   * Prevents "Cannot find name 'describe'" errors when tsconfig types are missing
   */
  missingVitestImports: {
    id: 'missing-vitest-imports',
    pattern: /\.test\.tsx?$/,
    validateContent: (content: string) => {
      // Check for explicit imports from vitest
      // Allow if it imports from vitest found in the file
      return /import\s+.*from\s+['"]vitest['"]/.test(content);
    },
    message: (_file: string) => 
      `Test files MUST explicitly import test functions from 'vitest'.\n` +
      `Fix: Add \`import { describe, it, expect, vi } from 'vitest';\` at the top.`,
    severity: 'error' as const,
  },

  /**
   * Rule: React tests must use userEvent from testing-library
   * Prevents "Cannot find name 'userEvent'"
   */
  missingUserEventImport: {
    id: 'missing-user-event-import',
    pattern: /\.test\.tsx?$/,
    validateContent: (content: string) => {
      // If content uses userEvent, it must import it
      if (/userEvent\./.test(content)) {
        return /import\s+userEvent\s+from\s+['"]@testing-library\/user-event['"]/.test(content);
      }
      return true;
    },
    message: (_file: string) =>
      `Test uses 'userEvent' but ignores the import.\n` +
      `Fix: Add \`import userEvent from '@testing-library/user-event';\``,
    severity: 'error' as const,
  }
};

const CJS_CONFIG_PATTERN = /(?:^|[\\/])[^\\/]+\.config\.js$/i;
const COMMONJS_SYNTAX_PATTERN = /\bmodule\.exports\b|\bexports\.\w+|\brequire\(/;
const JEST_CONFIG_PATTERN = /(?:^|[\\/])jest\.config\.(?:js|cjs|mjs|ts)$/i;
const ESLINTRC_CJS_PATTERN = /(?:^|[\\/])\.eslintrc\.cjs$/i;
const ESM_EXPORT_PATTERN = /\bexport\s+default\b/;
const TEST_SETUP_PATTERN = /(?:^|[\\/])test-setup\.(?:ts|tsx|js|jsx)$/i;
const JEST_DOM_IMPORT_PATTERN = /@testing-library\/jest-dom/;
const REACT_IMPORT_PATTERN = /import\s+(?:\*\s+as\s+)?React\b[^;]*from\s+['"]react['"]/;
const REACT_USAGE_PATTERN = /\bReact\b/;
const MAX_PACKAGE_SEARCH_DEPTH = 8;
const packageTypeCache = new Map<string, string | null>();
const packageInfoCache = new Map<string, { type: string | null; hasVitest: boolean; hasJest: boolean } | null>();
const tsconfigCache = new Map<string, string | null>();

function findNearestPackageJson(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i < MAX_PACKAGE_SEARCH_DEPTH; i++) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function readPackageInfo(packageJsonPath: string): { type: string | null; hasVitest: boolean; hasJest: boolean } | null {
  const cached = packageInfoCache.get(packageJsonPath);
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      type?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const typeValue = typeof parsed.type === 'string' ? parsed.type : null;
    const scripts = parsed.scripts ?? {};
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    const scriptText = Object.values(scripts).join(' ').toLowerCase();
    const hasVitest = scriptText.includes('vitest') || Boolean(deps.vitest);
    const hasJest = scriptText.includes('jest') || Boolean(deps.jest);
    const info = { type: typeValue, hasVitest, hasJest };
    packageTypeCache.set(packageJsonPath, typeValue);
    packageInfoCache.set(packageJsonPath, info);
    return info;
  } catch {
    packageTypeCache.set(packageJsonPath, null);
    packageInfoCache.set(packageJsonPath, null);
    return null;
  }
}

function isEsmPackage(filePath: string): boolean {
  const pkg = findNearestPackageJson(dirname(filePath));
  if (!pkg) return false;
  return readPackageInfo(pkg)?.type === 'module';
}

function detectCjsConfigInEsm(filePath: string, content: string): FileViolation | null {
  if (!CJS_CONFIG_PATTERN.test(filePath)) return null;
  if (!COMMONJS_SYNTAX_PATTERN.test(content)) return null;
  if (!isEsmPackage(filePath)) return null;
  return {
    file: filePath,
    rule: 'cjs-config-in-esm',
    message:
      'This project uses `"type": "module"` but the config file uses CommonJS (`module.exports`/`require`). ' +
      'Rename the file to `.cjs` or convert it to ESM (`export default`).',
    severity: 'error',
  };
}

function findNearestTsconfig(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i < MAX_PACKAGE_SEARCH_DEPTH; i++) {
    const candidate = join(current, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function readTsconfigJsxMode(tsconfigPath: string): string | null {
  const cached = tsconfigCache.get(tsconfigPath);
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(tsconfigPath, 'utf-8');
    const sanitized = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const parsed = JSON.parse(sanitized) as { compilerOptions?: { jsx?: string } };
    const mode = parsed.compilerOptions?.jsx ?? null;
    tsconfigCache.set(tsconfigPath, mode ?? null);
    return mode ?? null;
  } catch {
    tsconfigCache.set(tsconfigPath, null);
    return null;
  }
}

function isReactAutoRuntime(filePath: string): boolean {
  const tsconfig = findNearestTsconfig(dirname(filePath));
  if (!tsconfig) return false;
  const mode = readTsconfigJsxMode(tsconfig);
  return mode === 'react-jsx' || mode === 'react-jsxdev';
}

function hasUnusedReactImport(content: string): boolean {
  if (!REACT_IMPORT_PATTERN.test(content)) return false;
  const withoutImport = content.replace(REACT_IMPORT_PATTERN, '');
  return !REACT_USAGE_PATTERN.test(withoutImport);
}

function detectTestFrameworkConflict(filePath: string, content: string): FileViolation | null {
  if (!filePath.endsWith('package.json')) return null;
  try {
    const parsed = JSON.parse(content) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = parsed.scripts ?? {};
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    const scriptText = Object.values(scripts).join(' ').toLowerCase();
    const hasVitest = scriptText.includes('vitest') || Boolean(deps.vitest);
    const hasJest = scriptText.includes('jest') || Boolean(deps.jest);
    if (hasVitest && hasJest) {
      return {
        file: filePath,
        rule: 'mixed-test-frameworks',
        message:
          'Test framework conflict: both Vitest and Jest are configured. Use Vitest only; remove Jest scripts/deps/config.',
        severity: 'error',
      };
    }
  } catch {
    return null;
  }
  return null;
}

function detectJestConfigInVitestProject(filePath: string): FileViolation | null {
  if (!JEST_CONFIG_PATTERN.test(filePath)) return null;
  const pkgPath = findNearestPackageJson(dirname(filePath));
  if (!pkgPath) return null;
  const info = readPackageInfo(pkgPath);
  if (!info?.hasVitest) return null;
  return {
    file: filePath,
    rule: 'jest-config-in-vitest-project',
    message:
      'Jest config detected in a Vitest project. Remove Jest config or switch entirely to Vitest.',
    severity: 'error',
  };
}

function detectEslintCjsExportDefault(filePath: string, content: string): FileViolation | null {
  if (!ESLINTRC_CJS_PATTERN.test(filePath)) return null;
  if (!ESM_EXPORT_PATTERN.test(content)) return null;
  return {
    file: filePath,
    rule: 'eslintrc-cjs-export-default',
    message:
      'ESLint CJS config uses ESM syntax. Replace `export default` with `module.exports =` in `.eslintrc.cjs`, or use `eslint.config.js` for ESLint v9.',
    severity: 'error',
  };
}

function detectMissingJestDomInTestSetup(filePath: string, content: string): FileViolation | null {
  if (!TEST_SETUP_PATTERN.test(filePath)) return null;
  if (JEST_DOM_IMPORT_PATTERN.test(content)) return null;
  return {
    file: filePath,
    rule: 'missing-jest-dom-setup',
    message:
      'Test setup file must import "@testing-library/jest-dom" to register DOM matchers.',
    severity: 'error',
  };
}

/**
 * Validate a single file's content against quality rules
 */
export function validateFileContent(filePath: string, content: string): FileViolation[] {
  const violations: FileViolation[] = [];

  const testFrameworkViolation = detectTestFrameworkConflict(filePath, content);
  if (testFrameworkViolation) {
    violations.push(testFrameworkViolation);
  }

  const jestConfigViolation = detectJestConfigInVitestProject(filePath);
  if (jestConfigViolation) {
    violations.push(jestConfigViolation);
  }

  const eslintCjsViolation = detectEslintCjsExportDefault(filePath, content);
  if (eslintCjsViolation) {
    violations.push(eslintCjsViolation);
  }

  const jestDomSetupViolation = detectMissingJestDomInTestSetup(filePath, content);
  if (jestDomSetupViolation) {
    violations.push(jestDomSetupViolation);
  }

  const cjsConfigViolation = detectCjsConfigInEsm(filePath, content);
  if (cjsConfigViolation) {
    violations.push(cjsConfigViolation);
  }

  if (isReactAutoRuntime(filePath) && hasUnusedReactImport(content)) {
    violations.push({
      file: filePath,
      rule: 'unused-react-import',
      message:
        'Unused React import detected. With `jsx: react-jsx`, remove `import React` or convert to type-only imports.',
      severity: 'error',
    });
  }

  // Check Missing Vitest Imports
  if (VALIDATION_RULES.missingVitestImports.pattern.test(filePath)) {
    if (!VALIDATION_RULES.missingVitestImports.validateContent(content)) {
      violations.push({
        file: filePath,
        rule: VALIDATION_RULES.missingVitestImports.id,
        message: VALIDATION_RULES.missingVitestImports.message(filePath),
        severity: VALIDATION_RULES.missingVitestImports.severity,
      });
    }
  }

  // Check Missing UserEvent Import
  if (VALIDATION_RULES.missingUserEventImport.pattern.test(filePath)) {
    if (!VALIDATION_RULES.missingUserEventImport.validateContent(content)) {
      violations.push({
        file: filePath,
        rule: VALIDATION_RULES.missingUserEventImport.id,
        message: VALIDATION_RULES.missingUserEventImport.message(filePath),
        severity: VALIDATION_RULES.missingUserEventImport.severity,
      });
    }
  }

  return violations;
}

/**
 * Validate a list of created files for problematic patterns
 */
export function validateCreatedFiles(files: string[]): FileValidationResult {
  const violations: FileViolation[] = [];
  
  for (const file of files) {
    // Rule 1: No __tests__ folders
    if (VALIDATION_RULES.noTestsFolder.pattern.test(file)) {
      violations.push({
        file,
        rule: VALIDATION_RULES.noTestsFolder.id,
        message: VALIDATION_RULES.noTestsFolder.message(file),
        severity: VALIDATION_RULES.noTestsFolder.severity,
      });
    }
    // Rule 2: No duplicate test suffixes
    if (VALIDATION_RULES.duplicateTestSuffix.pattern.test(file)) {
      violations.push({
        file,
        rule: VALIDATION_RULES.duplicateTestSuffix.id,
        message: VALIDATION_RULES.duplicateTestSuffix.message(file),
        severity: VALIDATION_RULES.duplicateTestSuffix.severity,
      });
    }
  }
  
  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');
  
  const summary = errors.length > 0
    ? `${errors.length} file validation error(s). Fix the violations before proceeding.`
    : warnings.length > 0
      ? `${warnings.length} file validation warning(s).`
      : 'All files passed validation.';
  
  return {
    valid: errors.length === 0,
    violations,
    summary,
  };
}

/**
 * Format violations for display to the agent
 */
export function formatViolationsForAgent(result: FileValidationResult): string {
  if (result.valid && result.violations.length === 0) {
    return '';
  }
  
  const lines: string[] = [];
  lines.push('## File Validation Errors');
  lines.push('');
  lines.push('The following files violate code quality rules and must be fixed:');
  lines.push('');
  
  for (const violation of result.violations) {
    lines.push(`### ${violation.severity.toUpperCase()}: ${violation.file}`);
    lines.push(`**Rule**: ${violation.rule}`);
    lines.push(`**Fix**: ${violation.message}`);
    lines.push('');
  }
  
  lines.push('---');
  lines.push('Please fix these issues before proceeding.');
  
  return lines.join('\n');
}

/**
 * Check if a single file path violates test location rules
 */
export function isTestInForbiddenLocation(filePath: string): boolean {
  return VALIDATION_RULES.noTestsFolder.pattern.test(filePath);
}

/**
 * Check if a file path has duplicate test suffixes (e.g., .test.test.tsx)
 */
export function hasDuplicateTestSuffix(filePath: string): boolean {
  return VALIDATION_RULES.duplicateTestSuffix.pattern.test(filePath);
}

/**
 * Remove duplicate test suffixes from a file path
 */
export function dedupeTestSuffix(filePath: string): string {
  return filePath.replace(/(\.test|\.spec)\.(test|spec)/gi, '$1');
}

/**
 * Suggest correct test file location
 */
export function suggestTestLocation(componentPath: string): string {
  // Given: src/components/Header.tsx
  // Returns: src/components/Header.test.tsx
  const ext = componentPath.match(/\.(tsx?|jsx?)$/)?.[0] ?? '.ts';
  const basePath = componentPath.replace(/\.(tsx?|jsx?)$/, '');
  return `${basePath}.test${ext}`;
}

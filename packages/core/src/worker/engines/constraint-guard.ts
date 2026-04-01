import { basename, extname } from 'node:path';

export interface ConstraintPolicy {
  allowedLanguages: Set<string>;
  disallowedLanguages: Set<string>;
  allowedFrontendFamilies: Set<string>;
  disallowedFrontendFamilies: Set<string>;
  allowedCssFamilies: Set<string>;
  disallowedCssFamilies: Set<string>;
  allowedBackendFamilies: Set<string>;
  disallowedBackendFamilies: Set<string>;
}

export interface ConstraintConflict {
  category: string;
  values: string[];
  message: string;
}

export interface ConstraintViolation {
  category: string;
  detected: string;
  allowed: string[];
  message: string;
}

const LANGUAGE_FAMILY: Record<string, string> = {
  javascript: 'js',
  typescript: 'js',
  python: 'python',
  go: 'go',
  java: 'java',
  csharp: 'dotnet',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
};

const FRONTEND_RULES = [
  { keywords: ['react', 'next.js', 'nextjs', 'remix', 'gatsby'], family: 'react' },
  { keywords: ['vue', 'nuxt', 'nuxt.js'], family: 'vue' },
  { keywords: ['svelte', 'sveltekit'], family: 'svelte' },
  { keywords: ['angular'], family: 'angular' },
  { keywords: ['solid', 'solidjs', 'solid.js'], family: 'solid' },
  { keywords: ['astro'], family: 'astro' },
] as const;

const CSS_RULES = [
  { keywords: ['tailwind', 'tailwindcss'], family: 'tailwind' },
  { keywords: ['bootstrap'], family: 'bootstrap' },
  { keywords: ['bulma'], family: 'bulma' },
  { keywords: ['antd', 'ant design'], family: 'antd' },
  { keywords: ['mui', 'material ui', 'material-ui'], family: 'mui' },
  { keywords: ['chakra', 'chakra ui'], family: 'chakra' },
  { keywords: ['daisyui', 'daisy ui'], family: 'daisyui' },
] as const;

const BACKEND_RULES = [
  { keywords: ['fastapi'], family: 'python', language: 'python' },
  { keywords: ['flask'], family: 'python', language: 'python' },
  { keywords: ['django'], family: 'python', language: 'python' },
  { keywords: ['express'], family: 'node', language: 'javascript' },
  { keywords: ['fastify'], family: 'node', language: 'javascript' },
  { keywords: ['koa'], family: 'node', language: 'javascript' },
  { keywords: ['nest', 'nestjs'], family: 'node', language: 'typescript' },
  { keywords: ['spring', 'spring boot', 'springboot'], family: 'java', language: 'java' },
  { keywords: ['gin', 'golang'], family: 'go', language: 'go' },
  { keywords: ['dotnet', '.net', 'asp.net'], family: 'dotnet', language: 'csharp' },
] as const;

const LANGUAGE_RULES = [
  { keywords: ['python'], language: 'python' },
  { keywords: ['typescript', 'ts'], language: 'typescript' },
  { keywords: ['javascript', 'js'], language: 'javascript' },
  { keywords: ['golang', 'go'], language: 'go' },
  { keywords: ['java'], language: 'java' },
  { keywords: ['c#', 'csharp', 'c sharp'], language: 'csharp' },
  { keywords: ['rust'], language: 'rust' },
  { keywords: ['ruby'], language: 'ruby' },
  { keywords: ['php'], language: 'php' },
] as const;

const FRONTEND_EXTENSIONS: Record<string, string> = {
  '.jsx': 'react',
  '.tsx': 'react',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
};

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.jsx': 'javascript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.cs': 'csharp',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
};

const PATH_LANGUAGE_HINTS: Record<string, string> = {
  'package.json': 'javascript',
  'package-lock.json': 'javascript',
  'yarn.lock': 'javascript',
  'pnpm-lock.yaml': 'javascript',
  'bun.lock': 'javascript',
  'bun.lockb': 'javascript',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'poetry.lock': 'python',
  'pipfile': 'python',
  'pipfile.lock': 'python',
};

const SHELL_LANGUAGE_PATTERNS: { language: string; pattern: RegExp }[] = [
  { language: 'javascript', pattern: /\b(npm|yarn|pnpm|bun|npx|node|vite|next|nuxt)\b/i },
  { language: 'python', pattern: /\b(python|pip|pip3|poetry|uvicorn|fastapi|pytest)\b/i },
  { language: 'go', pattern: /\b(go\s+(build|run|test|get|mod))\b/i },
  { language: 'rust', pattern: /\b(cargo\s+(build|run|test|fmt|clippy))\b/i },
  { language: 'java', pattern: /\b(mvn|gradle)\b/i },
  { language: 'csharp', pattern: /\b(dotnet)\b/i },
];

const GUARDED_TOOLS = new Set([
  'file_write',
  'apply_patch',
  'replace_between_markers',
  'shell_run',
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsKeyword(text: string, keyword: string): boolean {
  const normalized = text.toLowerCase();
  const key = keyword.toLowerCase();
  if (!key) return false;
  if (/[^a-z0-9]/.test(key)) {
    return normalized.includes(key);
  }
  const pattern = new RegExp(`\\b${escapeRegExp(key)}\\b`, 'i');
  return pattern.test(normalized);
}

function isNegated(text: string, keyword: string): boolean {
  const normalized = text.toLowerCase();
  const key = keyword.toLowerCase();
  const index = normalized.indexOf(key);
  if (index === -1) return false;
  const prefix = normalized.slice(Math.max(0, index - 32), index);
  // IMPORTANT: avoid substring false-positives like "unknown" matching "no"
  return (
    /\b(do not use|don't use|avoid)\b/i.test(prefix) ||
    /\bno\b/i.test(prefix) ||
    /(禁止|不要|不得)/i.test(prefix)
  );
}

function applyRuleMatch(
  policy: ConstraintPolicy,
  target: 'language' | 'frontend' | 'css' | 'backend',
  value: string,
  negated: boolean
): void {
  if (target === 'language') {
    if (negated) policy.disallowedLanguages.add(value);
    else policy.allowedLanguages.add(value);
    return;
  }
  if (target === 'frontend') {
    if (negated) policy.disallowedFrontendFamilies.add(value);
    else policy.allowedFrontendFamilies.add(value);
    return;
  }
  if (target === 'css') {
    if (negated) policy.disallowedCssFamilies.add(value);
    else policy.allowedCssFamilies.add(value);
    return;
  }
  if (target === 'backend') {
    if (negated) policy.disallowedBackendFamilies.add(value);
    else policy.allowedBackendFamilies.add(value);
  }
}

export function deriveConstraintPolicy(constraints: string[]): ConstraintPolicy {
  const policy: ConstraintPolicy = {
    allowedLanguages: new Set(),
    disallowedLanguages: new Set(),
    allowedFrontendFamilies: new Set(),
    disallowedFrontendFamilies: new Set(),
    allowedCssFamilies: new Set(),
    disallowedCssFamilies: new Set(),
    allowedBackendFamilies: new Set(),
    disallowedBackendFamilies: new Set(),
  };

  if (!Array.isArray(constraints)) {
    console.debug('[ConstraintGuard] No constraints provided, returning empty policy');
    return policy;
  }
  
  console.debug('[ConstraintGuard] Deriving policy from constraints:', constraints);

  for (const raw of constraints) {
    if (!raw || typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text) continue;

    for (const rule of FRONTEND_RULES) {
      for (const keyword of rule.keywords) {
        if (!containsKeyword(text, keyword)) continue;
        const negated = isNegated(text, keyword);
        applyRuleMatch(policy, 'frontend', rule.family, negated);
        if (!negated) {
          policy.allowedLanguages.add('javascript');
          policy.allowedLanguages.add('typescript');
        }
      }
    }

    for (const rule of CSS_RULES) {
      for (const keyword of rule.keywords) {
        if (!containsKeyword(text, keyword)) continue;
        const negated = isNegated(text, keyword);
        applyRuleMatch(policy, 'css', rule.family, negated);
      }
    }

    for (const rule of BACKEND_RULES) {
      for (const keyword of rule.keywords) {
        if (!containsKeyword(text, keyword)) continue;
        const negated = isNegated(text, keyword);
        applyRuleMatch(policy, 'backend', rule.family, negated);
        applyRuleMatch(policy, 'language', rule.language, negated);
      }
    }

    for (const rule of LANGUAGE_RULES) {
      for (const keyword of rule.keywords) {
        if (!containsKeyword(text, keyword)) continue;
        const negated = isNegated(text, keyword);
        applyRuleMatch(policy, 'language', rule.language, negated);
      }
    }
  }

  // Log derived policy for debugging
  if (policy.allowedLanguages.size > 0 || policy.allowedFrontendFamilies.size > 0) {
    console.debug('[ConstraintGuard] Derived policy:', {
      allowedLanguages: Array.from(policy.allowedLanguages),
      allowedFrontendFamilies: Array.from(policy.allowedFrontendFamilies),
    });
  }

  return policy;
}

export function detectConstraintConflicts(policy: ConstraintPolicy): ConstraintConflict[] {
  const conflicts: ConstraintConflict[] = [];

  if (policy.allowedFrontendFamilies.size > 1) {
    const values = Array.from(policy.allowedFrontendFamilies);
    conflicts.push({
      category: 'frontend_framework',
      values,
      message: `Multiple frontend frameworks specified: ${values.join(', ')}`,
    });
  }

  if (policy.allowedCssFamilies.size > 1) {
    const values = Array.from(policy.allowedCssFamilies);
    conflicts.push({
      category: 'css_framework',
      values,
      message: `Multiple CSS frameworks specified: ${values.join(', ')}`,
    });
  }

  if (policy.allowedBackendFamilies.size > 1) {
    const values = Array.from(policy.allowedBackendFamilies);
    conflicts.push({
      category: 'backend_framework',
      values,
      message: `Multiple backend frameworks specified: ${values.join(', ')}`,
    });
  }

  const overlaps = [
    { category: 'language', allowed: policy.allowedLanguages, disallowed: policy.disallowedLanguages },
    { category: 'frontend_framework', allowed: policy.allowedFrontendFamilies, disallowed: policy.disallowedFrontendFamilies },
    { category: 'css_framework', allowed: policy.allowedCssFamilies, disallowed: policy.disallowedCssFamilies },
    { category: 'backend_framework', allowed: policy.allowedBackendFamilies, disallowed: policy.disallowedBackendFamilies },
  ];

  for (const entry of overlaps) {
    const both: string[] = [];
    for (const value of entry.allowed) {
      if (entry.disallowed.has(value)) both.push(value);
    }
    if (both.length > 0) {
      conflicts.push({
        category: entry.category,
        values: both,
        message: `Conflicting constraints: ${entry.category} ${both.join(', ')} both required and forbidden`,
      });
    }
  }

  return conflicts;
}

function policyHasRules(policy: ConstraintPolicy): boolean {
  return (
    policy.allowedLanguages.size > 0 ||
    policy.allowedFrontendFamilies.size > 0 ||
    policy.allowedCssFamilies.size > 0 ||
    policy.allowedBackendFamilies.size > 0 ||
    policy.disallowedLanguages.size > 0 ||
    policy.disallowedFrontendFamilies.size > 0 ||
    policy.disallowedCssFamilies.size > 0 ||
    policy.disallowedBackendFamilies.size > 0
  );
}

interface ToolCallSignals {
  languages: Set<string>;
  frontendFamilies: Set<string>;
  cssFamilies: Set<string>;
  backendFamilies: Set<string>;
}

function createEmptySignals(): ToolCallSignals {
  return {
    languages: new Set(),
    frontendFamilies: new Set(),
    cssFamilies: new Set(),
    backendFamilies: new Set(),
  };
}

function inferFromPath(pathValue: string, signals: ToolCallSignals): void {
  const ext = extname(pathValue).toLowerCase();
  const name = basename(pathValue).toLowerCase();

  const languageByPath = PATH_LANGUAGE_HINTS[name];
  if (languageByPath) signals.languages.add(languageByPath);

  const languageByExt = LANGUAGE_EXTENSIONS[ext];
  if (languageByExt) signals.languages.add(languageByExt);

  const frontendFamily = FRONTEND_EXTENSIONS[ext];
  if (frontendFamily) signals.frontendFamilies.add(frontendFamily);
}

function inferFromCommand(command: string, signals: ToolCallSignals): void {
  for (const entry of SHELL_LANGUAGE_PATTERNS) {
    if (entry.pattern.test(command)) {
      signals.languages.add(entry.language);
    }
  }
}

function inferToolSignals(toolName: string, input: unknown): ToolCallSignals | null {
  if (!GUARDED_TOOLS.has(toolName)) {
    return null;
  }

  const signals = createEmptySignals();
  const data = (input && typeof input === 'object') ? (input as Record<string, unknown>) : null;

  if (data && typeof data.path === 'string') {
    inferFromPath(data.path, signals);
  }

  if (toolName === 'shell_run' && data && typeof data.command === 'string') {
    inferFromCommand(data.command, signals);
  }

  const hasSignals =
    signals.languages.size > 0 ||
    signals.frontendFamilies.size > 0 ||
    signals.cssFamilies.size > 0 ||
    signals.backendFamilies.size > 0;
  return hasSignals ? signals : null;
}

function isLanguageAllowed(language: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return true;
  const family = LANGUAGE_FAMILY[language] ?? language;
  const allowedFamilies = new Set(
    Array.from(allowed).map((value) => LANGUAGE_FAMILY[value] ?? value)
  );
  return allowedFamilies.has(family);
}

function buildViolation(
  category: string,
  detected: string,
  allowed: Set<string>,
  message: string
): ConstraintViolation {
  return {
    category,
    detected,
    allowed: Array.from(allowed),
    message,
  };
}

export function checkToolCallAgainstConstraints(
  toolName: string,
  input: unknown,
  policy: ConstraintPolicy
): ConstraintViolation | null {
  if (!policyHasRules(policy)) return null;
  const signals = inferToolSignals(toolName, input);
  if (!signals) return null;

  for (const language of signals.languages) {
    if (policy.disallowedLanguages.has(language)) {
      return buildViolation(
        'language',
        language,
        policy.allowedLanguages,
        `Constraint violation: "${toolName}" implies language "${language}" which is disallowed.`
      );
    }
    if (!isLanguageAllowed(language, policy.allowedLanguages)) {
      return buildViolation(
        'language',
        language,
        policy.allowedLanguages,
        `Constraint violation: "${toolName}" implies language "${language}", but allowed languages are: ${Array.from(policy.allowedLanguages).join(', ') || 'none'}.`
      );
    }
  }

  for (const family of signals.frontendFamilies) {
    if (policy.disallowedFrontendFamilies.has(family)) {
      return buildViolation(
        'frontend_framework',
        family,
        policy.allowedFrontendFamilies,
        `Constraint violation: "${toolName}" implies frontend framework "${family}" which is disallowed.`
      );
    }
    if (policy.allowedFrontendFamilies.size > 0 && !policy.allowedFrontendFamilies.has(family)) {
      return buildViolation(
        'frontend_framework',
        family,
        policy.allowedFrontendFamilies,
        `Constraint violation: "${toolName}" implies frontend framework "${family}", but allowed frameworks are: ${Array.from(policy.allowedFrontendFamilies).join(', ')}.`
      );
    }
  }

  for (const family of signals.cssFamilies) {
    if (policy.disallowedCssFamilies.has(family)) {
      return buildViolation(
        'css_framework',
        family,
        policy.allowedCssFamilies,
        `Constraint violation: "${toolName}" implies CSS framework "${family}" which is disallowed.`
      );
    }
    if (policy.allowedCssFamilies.size > 0 && !policy.allowedCssFamilies.has(family)) {
      return buildViolation(
        'css_framework',
        family,
        policy.allowedCssFamilies,
        `Constraint violation: "${toolName}" implies CSS framework "${family}", but allowed frameworks are: ${Array.from(policy.allowedCssFamilies).join(', ')}.`
      );
    }
  }

  return null;
}

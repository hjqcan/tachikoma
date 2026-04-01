import { createHash } from 'node:crypto';

export type MidExecutionProbeType = 'api' | 'entrypoint' | 'mock';

export interface MidExecutionProbe {
  id: string;
  type: MidExecutionProbeType;
  sourceSubtaskId: string;
  matchedFiles: string[];
  message: string;
  createdAt: number;
}

interface ProbeRule {
  type: MidExecutionProbeType;
  message: string;
  matches: (normalizedPath: string) => boolean;
}

const PROBE_RULES: ProbeRule[] = [
  {
    type: 'api',
    message:
      '检测到你修改了 API 路由/后端入口。请在继续前执行接口可用性验证（health check 或关键接口 smoke test），并在结果中报告。',
    matches: (path) =>
      /(^|\/)(api|apis|route|routes|controller|controllers|backend|server)(\/|$)/.test(path) ||
      /(^|\/)app\/api\//.test(path) ||
      /(^|\/)src\/api\//.test(path),
  },
  {
    type: 'entrypoint',
    message:
      '检测到你修改了应用入口或启动配置。请验证 dev server 可启动，并确认页面/接口健康检查通过。',
    matches: (path) =>
      /(^|\/)(main|app|index)\.(ts|tsx|js|jsx|html)$/.test(path) ||
      /(^|\/)(vite|next|nuxt)\.config\.(ts|js|mjs|cjs)$/.test(path),
  },
  {
    type: 'mock',
    message: '检测到你修改了 mock/fixture 数据。请运行对应测试，确认 mock 行为与断言保持一致。',
    matches: (path) => /(^|\/)(mock|mocks|fixture|fixtures|msw)(\/|$)/.test(path),
  },
];

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').toLowerCase();
}

function buildProbeId(type: MidExecutionProbeType, files: string[]): string {
  const sorted = [...files].sort();
  return createHash('sha1').update(`${type}\n${sorted.join('\n')}`).digest('hex').slice(0, 16);
}

export function detectMidExecutionProbe(
  sourceSubtaskId: string,
  modifiedFiles: string[]
): MidExecutionProbe | null {
  if (modifiedFiles.length === 0) return null;

  const normalized = modifiedFiles
    .map(normalizePath)
    .filter((path) => path.length > 0);
  if (normalized.length === 0) return null;

  for (const rule of PROBE_RULES) {
    const matched = normalized.filter((path) => rule.matches(path));
    if (matched.length === 0) continue;

    return {
      id: buildProbeId(rule.type, matched),
      type: rule.type,
      sourceSubtaskId,
      matchedFiles: matched.slice(0, 8),
      message: rule.message,
      createdAt: Date.now(),
    };
  }

  return null;
}

export function buildMidExecutionProbeConstraint(probe: MidExecutionProbe): string {
  const evidence = probe.matchedFiles.slice(0, 5).join(', ');
  return [
    '[System Observer]',
    probe.message,
    `Probe type: ${probe.type}`,
    evidence ? `Evidence files: ${evidence}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

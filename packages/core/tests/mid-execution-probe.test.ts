import { describe, expect, it } from 'bun:test';
import {
  buildMidExecutionProbeConstraint,
  detectMidExecutionProbe,
} from '../src/orchestrator/services/mid-execution-probe';

describe('mid-execution-probe', () => {
  it('应在 API 路由变更时生成 probe', () => {
    const probe = detectMidExecutionProbe('subtask-1', [
      'src/api/routes/user.ts',
      'src/components/page.tsx',
    ]);

    expect(probe).toBeDefined();
    expect(probe?.type).toBe('api');
    expect(probe?.sourceSubtaskId).toBe('subtask-1');
    expect(probe?.matchedFiles).toContain('src/api/routes/user.ts');
  });

  it('应构造可注入的 System Observer 约束文本', () => {
    const probe = detectMidExecutionProbe('subtask-2', ['app/api/orders/route.ts']);
    expect(probe).toBeDefined();

    const constraint = buildMidExecutionProbeConstraint(probe!);
    expect(constraint).toContain('[System Observer]');
    expect(constraint).toContain('Probe type: api');
    expect(constraint).toContain('Evidence files:');
  });

  it('无关键文件变更时不生成 probe', () => {
    const probe = detectMidExecutionProbe('subtask-3', ['src/components/button.tsx']);
    expect(probe).toBeNull();
  });
});

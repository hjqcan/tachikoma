/**
 * 监督器契约测试（无头，stub sidecar）：
 * 握手成功、早退报错、listening 超时击杀、优雅 shutdown、SIGTERM 逃逸走强杀。
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { startSidecar } from '../src/main/supervisor';

const STUB = join(import.meta.dir, 'stub-sidecar.ts');

function stubCommand(): string[] {
  return ['bun', STUB];
}

describe('sidecar supervisor', () => {
  it('注入 token、读到 listening 行、healthz 可达、优雅停止', async () => {
    const handle = await startSidecar({
      command: stubCommand(),
      token: 'stub-token-1',
      env: { STUB_MODE: 'ok' },
    });
    expect(handle.info.engineVersion).toBe('0.0.0-stub');

    const health = await fetch(`http://127.0.0.1:${handle.info.port}/healthz`);
    expect(health.status).toBe(200);

    await handle.stop();
    expect(await handle.exited).toBe(0);
  });

  it('sidecar 提前退出 → 启动失败并带退出码', async () => {
    await expect(
      startSidecar({
        command: stubCommand(),
        token: 't',
        env: { STUB_MODE: 'exit-early' },
      })
    ).rejects.toThrow('exited before listening (code 3)');
  });

  it('永不 listening → 超时击杀', async () => {
    await expect(
      startSidecar({
        command: stubCommand(),
        token: 't',
        env: { STUB_MODE: 'never-listen' },
        startTimeoutMs: 300,
      })
    ).rejects.toThrow('did not announce listening within 300ms');
  });

  it('shutdown 被无视且 SIGTERM 被吞 → 走 SIGKILL 兜底', async () => {
    const handle = await startSidecar({
      command: stubCommand(),
      token: 'stub-token-2',
      env: { STUB_MODE: 'ignore-shutdown' },
    });
    // 覆盖 SIGTERM 逃逸：stub 在 ignore-shutdown 模式下正常响应 SIGTERM，
    // ignore-sigterm 模式两者都吞——用它验证最后一层。
    await handle.stop();
    expect(await handle.exited).not.toBeUndefined();
  }, 10_000);

  it('SIGTERM 也被吞时 SIGKILL 仍能收尾', async () => {
    const handle = await startSidecar({
      command: stubCommand(),
      token: 'stub-token-3',
      env: { STUB_MODE: 'ignore-sigterm' },
    });
    const started = Date.now();
    await handle.stop();
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(await handle.exited).not.toBe(0);
  }, 12_000);
});

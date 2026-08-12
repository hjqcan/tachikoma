/**
 * Sidecar 监督器（desktop-plan §2.3 的壳侧一半）。
 *
 * 契约：spawn 后把 token 作为 stdin 第一行注入（不走 argv/env），10s 内从 stdout
 * 读到恰好一行 `{"event":"listening",...}`；停止时先 RPC shutdown（预算 2s）、
 * 再 SIGTERM（3s）、最后 SIGKILL。Electron main 是 Node 运行时——本文件只用 node API。
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** stdio: ['pipe', 'pipe', 'inherit'] 的精确子类型（stderr 直通壳日志） */
export type SidecarChild = ChildProcessByStdio<Writable, Readable, null>;

export interface SidecarConfig {
  command: string[];
  token: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** listening 行等待预算，默认 10_000ms */
  startTimeoutMs?: number;
}

export interface ListeningInfo {
  event: 'listening';
  port: number;
  pid: number;
  engineVersion: string;
  protocolVersion: number;
}

export interface SidecarHandle {
  info: ListeningInfo;
  child: SidecarChild;
  /** 进程已退出（任何原因）时兑现 */
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

export async function startSidecar(config: SidecarConfig): Promise<SidecarHandle> {
  const [executable, ...args] = config.command;
  if (!executable) throw new Error('Sidecar command is empty.');
  const child = spawn(executable, args, {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.stdin.write(`${config.token}\n`);

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  const timeoutMs = config.startTimeoutMs ?? 10_000;
  const lines = createInterface({ input: child.stdout });
  const info = await new Promise<ListeningInfo>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`Sidecar did not announce listening within ${timeoutMs}ms.`));
    }, timeoutMs);
    const onLine = (line: string): void => {
      try {
        const parsed = JSON.parse(line) as Partial<ListeningInfo>;
        if (parsed.event === 'listening' && typeof parsed.port === 'number') {
          cleanup();
          resolve(parsed as ListeningInfo);
        }
      } catch {
        // 非 JSON 行忽略（sidecar 只承诺 listening 行是 JSON）
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Sidecar exited before listening (code ${code ?? 'null'}).`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      lines.off('line', onLine);
      child.off('exit', onExit);
    };
    lines.on('line', onLine);
    child.on('exit', onExit);
  });

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    // ① 协议级 shutdown（预算 2s）
    try {
      await fetch(`http://127.0.0.1:${info.port}/v1/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id: 'shutdown', method: 'engine.shutdown', params: {} }),
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // 进入下一层
    }
    const grace = (ms: number): Promise<boolean> =>
      Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);
    if (await grace(2_000)) return;
    // ② SIGTERM（3s）
    child.kill('SIGTERM');
    if (await grace(3_000)) return;
    // ③ 强杀
    child.kill('SIGKILL');
    await exited;
  }

  return { info, child, exited, stop };
}

/**
 * engined 机器面冒烟（真网络，显式运行；不入 verify / 默认测试）：
 *
 *   bun run eval:engined
 *
 * 一次真实穿透 spawn 出的 sidecar 二进制面：stdin token 握手 → listening 行 →
 * engine.hello → session.create → ws-ticket → WS 订阅 → 读文件回合（seq 单调、
 * tool_call、内容带标记）→ 写文件回合（审批经 RPC 放行、落盘核实）→ 二连 WS
 * fromSeq:0 全量重放 → engine.shutdown 限时退出。任一步失败以步名退出 1。
 *
 * 模型选择与 eval:chat 同约定：TACHIKOMA_LIVE_PROVIDER/MODEL 缺省回落
 * TACHIKOMA_PROVIDER/MODEL；models.json 经 TACHIKOMA_LIVE_MODELS_JSON 或
 * ~/.tachikoma/models.json 拷入密封 dataDir。协议机制的离线覆盖归
 * server.test.ts；这里只补"真引擎 + 真二进制"这一条。
 */

import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = `ENGINED-SMOKE-${Date.now()}`;
const WRITE_CONTENT = 'EVAL-WRITE-OK';

/**
 * 失败即抛（绝不直接 process.exit）：exit 会绕过 finally 的 cleanup，
 * 让 engined 孤儿进程持着继承的输出管道，把 `… | tail` 之类的调用方挂死。
 */
class SmokeFailure extends Error {
  constructor(step: string, detail: string) {
    super(`✗ ${step}: ${detail}`);
  }
}

function fail(step: string, detail: string): never {
  throw new SmokeFailure(step, detail);
}

function ok(step: string): void {
  console.log(`✓ ${step}`);
}

function liveModel(): { provider: string; model: string } {
  const provider = process.env.TACHIKOMA_LIVE_PROVIDER ?? process.env.TACHIKOMA_PROVIDER;
  const model = process.env.TACHIKOMA_LIVE_MODEL ?? process.env.TACHIKOMA_MODEL;
  if (!provider || !model) {
    fail(
      'env',
      '需要 TACHIKOMA_LIVE_PROVIDER/TACHIKOMA_LIVE_MODEL（或 TACHIKOMA_PROVIDER/TACHIKOMA_MODEL）。'
    );
  }
  return { provider, model };
}

interface Frame {
  v: number;
  sessionId: string;
  seq: number;
  event: { type: string; [key: string]: unknown };
}

async function main(): Promise<void> {
  const model = liveModel();
  const dataDir = await mkdtemp(join(tmpdir(), 'tachikoma-engined-smoke-data-'));
  const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-engined-smoke-ws-'));
  await writeFile(join(workDir, 'data.txt'), `header\nMARKER: ${MARKER}\nfooter\n`);
  const modelsJson =
    process.env.TACHIKOMA_LIVE_MODELS_JSON ?? join(homedir(), '.tachikoma', 'models.json');
  if (existsSync(modelsJson)) {
    await copyFile(modelsJson, join(dataDir, 'models.json'));
  }

  const token = crypto.randomUUID();
  const child = Bun.spawn(['bun', 'src/engined.ts'], {
    cwd: join(import.meta.dir, '..'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: {
      ...process.env,
      TACHIKOMA_DATA_DIR: dataDir,
      TACHIKOMA_PROVIDER: model.provider,
      TACHIKOMA_MODEL: model.model,
      TACHIKOMA_WORKDIR: workDir,
      TACHIKOMA_TOOLSET: 'coding',
      TACHIKOMA_NO_MEMORY: '1',
    },
  });
  const cleanup = async () => {
    child.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  };

  try {
    // 1. token 握手 + listening 行（10s 预算，supervisor 同款合约）。
    // 超时经 Promise.race 在 await 栈内抛出（timer 回调里直接 throw 是未捕获
    // 异常，会绕过本函数的 finally 清理——正是 SmokeFailure 要防的孤儿挂死）。
    (child.stdin as Bun.FileSink).write(`${token}\n`);
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const readFirstLine = async (): Promise<string> => {
      let buffer = '';
      while (!buffer.includes('\n')) {
        const { value, done } = await reader.read();
        if (done) fail('listening', 'stdout 提前关闭');
        buffer += new TextDecoder().decode(value);
      }
      return buffer;
    };
    let listenBudget: ReturnType<typeof setTimeout> | undefined;
    const buffer = await Promise.race([
      readFirstLine(),
      new Promise<never>((_, reject) => {
        listenBudget = setTimeout(
          () => reject(new SmokeFailure('listening', '10s 内未见 listening 行')),
          10_000
        );
      }),
    ]).finally(() => clearTimeout(listenBudget));
    const listening = JSON.parse(buffer.split('\n')[0] ?? '') as {
      event: string;
      port: number;
      protocolVersion: number;
    };
    if (listening.event !== 'listening') fail('listening', `意外首行: ${buffer.slice(0, 120)}`);
    const baseUrl = `http://127.0.0.1:${listening.port}`;
    ok(`listening (port ${listening.port})`);

    let rpcId = 0;
    async function rpc<T>(method: string, params: unknown): Promise<T> {
      rpcId += 1;
      const response = await fetch(`${baseUrl}/v1/rpc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: String(rpcId), method, params }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await response.json()) as
        { ok: true; result: T } | { ok: false; error: { code: string; message: string } };
      if (!body.ok) fail(method, `${body.error.code}: ${body.error.message}`);
      return body.result;
    }

    // 2. hello：协议版本与能力（params 自报客户端身份与协议版本）
    const hello = await rpc<{ protocolVersion: number; capabilities: string[] }>('engine.hello', {
      protocolVersion: 2,
      client: 'engined-smoke',
    });
    if (hello.protocolVersion !== 2)
      fail('engine.hello', `protocolVersion=${hello.protocolVersion}`);
    for (const capability of ['tools', 'approvals']) {
      if (!hello.capabilities.includes(capability)) {
        fail('engine.hello', `缺能力 ${capability}: ${hello.capabilities.join(',')}`);
      }
    }
    ok('engine.hello (protocol 2, tools+approvals)');

    // 3. 建会话 + WS 订阅
    const summary = await rpc<{ sessionId: string }>('session.create', {});
    const sessionId = summary.sessionId;
    const ticket = await (async () => {
      const response = await fetch(`${baseUrl}/v1/auth/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      return ((await response.json()) as { ticket: string }).ticket;
    })();
    const frames: Frame[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${listening.port}/ws?ticket=${ticket}`);
    const waiters: { predicate: (frame: Frame) => boolean; resolve: () => void }[] = [];
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('WS 连接失败')));
    });
    socket.send(JSON.stringify({ sessionId, fromSeq: 0 }));
    const waitFrame = (predicate: (frame: Frame) => boolean, label: string, ms = 120_000) => {
      if (frames.some(predicate)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待超时: ${label}`)), ms);
        waiters.push({
          predicate,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    };
    ok('session.create + ws subscribe');

    // 4. 读回合：tool_call + 内容带标记 + seq 单调
    await rpc('session.send', {
      sessionId,
      text: 'Read data.txt and repeat the exact MARKER line it contains.',
    });
    await waitFrame(
      (frame) => frame.event.type === 'message_complete',
      'read turn message_complete'
    );
    const readComplete = frames.find((frame) => frame.event.type === 'message_complete');
    if ((readComplete?.event.status as string) !== 'success') {
      fail('read turn', `status=${String(readComplete?.event.status)}`);
    }
    if (!String(readComplete?.event.content).includes(MARKER)) {
      fail('read turn', `内容缺标记: ${String(readComplete?.event.content).slice(0, 160)}`);
    }
    if (!frames.some((frame) => frame.event.type === 'tool_call')) {
      fail('read turn', '未见 tool_call 帧');
    }
    const seqs = frames.map((frame) => frame.seq);
    if (!seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] ?? 0))) {
      fail('read turn', `seq 非单调: ${seqs.join(',')}`);
    }
    ok('read turn (tool_call + marker + seq 单调)');

    // 5. 写回合：审批经 RPC 放行、落盘核实
    const approvalPump = (async () => {
      await waitFrame((frame) => frame.event.type === 'tool_approval_request', 'approval request');
      const request = frames.find((frame) => frame.event.type === 'tool_approval_request');
      const matched = await rpc<{ matched: boolean }>('session.respondToApproval', {
        sessionId,
        callId: request?.event.callId,
        approved: true,
      });
      if (!matched.matched) fail('approval', 'respondToApproval 未命中待决项');
    })();
    await rpc('session.send', {
      sessionId,
      text: `Create a file named result.txt containing exactly: ${WRITE_CONTENT}`,
    });
    await approvalPump;
    await waitFrame(
      (frame) => frame.event.type === 'message_complete' && frame.seq > (readComplete?.seq ?? 0),
      'write turn message_complete'
    );
    await waitFrame((frame) => frame.event.type === 'tool_approval_resolved', 'approval resolved');
    const resolved = frames.find((frame) => frame.event.type === 'tool_approval_resolved');
    if (resolved?.event.reason !== 'reply')
      fail('approval', `reason=${String(resolved?.event.reason)}`);
    const resultPath = join(workDir, 'result.txt');
    if (!existsSync(resultPath) || !readFileSync(resultPath, 'utf8').includes(WRITE_CONTENT)) {
      fail('write turn', 'result.txt 未按内容落盘');
    }
    ok('write turn (approval reply + 落盘)');

    // 6. 二连全量重放：帧数不少于 live 收到的
    const replayTicket = await (async () => {
      const response = await fetch(`${baseUrl}/v1/auth/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      return ((await response.json()) as { ticket: string }).ticket;
    })();
    const replayFrames: Frame[] = [];
    const replaySocket = new WebSocket(
      `ws://127.0.0.1:${listening.port}/ws?ticket=${replayTicket}`
    );
    replaySocket.addEventListener('message', (event) => {
      replayFrames.push(JSON.parse(String(event.data)) as Frame);
    });
    await new Promise<void>((resolve) => replaySocket.addEventListener('open', () => resolve()));
    replaySocket.send(JSON.stringify({ sessionId, fromSeq: 0 }));
    const replayDeadline = Date.now() + 10_000;
    while (replayFrames.length < frames.length && Date.now() < replayDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (replayFrames.length < frames.length) {
      fail('replay', `重放帧 ${replayFrames.length} < live 帧 ${frames.length}`);
    }
    ok(`replay (${replayFrames.length} frames from seq 0)`);

    // 7. 限时退出
    await rpc('engine.shutdown', {});
    const exited = await Promise.race([
      child.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (exited === null) fail('shutdown', '5s 内未退出');
    ok('engine.shutdown (clean exit)');
    console.log('\nengined smoke: all steps green');
  } finally {
    await cleanup();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof SmokeFailure ? error.message : `✗ unexpected: ${String(error)}`);
  process.exit(1);
}

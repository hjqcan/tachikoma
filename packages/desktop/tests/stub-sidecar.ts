/** 监督器测试替身：按 STUB_MODE 演绎 sidecar 契约的各种行为 */

export {};

const mode = process.env.STUB_MODE ?? 'ok';

if (mode === 'exit-early') {
  process.exit(3);
}
if (mode === 'never-listen') {
  // 读掉 token 然后沉默
  await new Promise(() => undefined);
}

const reader = Bun.stdin.stream().getReader();
let buffer = '';
while (!buffer.includes('\n')) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += new TextDecoder().decode(value);
}
const token = buffer.split('\n')[0]?.trim() ?? '';

let shutdownRequested = false;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    if (url.pathname === '/v1/rpc') {
      if (request.headers.get('authorization') !== `Bearer ${token}`) {
        return Response.json({ ok: false }, { status: 401 });
      }
      // 只有 'ok' 模式尊重协议级 shutdown；其余模式验证更深的击杀层。
      if (mode === 'ok') {
        shutdownRequested = true;
        setTimeout(() => process.exit(0), 20);
      }
      return Response.json({ id: 'x', ok: true, result: {} });
    }
    return Response.json({ ok: false }, { status: 404 });
  },
});

process.on('SIGTERM', () => {
  if (mode === 'ignore-sigterm') return;
  process.exit(0);
});

console.log(
  JSON.stringify({
    event: 'listening',
    port: server.port,
    pid: process.pid,
    engineVersion: '0.0.0-stub',
    protocolVersion: 1,
  })
);

// 保持存活直到被停止
setInterval(() => void shutdownRequested, 60_000);

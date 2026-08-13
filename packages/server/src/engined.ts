#!/usr/bin/env bun
/**
 * tachikoma-engined —— 壳托管的 sidecar 入口（desktop-plan §2.3）。
 *
 * 引导：壳经 stdin 第一行注入 Bearer token（不走 argv/env）；
 * 启动后向 stdout 输出恰好一行 listening JSON。
 * 引擎配置经 env（由壳按 workspace 显式设置，非用户环境泄漏）；
 * 变量清单与组装语义见 engine-env.ts（enginedOptionsFromEnv）。
 */

import { ChatEngine, VERSION } from '@tachikoma/core';
import { PROTOCOL_VERSION } from '@tachikoma/protocol';
import { enginedOptionsFromEnv } from './engine-env';
import { startTachikomaServer } from './server';

async function readTokenLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  let buffer = '';
  while (!buffer.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const token = buffer.split('\n')[0]?.trim() ?? '';
  if (!token) {
    throw new Error('Expected the auth token as the first stdin line.');
  }
  return token;
}

const token = await readTokenLine();
const { dataDir, engineConfig, sessionDefaults } = enginedOptionsFromEnv(process.env);

const engine = new ChatEngine(engineConfig);

const server = await startTachikomaServer({
  engine,
  token,
  dataDir,
  engineVersion: VERSION,
  sessionDefaults,
});

process.stdout.write(
  `${JSON.stringify({
    event: 'listening',
    port: server.port,
    pid: process.pid,
    engineVersion: VERSION,
    protocolVersion: PROTOCOL_VERSION,
  })}\n`
);

async function shutdown(): Promise<void> {
  await server.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

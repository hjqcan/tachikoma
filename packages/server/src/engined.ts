#!/usr/bin/env bun
/**
 * tachikoma-engined —— 壳托管的 sidecar 入口（desktop-plan §2.3）。
 *
 * 引导：壳经 stdin 第一行注入 Bearer token（不走 argv/env）；
 * 启动后向 stdout 输出恰好一行 listening JSON。
 * 引擎配置经 env（由壳按 workspace 显式设置，非用户环境泄漏）：
 *   TACHIKOMA_DATA_DIR / TACHIKOMA_PROVIDER / TACHIKOMA_MODEL /
 *   TACHIKOMA_WORKDIR / TACHIKOMA_TOOLSET / TACHIKOMA_USER_ID / TACHIKOMA_NO_MEMORY=1
 */

import { ChatEngine, VERSION } from '@tachikoma/core';
import { PROTOCOL_VERSION } from '@tachikoma/protocol';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

const env = process.env;
const token = await readTokenLine();
const dataDir = env.TACHIKOMA_DATA_DIR ?? join(homedir(), '.tachikoma');
const provider = env.TACHIKOMA_PROVIDER;
const model = env.TACHIKOMA_MODEL;
const workDir = env.TACHIKOMA_WORKDIR;
const toolset = env.TACHIKOMA_TOOLSET === 'coding' ? ('coding' as const) : undefined;

const engine = new ChatEngine({
  dataDir,
  ...(provider && model ? { model: { provider, model } } : {}),
  ...(workDir ? { workDir } : {}),
  ...(toolset ? { toolset } : {}),
  memory:
    env.TACHIKOMA_NO_MEMORY === '1'
      ? false
      : { ...(env.TACHIKOMA_USER_ID ? { userId: env.TACHIKOMA_USER_ID } : {}) },
});

const server = await startTachikomaServer({
  engine,
  token,
  dataDir,
  engineVersion: VERSION,
  sessionDefaults: {
    ...(workDir ? { workDir } : {}),
    ...(toolset ? { toolset } : {}),
  },
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

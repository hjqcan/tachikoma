/**
 * Electron 主进程（D-A 行走骨架）。
 *
 * - 生成 256-bit token，spawn `tachikoma-engined`（dev：bun + workspace dist）。
 * - `--smoke`：不开窗口，握手 hello 后打印一行 JSON 并退出——无头端到端验证。
 * - 正常模式：单窗口加载 renderer，serverInfo 经 IPC 暴露（见 preload）。
 */

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { startSidecar } from './supervisor';
import type { SidecarHandle } from './supervisor';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const smoke = process.argv.includes('--smoke');

let handle: SidecarHandle | undefined;
let token = '';

async function bootSidecar(): Promise<SidecarHandle> {
  token = randomBytes(32).toString('hex');
  return startSidecar({
    // dev 形态：bun 跑 workspace 里构建好的 engined；打包形态换 compiled 二进制（D-C）。
    command: ['bun', join(repoRoot, 'packages', 'server', 'dist', 'engined.js')],
    cwd: repoRoot,
    token,
    env: {
      TACHIKOMA_DATA_DIR: process.env.TACHIKOMA_DATA_DIR,
      TACHIKOMA_PROVIDER: process.env.TACHIKOMA_PROVIDER,
      TACHIKOMA_MODEL: process.env.TACHIKOMA_MODEL,
      TACHIKOMA_WORKDIR: process.env.TACHIKOMA_WORKDIR,
      TACHIKOMA_TOOLSET: process.env.TACHIKOMA_TOOLSET,
      TACHIKOMA_NO_MEMORY: process.env.TACHIKOMA_NO_MEMORY,
    },
  });
}

async function rpc(method: string, params: unknown): Promise<unknown> {
  if (!handle) throw new Error('Sidecar is not running.');
  const response = await fetch(`http://127.0.0.1:${handle.info.port}/v1/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: randomBytes(8).toString('hex'), method, params }),
  });
  return response.json();
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    title: 'Tachikoma',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void window.loadFile(join(here, '..', 'renderer', 'index.html'));
}

ipcMain.handle('tachikoma:server-info', () => {
  if (!handle) throw new Error('Sidecar is not running.');
  return { port: handle.info.port, token, engineVersion: handle.info.engineVersion };
});

app.whenReady().then(async () => {
  try {
    handle = await bootSidecar();
  } catch (error) {
    console.error('[desktop] sidecar boot failed:', error);
    app.exit(1);
    return;
  }

  if (smoke) {
    const hello = await rpc('engine.hello', {
      protocolVersion: 1,
      client: 'tachikoma-desktop/0.2.0',
    });
    console.log(JSON.stringify({ smoke: true, listening: handle.info, hello }));
    await handle.stop();
    app.exit(0);
    return;
  }

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (handle) {
    event.preventDefault();
    const closing = handle;
    handle = undefined;
    void closing.stop().finally(() => app.exit(0));
  }
});

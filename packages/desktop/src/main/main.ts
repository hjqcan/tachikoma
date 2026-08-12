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
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { startSidecar } from './supervisor';
import type { SidecarHandle } from './supervisor';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const smoke = process.argv.includes('--smoke');

let handle: SidecarHandle | undefined;
let token = '';

async function bootSidecar(): Promise<SidecarHandle> {
  token = randomBytes(32).toString('hex');
  // 缺省 dev 形态：bun 跑 workspace dist。TACHIKOMA_ENGINED_BIN 显式指向
  // compiled 二进制（bun run --cwd packages/server build:bin 产出）——
  // 刻意不做自动探测：dev 里陈旧二进制悄悄接管比多设一个 env 更糟。
  const compiledBin = process.env.TACHIKOMA_ENGINED_BIN;
  return startSidecar({
    command: compiledBin
      ? [compiledBin]
      : ['bun', join(repoRoot, 'packages', 'server', 'dist', 'engined.js')],
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
  // show:false + ready-to-show：等首帧再显示——消除白闪，也避免 macOS 上
  // renderer widget 未就绪导致的 "Message rejected by blink.mojom.WidgetHost" 刷屏。
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: 'Tachikoma',
    show: false,
    backgroundColor: '#171a21',
    // macOS：标题栏融进仪表条（header 是拖拽区），窗口即机体
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  // 时间线里的 Markdown 链接：一律交给系统浏览器，窗口本身永不离开 renderer
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (navigation, url) => {
    navigation.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  void window.loadFile(join(here, '..', 'renderer', 'index.html'));

  // 开发诊断：TACHIKOMA_CAPTURE=<png 路径> 时加载完成后截渲染结果落盘（无窗口环境下验证 UI）；
  // TACHIKOMA_CAPTURE_CLICK=<selector[,selector…]> 截屏前按序逐个点击（验证弹层/侧栏/恢复会话等多步交互态）。
  const capturePath = process.env.TACHIKOMA_CAPTURE;
  if (capturePath) {
    const clickSelectors = (process.env.TACHIKOMA_CAPTURE_CLICK ?? '')
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean);
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          for (const selector of clickSelectors) {
            await window.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(selector)})?.click()`
            );
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
          }
          const image = await window.webContents.capturePage();
          const { writeFile } = await import('node:fs/promises');
          await writeFile(capturePath, image.toPNG());
          console.log(`[desktop] capture written: ${capturePath}`);
          app.quit(); // 诊断模式截完即退：不留孤儿实例
        })();
      }, 1_500);
    });
  }
}

ipcMain.handle('tachikoma:server-info', () => {
  if (!handle) throw new Error('Sidecar is not running.');
  return { port: handle.info.port, token, engineVersion: handle.info.engineVersion };
});

// 工作区授予走原生目录选择器：renderer 不自由输入路径，授予的是用户亲手选中的目录。
ipcMain.handle('tachikoma:pick-workspace', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择工作区',
    message: '授予 Tachikoma 在这个目录里的工具权限',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
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

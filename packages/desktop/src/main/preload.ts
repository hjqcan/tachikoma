/** 极薄 contextBridge：renderer 只拿 serverInfo（port/token），协议细节全在 renderer 侧实现 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tachikoma', {
  getServerInfo: (): Promise<{ port: number; token: string; engineVersion: string }> =>
    ipcRenderer.invoke('tachikoma:server-info'),
});

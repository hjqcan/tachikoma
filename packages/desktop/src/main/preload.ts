/** 极薄 contextBridge：renderer 只拿 serverInfo（port/token）与原生目录选择，协议细节全在 renderer 侧实现 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tachikoma', {
  getServerInfo: (): Promise<{ port: number; token: string; engineVersion: string }> =>
    ipcRenderer.invoke('tachikoma:server-info'),
  /** 原生目录选择器（工作区授予入口）；取消返回 null */
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('tachikoma:pick-workspace'),
  /** 原生多选文件对话框；main 代读文本，二进制/超限条目带 error 返回 */
  pickFiles: (): Promise<{ name: string; text?: string; size: number; error?: string }[]> =>
    ipcRenderer.invoke('tachikoma:pick-files'),
});

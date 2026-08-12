/**
 * Tachikoma 桌面 renderer：原生 TS + DOM，仅依赖 @tachikoma/protocol。
 *
 * 工具授予流：header 的工作区 chip → 原生目录选择器（main 进程）→
 * session.create({workDir, toolset}) 开新会话 —— 授予是会话级、显式、不持久化的。
 * 事件渲染语义：底盘蓝 = 工具遥测；传感红 = 审批（机器请求对世界动手）；琥珀 = 记忆。
 */

import { parseSessionEventFrame } from '@tachikoma/protocol';
import type { ChatEventWire, RpcResponse } from '@tachikoma/protocol';

declare global {
  interface Window {
    tachikoma: {
      getServerInfo(): Promise<{ port: number; token: string; engineVersion: string }>;
      pickWorkspace(): Promise<string | null>;
    };
  }
}

interface SessionWorkspace {
  root: string;
  toolset: 'read-only' | 'coding';
  tools: string[];
}

interface SessionSummaryLite {
  sessionId: string;
  workspace?: SessionWorkspace;
}

const statusBar = document.getElementById('status') as HTMLElement;
const log = document.getElementById('log') as HTMLElement;
const input = document.getElementById('input') as HTMLInputElement;
const sendButton = document.getElementById('send') as HTMLButtonElement;
const workspaceChip = document.getElementById('workspace-chip') as HTMLButtonElement;
const toolsetGroup = document.getElementById('toolset') as HTMLElement;

function statusLine(text: string): void {
  statusBar.textContent = text;
}

function appendToLog(element: HTMLElement): void {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.appendChild(element);
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function block(className: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  appendToLog(element);
  return element;
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function inputPreview(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  return text.length > 96 ? `${text.slice(0, 95)}…` : text;
}

/** 审批详情：edit 渲染 旧→新 对照、write 渲染路径+内容，其余回退 JSON —— 让人看得清再判 */
function approvalDetail(tool: string, input: unknown): HTMLElement {
  const container = document.createElement('div');
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pathLine = (): void => {
    if (typeof record.path === 'string') {
      const path = document.createElement('div');
      path.className = 'path';
      path.textContent = record.path;
      container.appendChild(path);
    }
  };
  const preBlock = (text: string, label?: 'old' | 'new'): void => {
    const pre = document.createElement('pre');
    if (label) pre.className = `diff-${label}`;
    pre.textContent = text;
    container.appendChild(pre);
  };
  if (tool === 'edit' && typeof record.oldText === 'string' && typeof record.newText === 'string') {
    pathLine();
    preBlock(record.oldText, 'old');
    preBlock(record.newText, 'new');
  } else if (tool === 'write' && typeof record.content === 'string') {
    pathLine();
    preBlock(record.content);
  } else {
    preBlock(JSON.stringify(input, null, 2) ?? '');
  }
  return container;
}

async function boot(): Promise<void> {
  const { port, token, engineVersion } = await window.tachikoma.getServerInfo();
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function rpc(method: string, params: unknown = {}): Promise<RpcResponse> {
    const response = await fetch(`${base}/v1/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: crypto.randomUUID(), method, params }),
    });
    return (await response.json()) as RpcResponse;
  }

  let sessionId = '';
  let socket: WebSocket | undefined;
  let selectedToolset: 'read-only' | 'coding' = 'read-only';
  let grantedWorkspace: SessionWorkspace | null = null;
  let memoryNote = '';

  function refreshInstrumentCluster(): void {
    if (grantedWorkspace) {
      workspaceChip.textContent = `⌂ ${basename(grantedWorkspace.root)} · ${
        grantedWorkspace.toolset === 'coding' ? '编码' : '只读'
      } · ${grantedWorkspace.tools.length} 工具`;
      workspaceChip.title = `${grantedWorkspace.root}\n${grantedWorkspace.tools.join(', ')}\n点击更换工作区`;
      workspaceChip.classList.add('granted');
    } else {
      workspaceChip.textContent = '无工作区 · 零工具';
      workspaceChip.title = '选择工作区，授予工具权限';
      workspaceChip.classList.remove('granted');
    }
    for (const button of toolsetGroup.querySelectorAll('button')) {
      button.classList.toggle('active', button.dataset.toolset === selectedToolset);
    }
    statusLine(
      `engine ${engineVersion} · session ${sessionId ? sessionId.slice(0, 8) : '—'}${
        memoryNote ? ` · memory: ${memoryNote}` : ''
      }`
    );
  }

  // ── 事件渲染 ────────────────────────────────────────────────

  let assistantBlock: HTMLElement | null = null;
  let reasoningOpen = false;
  const toolNodes = new Map<
    string,
    { head: HTMLElement; verdict: HTMLElement; pre?: HTMLPreElement }
  >();
  const approvalCards = new Map<string, HTMLElement>();

  function toolNode(callId: string, tool: string, preview: string) {
    const container = block('tool');
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = `${tool} · ${preview} `;
    const verdict = document.createElement('span');
    verdict.className = 'verdict';
    head.appendChild(verdict);
    container.appendChild(head);
    const node = { head, verdict, container } as {
      head: HTMLElement;
      verdict: HTMLElement;
      pre?: HTMLPreElement;
      container: HTMLElement;
    };
    toolNodes.set(callId, node);
    return node;
  }

  function toolPre(callId: string): HTMLPreElement | undefined {
    const node = toolNodes.get(callId);
    if (!node) return undefined;
    if (!node.pre) {
      const container = node.head.parentElement;
      if (!container) return undefined;
      node.pre = document.createElement('pre');
      container.appendChild(node.pre);
    }
    return node.pre;
  }

  function handleEvent(event: ChatEventWire): void {
    switch (event.type) {
      case 'message_start':
        assistantBlock = block('turn machine');
        assistantBlock.innerHTML = '<div class="role">tachikoma</div>';
        reasoningOpen = false;
        break;
      case 'reasoning_delta': {
        if (!assistantBlock) break;
        if (!reasoningOpen) {
          const details = document.createElement('details');
          details.className = 'thinking';
          details.innerHTML = '<summary>thinking…</summary><div></div>';
          assistantBlock.appendChild(details);
          reasoningOpen = true;
        }
        const target = assistantBlock.querySelector('details.thinking > div');
        if (target) {
          target.textContent = `${target.textContent ?? ''}${event.text}`;
          target.scrollTop = target.scrollHeight;
        }
        break;
      }
      case 'message_delta': {
        if (!assistantBlock) break;
        let body = assistantBlock.querySelector('.body');
        if (!body) {
          body = document.createElement('div');
          body.className = 'body';
          assistantBlock.appendChild(body);
        }
        body.textContent = `${body.textContent ?? ''}${event.text}`;
        appendToLog(assistantBlock);
        break;
      }
      case 'tool_call':
        toolNode(event.callId, event.tool, inputPreview(event.input));
        break;
      case 'tool_update': {
        // partial 输出是累积快照：整块替换，滚动跟随
        if (!toolNodes.has(event.callId)) toolNode(event.callId, event.tool, '');
        const pre = toolPre(event.callId);
        if (pre) {
          pre.textContent = event.output;
          pre.scrollTop = pre.scrollHeight;
        }
        break;
      }
      case 'tool_result': {
        const node = toolNodes.get(event.callId) ?? toolNode(event.callId, event.tool, '');
        if (event.isError) {
          node.verdict.textContent = `✕ ${event.output.split('\n')[0]?.slice(0, 120) ?? 'error'}`;
          node.verdict.className = 'verdict err';
        } else {
          node.verdict.textContent = `✓ ${event.output.length} chars`;
          if (node.pre) node.pre.textContent = event.output;
        }
        break;
      }
      case 'tool_approval_request': {
        const card = block('approval');
        approvalCards.set(event.callId, card);
        const ask = document.createElement('div');
        ask.className = 'ask';
        ask.innerHTML = `<span class="eye"></span><span>请求执行 <code>${event.tool}</code></span>`;
        const detail = approvalDetail(event.tool, event.input);
        const actions = document.createElement('div');
        actions.className = 'actions';
        const approve = document.createElement('button');
        approve.className = 'approve';
        approve.textContent = '批准';
        const always = document.createElement('button');
        always.className = 'deny';
        always.textContent = '总是允许';
        always.title = '放行，且本会话内该工具不再询问';
        const deny = document.createElement('button');
        deny.className = 'deny';
        deny.textContent = '拒绝';
        const respond = (approved: boolean, scope: 'call' | 'session' = 'call'): void => {
          void rpc('session.respondToApproval', {
            sessionId,
            callId: event.callId,
            approved,
            scope,
          });
          actions.innerHTML = '';
        };
        approve.onclick = () => respond(true);
        always.onclick = () => respond(true, 'session');
        deny.onclick = () => respond(false);
        actions.append(approve, always, deny);
        card.append(ask, detail, actions);
        break;
      }
      case 'tool_approval_resolved': {
        const card = approvalCards.get(event.callId);
        approvalCards.delete(event.callId);
        if (!card) break;
        card.classList.add('resolved');
        card.querySelector('.actions')?.remove();
        const verdict = document.createElement('div');
        verdict.className = 'verdict-line';
        verdict.textContent =
          event.reason === 'timeout'
            ? '超时未应答 — 已拒绝'
            : event.reason === 'aborted'
              ? '回合中止 — 已取消'
              : event.approved
                ? event.scope === 'session'
                  ? '已批准 · 本会话内该工具不再询问'
                  : '已批准'
                : '已拒绝';
        card.appendChild(verdict);
        break;
      }
      case 'memory_status':
        memoryNote = event.status;
        refreshInstrumentCluster();
        if (event.status === 'degraded' || event.status === 'write-failed') {
          block('status-line memory').textContent =
            `[memory:${event.phase}] ${event.status}${event.error ? `: ${event.error}` : ''}`;
        }
        break;
      case 'retry':
        block('status-line').textContent = `[retry] ${event.attempt}/${event.maxAttempts}`;
        break;
      case 'message_complete':
        if (event.status !== 'success') {
          block('status-line error').textContent = `[${event.status}] ${event.error ?? ''}`;
        }
        assistantBlock = null;
        break;
      default:
        break;
    }
  }

  // ── 会话与订阅 ──────────────────────────────────────────────

  async function connect(targetSessionId: string): Promise<void> {
    socket?.close();
    const ticketResponse = await fetch(`${base}/v1/auth/ws-ticket`, { method: 'POST', headers });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const next = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
    next.addEventListener('open', () => {
      next.send(JSON.stringify({ sessionId: targetSessionId, fromSeq: 0 }));
    });
    next.addEventListener('message', (message) => {
      const parsed = parseSessionEventFrame(JSON.parse(String(message.data)));
      if (parsed.ok && parsed.known) {
        handleEvent(parsed.frame.event);
      } else if (parsed.ok) {
        block('status-line').textContent = `[未识别事件 ${parsed.frame.type}]`;
      }
    });
    socket = next;
  }

  async function startSession(params: {
    workDir?: string;
    toolset?: 'read-only' | 'coding';
  }): Promise<void> {
    const created = await rpc('session.create', params);
    if (!created.ok) {
      block('status-line error').textContent = `[error] ${created.error.message}`;
      return;
    }
    const summary = created.result as SessionSummaryLite;
    sessionId = summary.sessionId;
    grantedWorkspace = summary.workspace ?? null;
    if (summary.workspace) selectedToolset = summary.workspace.toolset;
    await connect(sessionId);
    const divider = block('session-divider');
    divider.textContent = grantedWorkspace
      ? `新会话 · 工作区 ${grantedWorkspace.root} · ${grantedWorkspace.tools.join(' / ')}`
      : '新会话 · 零工具';
    refreshInstrumentCluster();
    input.focus();
  }

  // ── 控件 ────────────────────────────────────────────────────

  workspaceChip.onclick = async () => {
    const picked = await window.tachikoma.pickWorkspace();
    if (!picked) return;
    await startSession({ workDir: picked, toolset: selectedToolset });
  };

  toolsetGroup.addEventListener('click', async (mouse) => {
    const target = mouse.target as HTMLElement;
    const toolset = target.dataset.toolset as 'read-only' | 'coding' | undefined;
    if (!toolset || toolset === selectedToolset) return;
    selectedToolset = toolset;
    refreshInstrumentCluster();
    // 已有工作区时，切换工具集是一次显式的重新授予：立即开新会话生效。
    if (grantedWorkspace) {
      await startSession({ workDir: grantedWorkspace.root, toolset });
    }
  });

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if (!text || !sessionId) return;
    input.value = '';
    const userBlock = block('turn you');
    userBlock.innerHTML = '<div class="role">you</div>';
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    userBlock.appendChild(body);
    const sent = await rpc('session.send', { sessionId, text });
    if (!sent.ok) {
      block('status-line error').textContent = `[error] ${sent.error.message}`;
    }
  }

  sendButton.onclick = () => void submit();
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });

  await startSession({});
}

boot().catch((error: unknown) => {
  statusLine(`boot failed: ${error instanceof Error ? error.message : String(error)}`);
});

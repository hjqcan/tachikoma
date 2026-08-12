/**
 * D-A 行走骨架 renderer：原生 TS + DOM，仅依赖 @tachikoma/protocol。
 * 流式聊天 + 工具/审批卡；React 与完整 UI 属于后续桌面迭代。
 */

import { parseSessionEventFrame } from '@tachikoma/protocol';
import type { ChatEventWire, RpcResponse } from '@tachikoma/protocol';

declare global {
  interface Window {
    tachikoma: {
      getServerInfo(): Promise<{ port: number; token: string; engineVersion: string }>;
    };
  }
}

const statusBar = document.getElementById('status') as HTMLElement;
const log = document.getElementById('log') as HTMLElement;
const input = document.getElementById('input') as HTMLInputElement;
const sendButton = document.getElementById('send') as HTMLButtonElement;

function statusLine(text: string): void {
  statusBar.textContent = text;
}

function block(className: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  log.appendChild(element);
  log.scrollTop = log.scrollHeight;
  return element;
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

  const created = await rpc('session.create');
  if (!created.ok) throw new Error(created.error.message);
  const sessionId = (created.result as { sessionId: string }).sessionId;

  const ticketResponse = await fetch(`${base}/v1/auth/ws-ticket`, { method: 'POST', headers });
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ sessionId, fromSeq: 0 }));
    statusLine(`engine ${engineVersion} · session ${sessionId.slice(0, 8)} · ready`);
  });

  let assistantBlock: HTMLElement | null = null;
  let reasoningOpen = false;

  function handleEvent(event: ChatEventWire): void {
    switch (event.type) {
      case 'message_start':
        assistantBlock = block('turn');
        assistantBlock.innerHTML = '<div class="role">tachikoma</div>';
        reasoningOpen = false;
        break;
      case 'reasoning_delta': {
        if (!assistantBlock) break;
        if (!reasoningOpen) {
          const details = document.createElement('details');
          details.innerHTML =
            '<summary class="status">thinking…</summary><div class="status"></div>';
          assistantBlock.appendChild(details);
          reasoningOpen = true;
        }
        const target = assistantBlock.querySelector('details > div');
        if (target) target.textContent = `${target.textContent ?? ''}${event.text}`;
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
        log.scrollTop = log.scrollHeight;
        break;
      }
      case 'tool_call':
        block('status').textContent =
          `[tool:${event.tool}] ${JSON.stringify(event.input).slice(0, 120)}`;
        break;
      case 'tool_result':
        block('status').textContent =
          `[tool:${event.tool}] ${event.isError ? `error: ${event.output.split('\n')[0]}` : `ok (${event.output.length} chars)`}`;
        break;
      case 'tool_approval_request': {
        const card = block('approval');
        card.innerHTML = `<div><strong>批准工具调用？</strong> <code>${event.tool}</code></div><pre>${JSON.stringify(event.input, null, 2)}</pre>`;
        const approve = document.createElement('button');
        approve.textContent = '批准';
        const deny = document.createElement('button');
        deny.textContent = '拒绝';
        const respond = (approved: boolean): void => {
          void rpc('session.respondToApproval', { sessionId, callId: event.callId, approved });
          card.querySelectorAll('button').forEach((button) => button.remove());
          card.append(approved ? '已批准' : '已拒绝');
        };
        approve.onclick = () => respond(true);
        deny.onclick = () => respond(false);
        card.append(approve, deny);
        break;
      }
      case 'tool_approval_resolved':
        if (event.reason !== 'reply') {
          block('status').textContent = `[approval] ${event.reason}`;
        }
        break;
      case 'memory_status':
        statusLine(`memory: ${event.status}`);
        break;
      case 'retry':
        block('status').textContent = `[retry] ${event.attempt}/${event.maxAttempts}`;
        break;
      case 'message_complete':
        if (event.status !== 'success') {
          block('status').textContent = `[${event.status}] ${event.error ?? ''}`;
        }
        assistantBlock = null;
        break;
      default:
        break;
    }
  }

  socket.addEventListener('message', (message) => {
    const parsed = parseSessionEventFrame(JSON.parse(String(message.data)));
    if (parsed.ok && parsed.known) {
      handleEvent(parsed.frame.event);
    } else if (parsed.ok) {
      block('status').textContent = `[未识别事件 ${parsed.frame.type}]`;
    }
  });

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const userBlock = block('turn');
    userBlock.innerHTML = '<div class="role">you</div>';
    const body = document.createElement('div');
    body.textContent = text;
    userBlock.appendChild(body);
    const sent = await rpc('session.send', { sessionId, text });
    if (!sent.ok) {
      block('status').textContent = `[error] ${sent.error.message}`;
    }
  }

  sendButton.onclick = () => void submit();
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });
}

boot().catch((error: unknown) => {
  statusLine(`boot failed: ${error instanceof Error ? error.message : String(error)}`);
});

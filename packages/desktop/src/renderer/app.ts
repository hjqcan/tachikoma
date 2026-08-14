/**
 * Tachikoma 桌面 renderer：原生 TS + DOM，仅依赖 @hjqcan/tachikoma-protocol。
 *
 * 工具授予流：header 的工作区 chip → 原生目录选择器（main 进程）→
 * session.create({workDir, toolset}) 开新会话 —— 授予是会话级、显式、不持久化的。
 * 事件渲染语义：底盘蓝 = 工具遥测；传感红 = 审批（机器请求对世界动手）；琥珀 = 记忆。
 */

import { parseSessionEventFrame } from '@hjqcan/tachikoma-protocol';
import type { ChatEventWire, RpcResponse } from '@hjqcan/tachikoma-protocol';

import { buildMemoryView, feedbackLifecycleLabel, systemRecordsSummary } from './memory-view';
import type { MemoryRecordView } from './memory-view';

declare global {
  interface Window {
    tachikoma: {
      getServerInfo(): Promise<{ port: number; token: string; engineVersion: string }>;
      pickWorkspace(): Promise<string | null>;
      pickFiles(): Promise<
        {
          name: string;
          size: number;
          text?: string;
          imageBase64?: string;
          mimeType?: string;
          error?: string;
        }[]
      >;
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
  title?: string;
  updatedAt?: number;
  messageCount?: number;
  model?: { provider: string; model: string } | null;
  thinkingLevel?: string | null;
  workspace?: SessionWorkspace;
}

const statusBar = document.getElementById('status') as HTMLElement;
const log = document.getElementById('log') as HTMLElement;
const input = document.getElementById('input') as HTMLTextAreaElement;
const sendButton = document.getElementById('send') as HTMLButtonElement;
const workspaceChip = document.getElementById('workspace-chip') as HTMLButtonElement;
const toolsetGroup = document.getElementById('toolset') as HTMLElement;
const sessionsToggle = document.getElementById('sessions-toggle') as HTMLButtonElement;
const sessionsPanel = document.getElementById('sessions') as HTMLElement;
const sessionList = document.getElementById('session-list') as HTMLElement;
const sessionFilter = document.getElementById('session-filter') as HTMLInputElement;
const newSessionButton = document.getElementById('new-session') as HTMLButtonElement;
const memoryToggle = document.getElementById('memory-toggle') as HTMLButtonElement;
const memoryPanel = document.getElementById('memory') as HTMLElement;
const memorySearch = document.getElementById('memory-search') as HTMLInputElement;
const memoryListPane = document.getElementById('memory-list') as HTMLElement;
const memoryClearButton = document.getElementById('memory-clear') as HTMLButtonElement;
const toBottomButton = document.getElementById('to-bottom') as HTMLButtonElement;
const attachButton = document.getElementById('attach') as HTMLButtonElement;
const accessChip = document.getElementById('access-chip') as HTMLButtonElement;
const attachmentsRow = document.getElementById('attachments') as HTMLElement;
const ctxGauge = document.getElementById('ctx-gauge') as HTMLElement;
const compactNowButton = document.getElementById('compact-now') as HTMLButtonElement;
const modelChip = document.getElementById('model-chip') as HTMLButtonElement;
const modelPicker = document.getElementById('model-picker') as HTMLElement;
const modelFilter = document.getElementById('model-filter') as HTMLInputElement;
const modelOptions = document.getElementById('model-options') as HTMLElement;
const thinkingSelect = document.getElementById('thinking') as HTMLSelectElement;

if (navigator.platform.startsWith('Mac')) document.body.classList.add('mac');

function statusLine(text: string): void {
  statusBar.textContent = text;
}

/** textarea 自动增高：1 行起步，封顶交给 CSS max-height */
function autosizeInput(): void {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}
input.addEventListener('input', autosizeInput);

/**
 * 附件的线格式：文本文件以定界块内联进 prompt（转录即事实源，重放一致）。
 * 气泡端按同一定界解析回芯片展示。图片等二进制是引擎层的后续增量。
 */
const ATTACHMENT_OPEN = (name: string) => `<tachikoma:attachment name="${name}">`;
const ATTACHMENT_RE =
  /<tachikoma:attachment name="([^"\n]*)">\n?([\s\S]*?)\n?<\/tachikoma:attachment>\n*/g;

function formatBytes(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)}MB`;
  if (size >= 1000) return `${Math.round(size / 1000)}KB`;
  return `${size}B`;
}

function attachmentChip(
  name: string,
  size?: number,
  onRemove?: () => void,
  kind: 'text' | 'image' = 'text'
): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'attachment-chip';
  const icon = document.createTextNode(kind === 'image' ? '🖼 ' : '📄 ');
  const fname = document.createElement('span');
  fname.className = 'fname';
  fname.textContent = name;
  fname.title = name;
  chip.append(icon, fname);
  if (size !== undefined) {
    const fsize = document.createElement('span');
    fsize.className = 'fsize';
    fsize.textContent = formatBytes(size);
    chip.appendChild(fsize);
  }
  if (onRemove) {
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '✕';
    remove.title = '移除附件';
    remove.onclick = onRemove;
    chip.appendChild(remove);
  }
  return chip;
}

/** 滚到底悬浮按钮：离底 240px 以上出现 */
log.addEventListener('scroll', () => {
  toBottomButton.hidden = log.scrollHeight - log.scrollTop - log.clientHeight < 240;
});
toBottomButton.onclick = () => {
  log.scrollTop = log.scrollHeight;
};

/**
 * 机器声音的 Markdown 渲染：纯 DOM 构建（textContent，不信任内容进 innerHTML）。
 * 覆盖：标题/列表/围栏代码/行内代码/加粗/引用/分隔线/链接；流式期间对未闭合
 * 围栏按开放代码块渲染。刻意不做表格与嵌套列表——等宽底子上保持安静。
 */
function renderInline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:[^)\s]+\))/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) fragment.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      fragment.append(code);
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      fragment.append(strong);
    } else {
      const split = token.indexOf('](');
      const anchor = document.createElement('a');
      anchor.textContent = token.slice(1, split);
      anchor.href = token.slice(split + 2, -1);
      anchor.title = anchor.href;
      fragment.append(anchor);
    }
    last = match.index + token.length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

/** 复制按钮通用行为：写剪贴板 + 短暂 ✓ 反馈 */
function copyButton(className: string, text: () => string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = className;
  button.textContent = '复制';
  button.title = '复制到剪贴板';
  button.onclick = () => {
    void navigator.clipboard.writeText(text()).then(() => {
      button.textContent = '✓';
      setTimeout(() => (button.textContent = '复制'), 1200);
    });
  };
  return button;
}

function renderMarkdown(source: string, into: HTMLElement): void {
  into.textContent = '';
  const lines = source.split('\n');
  let list: HTMLUListElement | HTMLOListElement | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (/^```/.test(line)) {
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        buffer.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // 闭合围栏（或流式中的文件尾）
      const pre = document.createElement('pre');
      pre.className = 'code';
      const code = document.createElement('code');
      code.textContent = buffer.join('\n');
      pre.append(
        code,
        copyButton('code-copy', () => code.textContent ?? '')
      );
      into.append(pre);
      list = null;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      const block = document.createElement('div');
      block.className = `md-h md-h${heading[1].length}`;
      block.append(renderInline(heading[2]));
      into.append(block);
      list = null;
      index += 1;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet?.[1] ?? ordered?.[1];
    if (item !== undefined) {
      const wantOrdered = Boolean(ordered);
      if (!list || (list.tagName === 'OL') !== wantOrdered) {
        list = document.createElement(wantOrdered ? 'ol' : 'ul');
        into.append(list);
      }
      const li = document.createElement('li');
      li.append(renderInline(item));
      list.append(li);
      index += 1;
      continue;
    }
    list = null;
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const block = document.createElement('blockquote');
      block.append(renderInline(quote[1] ?? ''));
      into.append(block);
      index += 1;
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      into.append(document.createElement('hr'));
      index += 1;
      continue;
    }
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    // 连续文本行合成一段（保留段内换行）
    const paragraph: string[] = [line];
    while (
      index + 1 < lines.length &&
      (lines[index + 1] ?? '').trim() !== '' &&
      !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|>)/.test(lines[index + 1] ?? '')
    ) {
      index += 1;
      paragraph.push(lines[index] ?? '');
    }
    const block = document.createElement('div');
    block.className = 'md-p';
    block.append(renderInline(paragraph.join('\n')));
    into.append(block);
    index += 1;
  }
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
  /** 每会话一条 WS：活动会话驱动全量渲染，后台会话只驱动侧栏状态点 */
  const sockets = new Map<string, WebSocket>();
  const busySessions = new Set<string>();
  const unreadSessions = new Set<string>();
  let selectedToolset: 'read-only' | 'coding' = 'read-only';
  let grantedWorkspace: SessionWorkspace | null = null;
  let currentModel = '';
  let memoryNote = '';
  let generating = false;

  function setGenerating(next: boolean): void {
    generating = next;
    sendButton.textContent = next ? '■' : '↑';
    sendButton.title = next ? '停止生成' : '发送（Enter）';
    sendButton.classList.toggle('generating', next);
    document.body.classList.toggle('generating', next); // 传感镜头呼吸
  }

  function refreshInstrumentCluster(): void {
    if (grantedWorkspace) {
      workspaceChip.textContent = `⌂ ${basename(grantedWorkspace.root)} · ${
        grantedWorkspace.toolset === 'coding' ? 'work' : 'chat'
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
    // 仪表条只留机器自身的状态；模型归页脚 chip，会话身份归侧栏
    statusLine(`engine ${engineVersion}${memoryNote ? ` · memory ${memoryNote}` : ''}`);
    // composer 权限芯片与头部授予联动：零工具暗 / chat 蓝 / work 琥珀警示
    if (!grantedWorkspace) {
      accessChip.textContent = '零工具';
      accessChip.className = '';
      accessChip.title = '当前零工具；点击选择工作区授予';
    } else if (grantedWorkspace.toolset === 'coding') {
      accessChip.textContent = `⚠ work · ${basename(grantedWorkspace.root)}`;
      accessChip.className = 'work';
      accessChip.title = `${grantedWorkspace.root}\n${grantedWorkspace.tools.join(', ')}（写/改/执行逐次审批）`;
    } else {
      accessChip.textContent = `chat · ${basename(grantedWorkspace.root)}`;
      accessChip.className = 'chat';
      accessChip.title = `${grantedWorkspace.root}\n${grantedWorkspace.tools.join(', ')}（只读）`;
    }
  }

  // ── 事件渲染 ────────────────────────────────────────────────

  let assistantBlock: HTMLElement | null = null;
  let assistantRaw = ''; // 当前助手回合累积的 Markdown 原文（渲染的唯一来源）
  let reasoningOpen = false;
  /** 本回合的 write/edit 调用——回合收口时聚合成"修改了 N 个文件"卡 */
  let turnFileChanges: { tool: string; input: unknown }[] = [];

  interface ToolNode {
    details: HTMLDetailsElement;
    verdict: HTMLElement;
    dur: HTMLElement;
    pre?: HTMLPreElement;
    startTs: number;
  }
  const toolNodes = new Map<string, ToolNode>();
  const approvalCards = new Map<string, HTMLElement>();

  function formatDur(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '';
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  /** 工具遥测：单行状态芯片（名称·参数·状态·时长），点击展开输出 */
  function toolNode(callId: string, tool: string, preview: string, startTs: number): ToolNode {
    const details = document.createElement('details');
    details.className = 'tool';
    const summary = document.createElement('summary');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = tool;
    const args = document.createElement('span');
    args.className = 'args';
    args.textContent = preview;
    const verdict = document.createElement('span');
    verdict.className = 'verdict run';
    verdict.textContent = '运行中';
    const dur = document.createElement('span');
    dur.className = 'dur';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▾';
    summary.append(name, args, verdict, dur, chev);
    details.appendChild(summary);
    appendToLog(details);
    const node: ToolNode = { details, verdict, dur, startTs };
    toolNodes.set(callId, node);
    return node;
  }

  function toolPre(callId: string): HTMLPreElement | undefined {
    const node = toolNodes.get(callId);
    if (!node) return undefined;
    if (!node.pre) {
      node.pre = document.createElement('pre');
      node.details.appendChild(node.pre);
    }
    return node.pre;
  }

  function handleEvent(event: ChatEventWire): void {
    switch (event.type) {
      case 'user_message': {
        log.querySelector('.hero')?.remove(); // 第一句话说出口，空状态退场
        // 用户回合也来自事件流：live 与 WAL 重放共用同一渲染路径。人的声音=右侧气泡
        const userBlock = block('turn you');
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        // 文本附件定界块解析回芯片；图片芯片来自事件元数据（像素在转录，不进账本）
        const names: string[] = [];
        const remainder = event.text.replace(ATTACHMENT_RE, (_whole, name: string) => {
          names.push(name);
          return '';
        });
        const imageMetas = event.attachments ?? [];
        if (names.length > 0 || imageMetas.length > 0) {
          const files = document.createElement('div');
          files.className = 'attached-files';
          for (const name of names) files.appendChild(attachmentChip(name));
          for (const meta of imageMetas) {
            files.appendChild(
              attachmentChip(meta.name ?? meta.mimeType, meta.bytes, undefined, 'image')
            );
          }
          bubble.appendChild(files);
        }
        bubble.append(remainder.trim());
        userBlock.appendChild(bubble);
        break;
      }
      case 'message_start': {
        setGenerating(true);
        assistantBlock = block('turn machine');
        assistantBlock.innerHTML = '<div class="role">tachikoma</div>';
        assistantBlock.appendChild(
          copyButton('copy-turn', () => assistantBlock?.dataset.raw ?? '')
        );
        assistantRaw = '';
        turnFileChanges = [];
        reasoningOpen = false;
        break;
      }
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
        let body = assistantBlock.querySelector('.body') as HTMLElement | null;
        if (!body) {
          body = document.createElement('div');
          body.className = 'body';
          assistantBlock.appendChild(body);
        }
        assistantRaw += event.text;
        assistantBlock.dataset.raw = assistantRaw;
        renderMarkdown(assistantRaw, body);
        appendToLog(assistantBlock);
        break;
      }
      case 'tool_call':
        toolNode(event.callId, event.tool, inputPreview(event.input), event.timestamp);
        if (event.tool === 'write' || event.tool === 'edit') {
          turnFileChanges.push({ tool: event.tool, input: event.input });
        }
        break;
      case 'tool_update': {
        // partial 输出是累积快照：整块替换，滚动跟随
        if (!toolNodes.has(event.callId)) {
          toolNode(event.callId, event.tool, '', event.timestamp);
        }
        const pre = toolPre(event.callId);
        if (pre) {
          pre.textContent = event.output;
          pre.scrollTop = pre.scrollHeight;
        }
        break;
      }
      case 'tool_result': {
        const node =
          toolNodes.get(event.callId) ?? toolNode(event.callId, event.tool, '', event.timestamp);
        // 时长按事件时间戳算：live 与重放一致
        node.dur.textContent = formatDur(event.timestamp - node.startTs);
        if (event.isError) {
          node.verdict.textContent = `✕ ${event.output.split('\n')[0]?.slice(0, 80) ?? 'error'}`;
          node.verdict.className = 'verdict err';
        } else {
          node.verdict.textContent = `✓ ${event.output.length} chars`;
          node.verdict.className = 'verdict';
          if (node.pre) node.pre.textContent = event.output;
        }
        break;
      }
      case 'tool_approval_request': {
        const card = block('approval');
        approvalCards.set(event.callId, card);
        document.body.classList.add('awaiting-approval'); // 传感镜头转红
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
        if (approvalCards.size === 0) document.body.classList.remove('awaiting-approval');
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
        } else if (event.phase === 'recall' && event.recalled && event.recalled.length > 0) {
          // 机器想起了什么：琥珀行，可展开命中明细
          const details = document.createElement('details');
          details.className = 'recall';
          const summary = document.createElement('summary');
          summary.textContent = `召回 ${event.recalled.length} 条记忆`;
          details.appendChild(summary);
          for (const hit of event.recalled) {
            const row = document.createElement('div');
            row.className = 'hit';
            const kind = document.createElement('span');
            kind.className = 'kind';
            kind.textContent = MEMORY_TYPE_LABELS[hit.type] ?? hit.type;
            row.append(kind, hit.preview || hit.id);
            details.appendChild(row);
          }
          appendToLog(details);
        }
        break;
      case 'compaction':
        block('status-line').textContent =
          `[compaction] ${event.phase}${'reason' in event && event.reason ? ` · ${event.reason}` : ''}`;
        break;
      case 'retry':
        block('status-line').textContent = `[retry] ${event.attempt}/${event.maxAttempts}`;
        break;
      case 'message_complete': {
        setGenerating(false);
        // 以权威全文重渲染一次：流式期间未闭合的结构（围栏等）在此收口
        const body = assistantBlock?.querySelector('.body') as HTMLElement | null;
        if (body && event.content) {
          renderMarkdown(event.content, body);
          if (assistantBlock) assistantBlock.dataset.raw = event.content;
        }
        if (event.status !== 'success') {
          block('status-line error').textContent = `[${event.status}] ${event.error ?? ''}`;
        }
        // 回合收口卡：这一回合机器改了哪些文件（带行数账，复用审批卡的 diff 预览）
        if (turnFileChanges.length > 0) {
          const changes = turnFileChanges;
          turnFileChanges = [];
          let added = 0;
          let removed = 0;
          for (const change of changes) {
            const record = (
              change.input && typeof change.input === 'object' ? change.input : {}
            ) as Record<string, unknown>;
            if (typeof record.content === 'string') added += record.content.split('\n').length;
            if (typeof record.newText === 'string') added += record.newText.split('\n').length;
            if (typeof record.oldText === 'string') removed += record.oldText.split('\n').length;
          }
          const card = document.createElement('details');
          card.className = 'changes';
          const summary = document.createElement('summary');
          const label = document.createElement('span');
          label.textContent = `✎ 本回合修改 ${changes.length} 处文件`;
          const delta = document.createElement('span');
          delta.className = 'delta';
          const plus = document.createElement('span');
          plus.className = 'plus';
          plus.textContent = `+${added}`;
          const minus = document.createElement('span');
          minus.className = 'minus';
          minus.textContent = ` −${removed}`;
          delta.append(plus, minus);
          summary.append(label, delta);
          card.appendChild(summary);
          for (const change of changes) {
            const entry = document.createElement('div');
            entry.className = 'change';
            const label = document.createElement('div');
            label.className = 'change-head';
            label.textContent = change.tool; // 文件路径由 approvalDetail 的 .path 行呈现
            entry.append(label, approvalDetail(change.tool, change.input));
            card.appendChild(entry);
          }
          appendToLog(card);
        }
        assistantBlock = null;
        if (event.usage.totalTokens > 0) {
          lastTurnTokens = event.usage.totalTokens;
          void updateCtxGauge();
        }
        scheduleSessionListRefresh();
        break;
      }
      default:
        break;
    }
  }

  // ── 会话与订阅 ──────────────────────────────────────────────

  function clearTimeline(): void {
    log.innerHTML = '';
    toolNodes.clear();
    approvalCards.clear();
    document.body.classList.remove('awaiting-approval');
    assistantBlock = null;
    assistantRaw = '';
    turnFileChanges = [];
    reasoningOpen = false;
    setGenerating(false);
    resetCtxGauge();
    toBottomButton.hidden = true;
  }

  /** 空状态：机器就绪，等第一句话（仅新会话；第一条 user_message 到来即退场）。
   *  授予状态直接写进 hero——新会话不再另画分隔线。 */
  function showHero(): void {
    const hero = block('hero');
    const lens = document.createElement('div');
    lens.className = 'hero-lens';
    const title = document.createElement('div');
    title.className = 'hero-title';
    title.textContent = '机器就绪。';
    const hint = document.createElement('div');
    hint.className = 'hero-hint';
    const grantLine = grantedWorkspace
      ? `工作区 ${grantedWorkspace.root} · ${grantedWorkspace.tools.join(' / ')}`
      : '零工具 · 点击上方「无工作区」选择目录，授予工具权限';
    hint.append(grantLine, document.createElement('br'), 'Enter 发送 · Shift+Enter 换行');
    hero.append(lens, title, hint);
  }

  /** 工具条空间宝贵：chip 只显示模型名，provider 进 title */
  function setModelChip(value: string): void {
    modelChip.textContent = value ? (value.split('/').pop() ?? value) : 'model…';
    modelChip.title = value ? `${value} · 点击切换` : '切换模型';
  }

  function adoptSummary(summary: SessionSummaryLite): void {
    sessionId = summary.sessionId;
    grantedWorkspace = summary.workspace ?? null;
    if (summary.workspace) selectedToolset = summary.workspace.toolset;
    currentModel = summary.model ? `${summary.model.provider}/${summary.model.model}` : '';
    setModelChip(currentModel);
    if (summary.thinkingLevel) thinkingSelect.value = summary.thinkingLevel;
  }

  /** 后台会话的事件只驱动侧栏状态：生成中呼吸点，完成变未读点并释放连接 */
  function handleBackgroundEvent(target: string, event: ChatEventWire): void {
    if (event.type === 'message_start') {
      busySessions.add(target);
      updateSessionRowState(target);
    } else if (event.type === 'message_complete') {
      busySessions.delete(target);
      unreadSessions.add(target);
      updateSessionRowState(target);
      sockets.get(target)?.close();
      sockets.delete(target);
      scheduleSessionListRefresh();
    }
  }

  async function connect(targetSessionId: string): Promise<void> {
    sockets.get(targetSessionId)?.close();
    sockets.delete(targetSessionId);
    const ticketResponse = await fetch(`${base}/v1/auth/ws-ticket`, { method: 'POST', headers });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const next = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
    next.addEventListener('open', () => {
      next.send(JSON.stringify({ sessionId: targetSessionId, fromSeq: 0 }));
    });
    next.addEventListener('message', (message) => {
      const parsed = parseSessionEventFrame(JSON.parse(String(message.data)));
      if (!parsed.ok) return;
      if (!parsed.known) {
        if (targetSessionId === sessionId) {
          block('status-line').textContent = `[未识别事件 ${parsed.frame.type}]`;
        }
        return;
      }
      // 路由按"当下"的活动会话判定：切走后同一条 socket 自动降级为后台状态源
      if (parsed.frame.event.sessionId === sessionId) {
        handleEvent(parsed.frame.event);
      } else {
        handleBackgroundEvent(targetSessionId, parsed.frame.event);
      }
    });
    sockets.set(targetSessionId, next);
  }

  /** 离开当前会话：生成中则留在后台跑完（WAL 全量记录，切回重放即完整），空闲则断开 */
  function detachActiveSession(): void {
    if (!sessionId) return;
    if (generating) {
      busySessions.add(sessionId);
      updateSessionRowState(sessionId);
    } else {
      sockets.get(sessionId)?.close();
      sockets.delete(sessionId);
    }
  }

  async function startSession(params: {
    workDir?: string;
    toolset?: 'read-only' | 'coding';
  }): Promise<void> {
    detachActiveSession();
    const created = await rpc('session.create', params);
    if (!created.ok) {
      block('status-line error').textContent = `[error] ${created.error.message}`;
      return;
    }
    clearTimeline();
    adoptSummary(created.result as SessionSummaryLite);
    await connect(sessionId);
    showHero();
    refreshInstrumentCluster();
    input.focus();
  }

  /** 恢复历史会话：WS 从 seq 0 重放 WAL，双方对话与工具轨迹全量重建 */
  async function openExisting(targetSessionId: string): Promise<void> {
    if (targetSessionId === sessionId) return;
    detachActiveSession();
    unreadSessions.delete(targetSessionId);
    const opened = await rpc('session.open', { sessionId: targetSessionId });
    if (!opened.ok) {
      block('status-line error').textContent = `[error] ${opened.error.message}`;
      return;
    }
    clearTimeline();
    adoptSummary(opened.result as SessionSummaryLite);
    await connect(sessionId);
    const divider = block('session-divider');
    divider.textContent = grantedWorkspace
      ? `恢复会话 · 工作区 ${grantedWorkspace.root}`
      : '恢复会话 · 零工具（授予不随恢复携带，可重新选择工作区）';
    refreshInstrumentCluster();
    void refreshSessionList();
    input.focus();
  }

  /** 会话时间：今天只给时刻，昨天点名，更早给日期——列表里时间是导航不是档案 */
  function relativeWhen(timestamp: number): string {
    const then = new Date(timestamp);
    const now = new Date();
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    const hhmm = then.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (sameDay(then, now)) return hhmm;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(then, yesterday)) return `昨天 ${hhmm}`;
    if (then.getFullYear() === now.getFullYear()) {
      return then.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    }
    return then.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }

  const TRASH_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 5v6m4-6v6"/></svg>';

  async function deleteSessionById(target: string): Promise<void> {
    const result = await rpc('session.delete', { sessionId: target });
    if (!result.ok) {
      block('status-line error').textContent = `[error] ${result.error.message}`;
      return;
    }
    sockets.get(target)?.close();
    sockets.delete(target);
    busySessions.delete(target);
    unreadSessions.delete(target);
    if (target === sessionId) {
      // 删的是当前会话（引擎已连带关闭）：按当前授予状态接一个新会话
      setGenerating(false);
      sessionId = '';
      await startSession(
        grantedWorkspace ? { workDir: grantedWorkspace.root, toolset: selectedToolset } : {}
      );
    }
    await refreshSessionList();
  }

  /** 双击标题行内改名：Enter 提交（session.rename），Esc/失焦取消 */
  function startInlineRename(summary: SessionSummaryLite, title: HTMLElement): void {
    const current = summary.title?.trim() || '';
    const editor = document.createElement('input');
    editor.value = current;
    title.textContent = '';
    title.appendChild(editor);
    editor.focus();
    editor.select();
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const next = editor.value.trim();
      if (commit && next && next !== current) {
        void rpc('session.rename', { sessionId: summary.sessionId, title: next }).then(
          (renamed) => {
            if (!renamed.ok) {
              block('status-line error').textContent = `[error] ${renamed.error.message}`;
            }
            void refreshSessionList();
          }
        );
        title.textContent = next;
      } else {
        title.textContent = current || summary.sessionId.slice(0, 8);
      }
    };
    editor.onkeydown = (key) => {
      key.stopPropagation();
      if (key.key === 'Enter') finish(true);
      else if (key.key === 'Escape') finish(false);
    };
    editor.onblur = () => finish(false);
    editor.onclick = (click) => click.stopPropagation();
  }

  /** 侧栏行状态点：后台生成中=呼吸，完成未读=常亮（复用传感镜头母题） */
  function sessionRowStateClass(target: string): string {
    if (busySessions.has(target)) return ' busy';
    if (unreadSessions.has(target)) return ' unread';
    return '';
  }

  function updateSessionRowState(target: string): void {
    const row = sessionList.querySelector<HTMLElement>(`[data-sid="${target}"]`);
    if (!row) return;
    row.classList.toggle('busy', busySessions.has(target));
    row.classList.toggle('unread', unreadSessions.has(target));
  }

  function sessionRow(summary: SessionSummaryLite): HTMLElement {
    const row = document.createElement('div');
    row.className = `session-row${summary.sessionId === sessionId ? ' current' : ''}${sessionRowStateClass(summary.sessionId)}`;
    row.dataset.sid = summary.sessionId;
    const state = document.createElement('span');
    state.className = 'state-dot';
    row.appendChild(state);
    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = summary.title?.trim() || summary.sessionId.slice(0, 8);
    title.title = '双击重命名';
    title.ondblclick = (dbl) => {
      dbl.stopPropagation();
      startInlineRename(summary, title);
    };
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = [
      summary.updatedAt ? relativeWhen(summary.updatedAt) : '',
      `${summary.messageCount ?? 0} 条`,
    ]
      .filter(Boolean)
      .join(' · ');

    const del = document.createElement('button');
    del.className = 'del';
    del.title = '删除会话';
    del.innerHTML = TRASH_SVG;
    del.onclick = (mouse) => {
      mouse.stopPropagation();
      if (row.querySelector('.confirm-bar')) return;
      meta.hidden = true;
      const bar = document.createElement('div');
      bar.className = 'confirm-bar';
      const yes = document.createElement('button');
      yes.className = 'yes';
      yes.textContent = '确认删除';
      yes.onclick = (click) => {
        click.stopPropagation();
        void deleteSessionById(summary.sessionId);
      };
      const no = document.createElement('button');
      no.className = 'no';
      no.textContent = '取消';
      no.onclick = (click) => {
        click.stopPropagation();
        bar.remove();
        meta.hidden = false;
      };
      bar.append(yes, no);
      row.appendChild(bar);
    };

    row.append(title, meta, del);
    row.onclick = () => {
      if (row.querySelector('.confirm-bar')) return; // 确认中不触发打开
      void openExisting(summary.sessionId);
    };
    return row;
  }

  let sessionSummaries: SessionSummaryLite[] = [];

  function renderSessionList(): void {
    const needle = sessionFilter.value.trim().toLowerCase();
    sessionList.innerHTML = '';
    for (const summary of sessionSummaries) {
      const label = `${summary.title ?? ''} ${summary.sessionId}`.toLowerCase();
      if (needle && !label.includes(needle)) continue;
      sessionList.appendChild(sessionRow(summary));
    }
  }

  async function refreshSessionList(): Promise<void> {
    const listed = await rpc('session.list');
    if (!listed.ok) return;
    sessionSummaries = (listed.result as { sessions: SessionSummaryLite[] }).sessions;
    renderSessionList();
  }
  sessionFilter.addEventListener('input', renderSessionList);

  // 回合结束后标题/条数会变（自动命名在首回合落盘）——去抖刷新侧栏
  let sessionListRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSessionListRefresh(): void {
    clearTimeout(sessionListRefreshTimer);
    sessionListRefreshTimer = setTimeout(() => void refreshSessionList(), 400);
  }

  // ── 记忆抽屉：琥珀支柱——看得见、搜得着、删得掉 ────────────────

  const MEMORY_TYPE_LABELS: Record<string, string> = {
    fact: '事实',
    preference: '偏好',
    reference: '引用',
    episode: '情景',
    feedback: '反馈',
    archive: '会话档案',
    experience: '系统经验',
    profile: '画像',
  };

  function memoryRow(record: MemoryRecordView): HTMLElement {
    const row = document.createElement('div');
    row.className = 'memory-row';
    const content = document.createElement('div');
    content.className = 'content';
    content.textContent = record.content;
    content.title = record.content;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const lifecycle =
      record.type === 'feedback' ? feedbackLifecycleLabel(record.lifecycle) : undefined;
    if (lifecycle) {
      const badge = document.createElement('span');
      badge.className = `memory-lifecycle ${record.lifecycle}`;
      badge.textContent = lifecycle;
      meta.appendChild(badge);
    }
    const metaText = [
      record.createdAt ? relativeWhen(Date.parse(record.createdAt)) : '',
      ...(record.tags ?? []),
    ]
      .filter(Boolean)
      .join(' · ');
    if (metaText) {
      meta.appendChild(document.createTextNode(`${lifecycle ? ' · ' : ''}${metaText}`));
    }
    const del = document.createElement('button');
    del.className = 'del';
    del.title = '删除这条记忆';
    del.innerHTML = TRASH_SVG;
    del.onclick = () => {
      if (row.querySelector('.confirm-bar')) return;
      meta.hidden = true;
      const bar = document.createElement('div');
      bar.className = 'confirm-bar';
      const yes = document.createElement('button');
      yes.className = 'yes';
      yes.textContent = '确认删除';
      yes.onclick = () => {
        void rpc('memory.forget', { memoryId: record.id }).then((result) => {
          if (!result.ok) {
            block('status-line error').textContent = `[error] ${result.error.message}`;
          }
          void refreshMemoryList();
        });
      };
      const no = document.createElement('button');
      no.className = 'no';
      no.textContent = '取消';
      no.onclick = () => {
        bar.remove();
        meta.hidden = false;
      };
      bar.append(yes, no);
      row.appendChild(bar);
    };
    row.append(content, meta, del);
    return row;
  }

  function renderMemoryList(records: MemoryRecordView[]): void {
    memoryListPane.innerHTML = '';
    const searchActive = memorySearch.value.trim().length > 0;
    const view = buildMemoryView(records, searchActive);
    if (view.userMemoryEmpty) {
      const empty = document.createElement('div');
      empty.className = 'memory-empty';
      empty.textContent = searchActive ? '没有匹配的用户记忆' : '还没有用户记忆';
      memoryListPane.appendChild(empty);
    }
    for (const { type, records: groupRecords } of view.userGroups) {
      const head = document.createElement('div');
      head.className = 'memory-group';
      head.textContent = `${MEMORY_TYPE_LABELS[type] ?? type} · ${groupRecords.length}`;
      memoryListPane.appendChild(head);
      for (const record of groupRecords) {
        memoryListPane.appendChild(memoryRow(record));
      }
    }
    if (view.experiences.length > 0) {
      const details = document.createElement('details');
      details.className = 'memory-experiences';
      details.open = view.expandExperiences;
      const summary = document.createElement('summary');
      summary.textContent = systemRecordsSummary(view.experiences.length);
      details.appendChild(summary);
      for (const record of view.experiences) {
        details.appendChild(memoryRow(record));
      }
      memoryListPane.appendChild(details);
    }
  }

  async function refreshMemoryList(): Promise<void> {
    const query = memorySearch.value.trim();
    const listed = await (query ? rpc('memory.search', { query }) : rpc('memory.list'));
    if (!listed.ok) {
      memoryListPane.innerHTML = '';
      const failed = document.createElement('div');
      failed.className = 'memory-empty';
      failed.textContent = `记忆库不可用：${listed.error.message}`;
      memoryListPane.appendChild(failed);
      return;
    }
    renderMemoryList((listed.result as { records: MemoryRecordView[] }).records);
  }

  function toggleMemoryPanel(): void {
    memoryPanel.hidden = !memoryPanel.hidden;
    memoryToggle.setAttribute('aria-pressed', String(!memoryPanel.hidden));
    if (!memoryPanel.hidden) {
      void refreshMemoryList();
      memorySearch.focus();
    }
  }
  memoryToggle.onclick = toggleMemoryPanel;

  let memorySearchTimer: ReturnType<typeof setTimeout> | undefined;
  memorySearch.addEventListener('input', () => {
    clearTimeout(memorySearchTimer);
    memorySearchTimer = setTimeout(() => void refreshMemoryList(), 250);
  });

  memoryClearButton.onclick = () => {
    const foot = memoryClearButton.parentElement as HTMLElement;
    if (foot.querySelector('.confirm-bar')) return;
    memoryClearButton.hidden = true;
    const bar = document.createElement('div');
    bar.className = 'confirm-bar';
    const yes = document.createElement('button');
    yes.className = 'yes';
    yes.textContent = '确认清空全部';
    yes.onclick = () => {
      void rpc('memory.clear').then((result) => {
        if (!result.ok) {
          block('status-line error').textContent = `[error] ${result.error.message}`;
        }
        bar.remove();
        memoryClearButton.hidden = false;
        void refreshMemoryList();
      });
    };
    const no = document.createElement('button');
    no.className = 'no';
    no.textContent = '取消';
    no.onclick = () => {
      bar.remove();
      memoryClearButton.hidden = false;
    };
    bar.append(yes, no);
    foot.appendChild(bar);
  };

  // ── 控件 ────────────────────────────────────────────────────

  workspaceChip.onclick = async () => {
    const picked = await window.tachikoma.pickWorkspace();
    if (!picked) return;
    await startSession({ workDir: picked, toolset: selectedToolset });
  };
  accessChip.onclick = () => workspaceChip.click(); // composer 权限芯片=同一授予入口

  // ── 附件：+ 选文件 → 芯片行 → 文本定界内联 / 图片走 images ────
  type PendingAttachment =
    | { kind: 'text'; name: string; text: string; size: number }
    | { kind: 'image'; name: string; data: string; mimeType: string; size: number };
  let pendingAttachments: PendingAttachment[] = [];

  function renderAttachments(): void {
    attachmentsRow.innerHTML = '';
    attachmentsRow.hidden = pendingAttachments.length === 0;
    pendingAttachments.forEach((file, index) => {
      attachmentsRow.appendChild(
        attachmentChip(
          file.name,
          file.size,
          () => {
            pendingAttachments.splice(index, 1);
            renderAttachments();
          },
          file.kind
        )
      );
    });
  }

  attachButton.onclick = async () => {
    const picked = await window.tachikoma.pickFiles();
    for (const file of picked) {
      if (file.imageBase64 && file.mimeType) {
        pendingAttachments.push({
          kind: 'image',
          name: file.name,
          data: file.imageBase64,
          mimeType: file.mimeType,
          size: file.size,
        });
      } else if (file.text !== undefined && !file.error) {
        pendingAttachments.push({
          kind: 'text',
          name: file.name,
          text: file.text,
          size: file.size,
        });
      } else {
        block('status-line error').textContent = `[附件] ${file.name}: ${file.error ?? '读取失败'}`;
      }
    }
    renderAttachments();
    input.focus();
  };

  toolsetGroup.addEventListener('click', async (mouse) => {
    const target = mouse.target as HTMLElement;
    const toolset = target.dataset.toolset as 'read-only' | 'coding' | undefined;
    if (!toolset || toolset === selectedToolset) return;
    selectedToolset = toolset;
    refreshInstrumentCluster();
    if (grantedWorkspace) {
      // 已有工作区：切换工具集 = 显式重新授予，立即开新会话生效。
      await startSession({ workDir: grantedWorkspace.root, toolset });
    } else {
      // 无工作区时点工具集只是亮个灯没有任何效果——直接引导去选目录完成授予。
      const picked = await window.tachikoma.pickWorkspace();
      if (picked) await startSession({ workDir: picked, toolset });
    }
  });

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if ((!text && pendingAttachments.length === 0) || !sessionId || generating) return;
    // 文本附件以定界块内联在正文前（转录即事实源）；图片走 send 的 images 通道
    const blocks = pendingAttachments
      .filter((file): file is Extract<PendingAttachment, { kind: 'text' }> => file.kind === 'text')
      .map(
        (file) =>
          `${ATTACHMENT_OPEN(file.name.replace(/["\n]/g, '_'))}\n${file.text}\n</tachikoma:attachment>`
      );
    const images = pendingAttachments
      .filter(
        (file): file is Extract<PendingAttachment, { kind: 'image' }> => file.kind === 'image'
      )
      .map((file) => ({ name: file.name, mimeType: file.mimeType, data: file.data }));
    const payload =
      [...blocks, text].filter(Boolean).join('\n\n') ||
      (images.length > 0 ? '（请看附件图片）' : '');
    input.value = '';
    pendingAttachments = [];
    renderAttachments();
    autosizeInput();
    // 用户回合不本地回显：user_message 事件是唯一渲染来源（live 与重放一致）
    const sent = await rpc('session.send', {
      sessionId,
      text: payload,
      ...(images.length > 0 ? { images } : {}),
    });
    if (!sent.ok) {
      block('status-line error').textContent = `[error] ${sent.error.message}`;
    }
  }

  sendButton.onclick = () => {
    if (generating) {
      void rpc('session.abort', { sessionId });
    } else {
      void submit();
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });

  function toggleSessionsPanel(): void {
    sessionsPanel.hidden = !sessionsPanel.hidden;
    sessionsToggle.setAttribute('aria-pressed', String(!sessionsPanel.hidden));
    if (!sessionsPanel.hidden) void refreshSessionList();
  }
  sessionsToggle.onclick = toggleSessionsPanel;

  // 全局快捷键：⌘N 新会话、⌘B 会话栏、⌘M 记忆抽屉（Windows/Linux 用 Ctrl）
  document.addEventListener('keydown', (key) => {
    if (!(key.metaKey || key.ctrlKey)) return;
    if (key.key === 'n') {
      key.preventDefault();
      newSessionButton.click();
    } else if (key.key === 'b') {
      key.preventDefault();
      toggleSessionsPanel();
    } else if (key.key === 'm') {
      key.preventDefault();
      toggleMemoryPanel();
    }
  });

  // ── 生成参数：模型与 thinking（RPC 均为既有方法） ──────────────
  // 模型选择走主题内自绘面板：原生 datalist 会被预填值过滤成单条，且弹层是白底原生样式。
  interface ModelEntry {
    provider: string;
    model: string;
    reasoning: boolean;
    contextWindow?: number;
    maxTokens?: number;
  }
  let allModels: ModelEntry[] | undefined;
  const PICKER_ROW_CAP = 200;

  async function ensureModels(): Promise<ModelEntry[]> {
    if (!allModels) {
      const listed = await rpc('engine.listModels');
      if (!listed.ok) {
        block('status-line error').textContent = `[error] ${listed.error.message}`;
        return [];
      }
      allModels = (listed.result as { models: ModelEntry[] }).models;
    }
    return allModels;
  }

  function formatCtx(tokens: number): string {
    if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}m`;
    return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
  }

  async function chooseModel(value: string): Promise<void> {
    closeModelPicker();
    if (!value || value === currentModel) return;
    const separator = value.indexOf('/');
    const changed = await rpc('session.setModel', {
      sessionId,
      model: { provider: value.slice(0, separator), model: value.slice(separator + 1) },
    });
    if (changed.ok) {
      currentModel = value;
      setModelChip(value);
      refreshInstrumentCluster();
      void updateCtxGauge();
    } else {
      block('status-line error').textContent = `[error] ${changed.error.message}`;
    }
  }

  function renderModelOptions(query: string): void {
    const needle = query.trim().toLowerCase();
    const matches = (allModels ?? []).filter((entry) =>
      `${entry.provider}/${entry.model}`.toLowerCase().includes(needle)
    );
    modelOptions.innerHTML = '';
    for (const entry of matches.slice(0, PICKER_ROW_CAP)) {
      const value = `${entry.provider}/${entry.model}`;
      const row = document.createElement('div');
      row.className = `model-row${value === currentModel ? ' active' : ''}`;
      const name = document.createElement('span');
      name.textContent = value;
      row.appendChild(name);
      if (entry.reasoning) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'reasoning';
        row.appendChild(tag);
      }
      if (entry.contextWindow) {
        const ctx = document.createElement('span');
        ctx.className = 'ctx';
        ctx.textContent = formatCtx(entry.contextWindow);
        if (!entry.reasoning) ctx.style.marginLeft = 'auto';
        row.appendChild(ctx);
      }
      row.onclick = () => void chooseModel(value);
      modelOptions.appendChild(row);
    }
    if (matches.length > PICKER_ROW_CAP) {
      const hint = document.createElement('div');
      hint.className = 'model-row hint';
      hint.textContent = `还有 ${matches.length - PICKER_ROW_CAP} 个——继续输入过滤`;
      modelOptions.appendChild(hint);
    }
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-row hint';
      empty.textContent = '没有匹配的模型';
      modelOptions.appendChild(empty);
    }
  }

  function closeModelPicker(): void {
    modelPicker.hidden = true;
  }

  async function openModelPicker(): Promise<void> {
    if ((await ensureModels()).length === 0) return;
    modelPicker.hidden = false;
    modelFilter.value = '';
    renderModelOptions('');
    modelFilter.focus();
  }

  // ── 上下文用量仪表：上回合 tokens / 当前模型窗口；>70% 转琥珀并给出压缩入口 ──

  let lastTurnTokens = 0;

  async function updateCtxGauge(): Promise<void> {
    if (!lastTurnTokens || !currentModel) {
      ctxGauge.hidden = true;
      return;
    }
    const entry = (await ensureModels()).find(
      (model) => `${model.provider}/${model.model}` === currentModel
    );
    const window = entry?.contextWindow;
    if (!window) {
      ctxGauge.hidden = true;
      return;
    }
    const percent = Math.min(100, Math.round((lastTurnTokens / window) * 100));
    ctxGauge.hidden = false;
    ctxGauge.title = `上下文用量 ${formatCtx(lastTurnTokens)} / ${formatCtx(window)}`;
    (ctxGauge.querySelector('.fill') as HTMLElement).style.width = `${Math.max(percent, 2)}%`;
    (ctxGauge.querySelector('.pct') as HTMLElement).textContent = `${percent}%`;
    const warn = percent >= 70;
    ctxGauge.classList.toggle('warn', warn);
    compactNowButton.hidden = !warn;
  }

  function resetCtxGauge(): void {
    lastTurnTokens = 0;
    ctxGauge.hidden = true;
    ctxGauge.classList.remove('warn');
    compactNowButton.hidden = true;
  }

  compactNowButton.onclick = async () => {
    compactNowButton.disabled = true;
    const compacted = await rpc('session.compact', { sessionId });
    compactNowButton.disabled = false;
    if (compacted.ok) {
      const result = compacted.result as { tokensBefore?: number; estimatedTokensAfter?: number };
      block('status-line').textContent =
        `[compaction] 完成${result.tokensBefore ? ` · ${formatCtx(result.tokensBefore)} → ${result.estimatedTokensAfter ? formatCtx(result.estimatedTokensAfter) : '…'}` : ''}`;
      resetCtxGauge();
    } else {
      block('status-line error').textContent = `[error] ${compacted.error.message}`;
    }
  };

  modelChip.onclick = () => {
    if (modelPicker.hidden) {
      void openModelPicker();
    } else {
      closeModelPicker();
    }
  };
  modelFilter.addEventListener('input', () => renderModelOptions(modelFilter.value));
  modelFilter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModelPicker();
    } else if (event.key === 'Enter') {
      const first = modelOptions.querySelector('.model-row:not(.hint)');
      const value = first?.querySelector('span')?.textContent;
      if (value) void chooseModel(value);
    }
  });
  document.addEventListener('click', (event) => {
    if (modelPicker.hidden) return;
    const target = event.target as Node;
    if (!modelPicker.contains(target) && target !== modelChip) closeModelPicker();
  });
  thinkingSelect.addEventListener('change', async () => {
    const changed = await rpc('session.setThinkingLevel', {
      sessionId,
      level: thinkingSelect.value,
    });
    if (!changed.ok) {
      block('status-line error').textContent = `[error] ${changed.error.message}`;
    }
  });
  newSessionButton.onclick = () => {
    void startSession(
      grantedWorkspace ? { workDir: grantedWorkspace.root, toolset: selectedToolset } : {}
    ).then(() => refreshSessionList());
  };

  await startSession({});
  await refreshSessionList();
}

boot().catch((error: unknown) => {
  statusLine(`boot failed: ${error instanceof Error ? error.message : String(error)}`);
});

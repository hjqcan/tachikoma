/**
 * 会话事件 WAL：<dataDir>/sessions/<sessionId>.events.jsonl
 * （与 pi 的 *_<sessionId>.jsonl 会话文件同目录不同名）。
 *
 * 不变量：先写 WAL 再扇出；seq 会话内单调；崩溃后未终结的回合在下次加载时
 * 补发合成 message_complete{failed}——合成帧同样入 WAL，保证重放游标一致。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatEventWire, SessionEventFrame } from '@tachikoma/protocol';
import { FRAME_VERSION, parseSessionEventFrame } from '@tachikoma/protocol';

export class SessionWal {
  private nextSeq = 1;
  private chain: Promise<void> = Promise.resolve();
  private frames: SessionEventFrame[] = [];

  private constructor(
    private readonly path: string,
    private readonly sessionId: string
  ) {}

  static async load(dataDir: string, sessionId: string): Promise<SessionWal> {
    const wal = new SessionWal(join(dataDir, 'sessions', `${sessionId}.events.jsonl`), sessionId);
    await mkdir(dirname(wal.path), { recursive: true });
    let content = '';
    try {
      content = await readFile(wal.path, 'utf8');
    } catch {
      // 尚无 WAL 文件。
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue; // 尾部半行（崩溃截断）容忍
      }
      const parsed = parseSessionEventFrame(raw);
      if (parsed.ok && parsed.known) {
        wal.frames.push(parsed.frame);
        wal.nextSeq = Math.max(wal.nextSeq, parsed.frame.seq + 1);
      } else if (parsed.ok) {
        // 未知事件（未来版本写入的）：保 seq 游标，不进已知帧列表。
        wal.nextSeq = Math.max(wal.nextSeq, parsed.frame.seq + 1);
      }
    }
    const synthetic = wal.unterminatedTurnSynthetic();
    if (synthetic) {
      await wal.append(synthetic);
    }
    return wal;
  }

  /** 上次进程死亡时未终结的回合 → 合成 failed 终结事件 */
  private unterminatedTurnSynthetic(): ChatEventWire | null {
    const last = this.frames.at(-1);
    if (!last) return null;
    const turnId = last.event.turnId;
    const terminated = this.frames.some(
      (frame) => frame.event.turnId === turnId && frame.event.type === 'message_complete'
    );
    if (terminated) return null;
    const start = this.frames.find(
      (frame) => frame.event.turnId === turnId && frame.event.type === 'message_start'
    );
    return {
      type: 'message_complete',
      sessionId: this.sessionId,
      turnId,
      timestamp: Date.now(),
      messageId: start?.event.type === 'message_start' ? start.event.messageId : turnId,
      status: 'failed',
      content: '',
      model: { provider: 'unknown', model: 'unknown' },
      stopReason: 'error',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      error: 'engine restarted',
    };
  }

  /** 分配 seq、串行落盘；返回写完的帧（调用方随后扇出） */
  append(event: ChatEventWire): Promise<SessionEventFrame> {
    const frame: SessionEventFrame = {
      v: FRAME_VERSION,
      sessionId: this.sessionId,
      seq: this.nextSeq,
      event,
    };
    this.nextSeq += 1;
    this.frames.push(frame);
    const write = this.chain.then(() => appendFile(this.path, `${JSON.stringify(frame)}\n`));
    this.chain = write.catch(() => undefined);
    return write.then(() => frame);
  }

  read(fromSeq: number): SessionEventFrame[] {
    return this.frames.filter((frame) => frame.seq > fromSeq);
  }
}

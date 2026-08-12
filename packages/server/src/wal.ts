/**
 * 会话事件 WAL：<dataDir>/events/<sessionId>.jsonl
 *
 * 必须与 pi 的 sessions/ 目录分离：曾与转录同目录（*.events.jsonl），被 core 的
 * 损坏会话扫描当成幻影会话列出，删除幻影时按文件名回退匹配还会连带 unlink 真会话
 * 的 WAL（真实事故）。load 时自动把旧路径迁移过来。
 *
 * 不变量：先写 WAL 再扇出；seq 会话内单调；崩溃后未终结的回合在下次加载时
 * 补发合成 message_complete{failed}——合成帧同样入 WAL，保证重放游标一致。
 */

import { access, appendFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
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

  private static walPath(dataDir: string, sessionId: string): string {
    return join(dataDir, 'events', `${sessionId}.jsonl`);
  }

  /** 迁移前的旧路径（与 pi 转录同目录的时代） */
  private static legacyPath(dataDir: string, sessionId: string): string {
    return join(dataDir, 'sessions', `${sessionId}.events.jsonl`);
  }

  static async load(dataDir: string, sessionId: string): Promise<SessionWal> {
    const wal = new SessionWal(SessionWal.walPath(dataDir, sessionId), sessionId);
    await mkdir(dirname(wal.path), { recursive: true });
    // 旧布局迁移：sessions/<id>.events.jsonl → events/<id>.jsonl。
    // 只在新路径不存在时迁移——POSIX rename 会覆盖目标，绝不能拿旧账本盖掉新账本。
    try {
      await access(wal.path);
    } catch {
      await rename(SessionWal.legacyPath(dataDir, sessionId), wal.path).catch(() => undefined);
    }
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

  /** 会话删除时销毁账本：等在途写入落定后删文件（幂等） */
  async destroy(): Promise<void> {
    await this.chain;
    this.frames = [];
    await unlink(this.path).catch(() => undefined);
  }

  /** 未加载过的会话直接按路径删账本文件（幂等；新旧布局都清） */
  static async delete(dataDir: string, sessionId: string): Promise<void> {
    await unlink(SessionWal.walPath(dataDir, sessionId)).catch(() => undefined);
    await unlink(SessionWal.legacyPath(dataDir, sessionId)).catch(() => undefined);
  }
}

/**
 * live 流 ⟷ history() 一致性 —— dsh「Model-visible ⟺ logged」不变量的 tachikoma 版。
 *
 * 同一份真相（pi 转录）有两条派生路径：live 流（send 逐事件）与 history()
 * （server 重建事件账本用）。两条路径经同一投影（history 可比子集：去掉
 * history 明文不重建的 reasoning/审批/retry/compaction，id/时间戳/usage 已抹）
 * 后必须逐字节一致——否则渲染器重放看到的历史与用户当时看到的对话漂移。
 */

import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../src';
import type { ChatEvent } from '../src';
import { projectEvents } from './event-projection';
import { createFauxHarness } from './helpers';

describe('live 流 ⟷ history() 一致性', () => {
  it('文本+思考+工具回合+审批批准/拒绝：两条派生路径投影一致', async () => {
    const harness = await createFauxHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-history-ws-'));
    await writeFile(join(workDir, 'data.txt'), 'CONSISTENCY-MARKER\n');
    try {
      harness.faux.setResponses([
        // 回合 1：思考 + 中间文本与工具调用同消息 + 收尾文本 —— 专门覆盖
        // 「complete.content 取什么」这类最易漂移的形状。
        fauxAssistantMessage(
          [
            fauxThinking('read it first'),
            fauxText('Let me read the file. '),
            fauxToolCall('read', { path: 'data.txt' }),
          ],
          { stopReason: 'toolUse' }
        ),
        fauxAssistantMessage([fauxText('The marker is CONSISTENCY-MARKER.')]),
        // 回合 2：write 批准落盘，bash 拒绝出错误结果。
        fauxAssistantMessage([fauxToolCall('write', { path: 'out.txt', content: 'OK' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxText('Wrote the file; the command was denied.')]),
      ]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
          workDir,
          toolset: 'coding',
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      const sessionId = session.id;
      const live: ChatEvent[] = [];
      const turns = ['read data.txt', 'write out.txt then run echo'];
      const approvals: Record<string, boolean> = { write: true, bash: false };
      for (const turn of turns) {
        for await (const event of session.send(turn)) {
          live.push(event);
          if (event.type === 'tool_approval_request') {
            session.respondToApproval(event.callId, approvals[event.tool] ?? true);
          }
        }
      }
      await session.close();

      const history = await engine.history(sessionId);
      const projection = { historyComparable: true as const };
      expect(projectEvents(history, projection)).toEqual(projectEvents(live, projection));
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });
});

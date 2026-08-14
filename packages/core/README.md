# @hjqcan/tachikoma-core

Tachikoma 0.2 的 chat-only 核心。它把 `@earendil-works/pi-coding-agent`
的模型、流式响应、重试、压缩和 JSONL 会话生命周期收敛成一层很薄的公共 API。

本版本只接受文本输入，并通过 pi 的 `noTools: 'all'`
创建会话。它不读取工作目录、不注册工具，也不提供任务规划或调度能力。

## 安装

```bash
bun add @hjqcan/tachikoma-core
```

要求 Bun 1.3.14 或更新版本。

## 使用

```ts
import { ChatEngine } from '@hjqcan/tachikoma-core';

const engine = new ChatEngine({
  model: { provider: 'anthropic', model: 'claude-sonnet-5' },
});
const session = await engine.createSession();

for await (const event of session.send('你好')) {
  if (event.type === 'message_delta') {
    process.stdout.write(event.text);
  }
}

await session.close();
```

`ChatEngine` 只负责 `createSession`、`openSession`、`listSessions` 与 `deleteSession`。每个
`ChatSession` 独立持有一个 pi `AgentSession`，并提供：

- `send`、`abort` 与 `close`
- `setModel` 与 `setThinkingLevel`
- `compact`

公共模型引用只有
`{ provider, model }`。凭证由 pi 自己管理，不进入 Tachikoma 的公共配置、会话对象或事件。

## 会话与事件

pi `SessionManager` 的 append-only JSONL v3 是 transcript、恢复、模型变更、thinking
level 与压缩记录的唯一真相，默认位于 `~/.tachikoma/sessions`。

`send()` 返回 `ChatEvent` 异步流。公开事件仅有：

- `message_start`
- `message_delta`
- `reasoning_delta`
- `retry`
- `compaction`
- `memory_status`
- `message_complete`

每轮恰好以一个 `message_complete` 结束，状态为 `success`、`interrupted` 或
`failed`，并携带 pi 的完整 usage。

## GoodMemory

GoodMemory 默认开启，SQLite 默认位于 `~/.tachikoma/memory/goodmemory.sqlite`。传入 `memory: false`
才会关闭。

召回或写回失败不会中断聊天；`memory_status` 事件和 `session.memoryStatus` 快照会明确显示 `degraded`
或 `write-failed`。Tachikoma 直接使用 `goodmemory/runtime-kit`
的 session、recall 与 writeback 生命周期，不维护第二套记忆状态。

## 第一圈边界

- 仅文本聊天
- 零活动工具
- 无工作目录或自定义工具配置
- 无 HTTP、桌面端或调度运行时
- 不兼容 0.1 API 与旧会话格式

# Context Engineering Module

上下文工程模块，实现基于 Manus 最佳实践的智能上下文管理。

## 核心功能

- **压缩策略** - 可逆压缩，保留恢复标识符
- **摘要策略** - 结构化摘要，使用固定 Schema
- **卸载策略** - 文件系统即上下文
- **KV 缓存优化** - 提高缓存命中率
- **笔记系统** - 通过复述操控注意力
- **模型感知配置** - 根据模型窗口自动调整阈值

## 快速开始

```typescript
import {
  createContextManager,
  createDefaultContextConfig,
  createModelAwareConfig,
} from '@tachikoma/core';

// 方式 1：使用默认配置
const config = createDefaultContextConfig('/path/to/work');
const manager = createContextManager(config);

// 方式 2：使用模型感知配置
const config = createModelAwareConfig('claude-3-sonnet', '/path/to/work');
const manager = createContextManager(config);

// 添加消息
manager.addMessage({
  id: '1',
  role: 'user',
  content: '...',
  timestamp: Date.now(),
  format: 'full',
});

// 检查是否需要缩减
if (manager.needsReduction()) {
  await manager.autoReduce();
}

// 获取优化后的上下文
const context = manager.getContext();
```

## 阈值配置

```typescript
import { DEFAULT_THRESHOLDS, computeModelAwareThresholds } from '@tachikoma/core';

// 默认阈值（Manus 推荐）
// softLimit: 100,000 tokens - 触发压缩
// hardLimit: 180,000 tokens - 触发摘要
// rotThreshold: 128,000 tokens - 上下文腐烂阈值

// 模型感知阈值
const thresholds = computeModelAwareThresholds('claude-3-sonnet');
// hardLimit = 160,000 (200K × 0.8)
```

## Token 估算

```typescript
import { createTokenEstimator } from '@tachikoma/core';

// 简单估算器
const simple = createTokenEstimator('simple');

// 字符感知估算器（中英文优化）
const charBased = createTokenEstimator('character-based');

// 自定义估算器
const config = createDefaultContextConfig('/path');
config.tokenEstimator = (content) => myEstimator(content);
```

## 笔记系统

```typescript
// 添加待办
manager.addTodo('完成用户认证模块');

// 添加发现
manager.addFinding('发现性能瓶颈在数据库查询');

// 获取笔记
const notes = manager.getNotes();

// 注入状态提醒到上下文
manager.injectStatusReminder();
```

## 与 GenericAgentBackend 集成

```typescript
import { GenericAgentBackend } from '@tachikoma/core';

const backend = new GenericAgentBackend({
  llmClient,
  contextManagerConfig: createModelAwareConfig('claude-3-sonnet', workDir),
  workDir: '/path/to/work',
});

// 执行时自动：
// 1. 每轮 LLM 调用前检查 needsReduction()
// 2. 超过软限制自动 autoReduce()
// 3. 超过硬限制中止执行
```

## 目录结构

```
context/
├── index.ts              # 模块入口
├── types.ts              # 类型定义
├── context-manager.ts    # 核心管理器
├── token-estimator.ts    # Token 估算器
├── strategies/
│   ├── compaction.ts     # 压缩策略
│   ├── summarization.ts  # 摘要策略
│   └── offload.ts        # 卸载策略
├── cache/
│   └── prefix-optimizer.ts # KV 缓存优化
└── memory/
    └── note-taking.ts    # 笔记系统
```

## API 参考

### createContextManager(config, deps?)

创建上下文管理器实例。

### createDefaultContextConfig(workDir)

创建默认配置。

### createModelAwareConfig(modelId, workDir)

创建模型感知配置。

### computeModelAwareThresholds(modelId)

计算模型感知阈值。

### createTokenEstimator(type)

创建 Token 估算器。

## 相关文档

- [上下文工程模块实现总结](../../../docs/上下文工程模块实现总结.md)

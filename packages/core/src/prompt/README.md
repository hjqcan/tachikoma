# Prompt Context Engineering (Internal)

Prompt 上下文工程模块：实现基于 Manus 最佳实践的上下文压缩/摘要/卸载、KV 缓存优化与笔记系统。

注意：该模块属于内部 API，不作为 `@tachikoma/core` 的稳定对外 API。

## 核心功能

| 功能           | 描述                                                                |
| -------------- | ------------------------------------------------------------------- |
| 压缩策略       | 可逆压缩，保留恢复标识符                                            |
| 摘要策略       | 结构化摘要，使用固定 Schema                                         |
| 卸载策略       | 文件系统即上下文                                                    |
| KV 缓存优化    | Provider-agnostic 策略 + 原生 cache_control 透传                    |
| 笔记系统       | 通过复述操控注意力                                                  |
| 自动上下文管理 | 智能检测与自动压缩                                                  |
| 项目上下文注入 | 支持 agents.md 规范（AGENTS.md/CLAUDE.md/CURSOR.md/TACHIKOMA.md等） |
| 向量存储       | 语义相似度搜索 (cosine/euclidean/dot)                               |

## 目录结构

```
prompt/
├── index.ts              # 模块入口
├── types.ts              # 类型定义
├── prompt-engine.ts      # 核心引擎
├── token-estimator.ts    # Token 估算器
├── auto-manager.ts       # 自动上下文管理
├── strategies/           # 压缩/摘要/卸载策略
├── cache/                # 缓存优化 (provider-adapters, local-cache, strategies)
├── memory/               # 记忆系统 (file-store, working-memory, vector-store)
└── project/              # 项目上下文注入器
```

## 快速开始

```typescript
import {
  createPromptContextEngine,
  createDefaultPromptConfig,
  createAutoContextManager,
  createProjectContextInjector,
} from '@tachikoma/core/internal/prompt';

// 创建引擎
const config = createDefaultPromptConfig('/path/to/work');
const engine = createPromptContextEngine(config);

// 自动管理
const manager = createAutoContextManager(engine, { compactCheckInterval: 5 });
engine.addMessage({
  id: 'user-1',
  role: 'user',
  content: 'Hello',
  timestamp: Date.now(),
  format: 'full',
});
await manager.onMessageAdded();
await manager.waitForPendingReduction();

// 项目上下文
const injector = createProjectContextInjector();
const context = await injector.getProjectContext('/path/to/project');
```

## 向量存储

```typescript
import {
  createInMemoryVectorStore,
  createSimpleEmbeddingProvider,
} from '@tachikoma/core/internal/prompt';

const store = createInMemoryVectorStore({ similarityMethod: 'cosine' });
const embedder = createSimpleEmbeddingProvider(128);

const embedding = await embedder.embed('Hello world');
await store.add({ id: '1', content: 'Hello world', embedding });

const results = await store.search(await embedder.embed('Hi'), 5);
```

## API 参考

### 核心

- `createPromptContextEngine(config, deps?)` - 创建引擎
- `createDefaultPromptConfig(workDir)` - 默认配置
- `createModelAwarePromptConfig(modelId, workDir)` - 模型感知配置

### 自动管理

- `createAutoContextManager(engine, config)` - 自动管理器
- `createSmartCompactionDecider()` - 智能决策器

### 项目上下文

- `createProjectContextInjector()` - 项目上下文注入器

### 向量存储

- `createInMemoryVectorStore(config)` - 内存向量存储
- `createSimpleEmbeddingProvider(dimension)` - 简单嵌入生成器

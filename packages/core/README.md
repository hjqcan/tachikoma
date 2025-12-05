# @tachikoma/core

Tachikoma 核心库 - 提供智能体、上下文管理、工具、沙盒、MCP 集成等核心功能。

## 安装

```bash
bun add @tachikoma/core
```

## 模块

| 模块      | 描述                           |
| --------- | ------------------------------ |
| `agents`  | 智能体实现（统筹者、工作者等） |
| `context` | 上下文管理（压缩、摘要、卸载） |
| `tools`   | 原子工具库                     |
| `sandbox` | 沙盒管理                       |
| `mcp`     | MCP 集成                       |

## 使用

```typescript
import { VERSION } from '@tachikoma/core';

console.log(`Tachikoma Core v${VERSION}`);
```

## 开发

```bash
# 运行测试
bun test

# 类型检查
bun run typecheck

# 构建
bun run build
```

## 许可证

MIT

# @tachikoma/servers

Tachikoma MCP 服务器代理 - 外部工具集成。

## 核心文件

| 文件         | 描述                                              |
| ------------ | ------------------------------------------------- |
| `_types.ts`  | 公共类型定义（MCPToolResult, ToolCallOptions 等） |
| `_client.ts` | callMCPTool() 核心调用函数                        |
| `index.ts`   | 模块入口，统一导出                                |

## 目录结构

```
servers/
├── _types.ts           # 公共类型
├── _client.ts          # 调用客户端
├── index.ts            # 入口
├── google-drive/       # Google Drive 工具包装器
│   ├── getDocument.ts
│   └── index.ts
├── github/             # GitHub 工具包装器
│   ├── createPR.ts
│   └── index.ts
└── ...
```

## 使用方式

### 代码执行模式（Agent 生成代码）

```typescript
import * as gdrive from './servers/google-drive';
import * as github from './servers/github';

// 读取文档
const doc = await gdrive.getDocument({ documentId: 'abc123' });
if (doc.success) {
  console.log(doc.data);
}

// 创建 PR
const pr = await github.createPR({
  repo: 'owner/repo',
  title: 'Feature: Add auth',
  body: 'Implements JWT authentication',
});
```

### 底层 API

```typescript
import { callMCPTool, setMCPClient } from './servers';

// 在宿主进程中设置客户端（必需）
import { MCPClientManager } from '@tachikoma/core';
const manager = new MCPClientManager();
setMCPClient(manager);

// 调用工具
const result = await callMCPTool('filesystem', 'read_file', {
  path: '/workspace/README.md',
});
```

## 开发工具包装器

使用 `createToolCaller` 创建类型安全的工具函数：

```typescript
import { createToolCaller, type MCPToolResult } from '../';

interface ReadFileInput {
  path: string;
}

export const readFile = createToolCaller<ReadFileInput, string>('filesystem', 'read_file');
```

## 返回值解析规则

`callMCPTool()` 对 MCP 工具返回值的处理逻辑：

1. **文本内容**：默认尝试 JSON.parse()，失败则返回原始文本字符串
2. **非文本内容**（resource/image）：当 `includeRawContent=true` 时，直接返回 `rawContent` 数组
3. **错误响应**：`isError=true` 时返回 `{ success: false, error: "..." }`

```typescript
// 获取原始 MCP 内容（包含 resource/image）
const result = await callMCPTool('server', 'tool', args, {
  includeRawContent: true,
});
if (result.rawContent) {
  // 处理非文本内容
}
```

## 导入路径

根据使用场景选择导入方式：

| 场景              | 导入路径                                   |
| ----------------- | ------------------------------------------ |
| 沙盒内 Agent 代码 | `import { callMCPTool } from './servers'`  |
| 宿主进程直接使用  | `import { ... } from '@tachikoma/servers'` |
| 工具包装器开发    | `import { createToolCaller } from '../'`   |

## 许可证

MIT

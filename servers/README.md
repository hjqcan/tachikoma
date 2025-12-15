# @tachikoma/servers

MCP 服务器代理模块 - 实现 **Code Execution with MCP** 模式。

## 背景

这个模块是 Anthropic 官方博客文章
[Code Execution with MCP: Building More Efficient Agents](https://www.anthropic.com/news/code-execution-with-mcp)
的实现。

### 核心问题

传统 MCP 工具调用有两大效率问题：

| 问题             | 描述                               | Token 浪费     |
| ---------------- | ---------------------------------- | -------------- |
| **工具定义膨胀** | 上千个工具的定义全部加载到 context | 数十万 tokens  |
| **中间结果传递** | 每个工具返回值都要流入 context     | 大文件多次传递 |

### 解决方案：Code Execution

让 Agent **写代码调用工具**，而不是用 XML 工具调用：

```typescript
// ❌ 传统方式：50k 会议记录进入 context 两次
TOOL CALL: gdrive.getDocument(id) → 50k tokens 进 context
TOOL CALL: salesforce.update(notes: "...")  → 再写出 50k tokens

// ✅ 代码执行方式：数据在沙盒内流转，不进 context
const transcript = await gdrive.getDocument({ id });
await salesforce.updateRecord({ data: { Notes: transcript } });
// transcript 只在沙盒内，节省 98.7% tokens！
```

## 架构

```
传统 MCP 调用:
┌─────┐     <tool_call>      ┌─────────┐      结果      ┌─────┐
│ LLM │ ──────────────────→ │  宿主   │ ────────────→ │ LLM │
└─────┘                      │ 解析器  │   (进context)  └─────┘
                             └─────────┘

Code Execution with MCP:
┌─────┐    生成代码     ┌─────────┐    callMCPTool()   ┌─────────┐
│ LLM │ ─────────────→ │  沙盒    │ ────────────────→ │  MCP    │
└─────┘                 │ 执行器   │ ←────────────────  │ Server  │
                        └─────────┘   (数据在沙盒内)    └─────────┘
                             │
                             ↓ 只返回 console.log 输出
                        ┌─────┐
                        │ LLM │
                        └─────┘
```

## 目录结构

```
servers/
├── _types.ts           # 公共类型（MCPToolResult, ToolCallOptions）
├── _client.ts          # callMCPTool() 核心调用函数
├── index.ts            # 模块入口
├── calculator/         # 示例：计算器工具包装器
│   └── index.ts
└── [future-servers]/   # 更多 MCP 服务器包装...
    ├── getDocument.ts
    └── index.ts
```

## 使用方式

### Agent 生成代码调用（推荐）

Agent 在沙盒中生成并执行代码：

```typescript
import * as gdrive from './servers/google-drive';
import * as salesforce from './servers/salesforce';

// 读取文档 - 结果留在沙盒
const doc = await gdrive.getDocument({ documentId: 'abc123' });

// 写入 Salesforce - 数据直接流转
await salesforce.updateRecord({
  objectType: 'Lead',
  recordId: '00Q5f...',
  data: { Notes: doc.content },
});

// 只有这行输出会进入 LLM context
console.log('Updated lead with meeting notes');
```

### 底层 API

```typescript
import { callMCPTool, setMCPClient } from './servers';

// 宿主进程设置客户端
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
// servers/google-drive/getDocument.ts
import { createToolCaller, type MCPToolResult } from '../';

interface GetDocumentInput {
  documentId: string;
}

interface GetDocumentResponse {
  content: string;
  title: string;
}

export const getDocument = createToolCaller<GetDocumentInput, GetDocumentResponse>(
  'google-drive',
  'getDocument'
);
```

## 核心优势

| 优势           | 描述                                   |
| -------------- | -------------------------------------- |
| **节省 Token** | 中间数据不进 context，节省 90%+ tokens |
| **渐进披露**   | Agent 按需读取工具定义，不预加载全部   |
| **隐私保护**   | 敏感数据可在沙盒内处理，不进入 LLM     |
| **复杂控制流** | 循环、条件、错误处理用代码而非多轮调用 |
| **状态持久化** | 中间结果可写入文件，跨执行复用         |

## 与 Skills 的关系

| 模块       | 类型 | 内容                            |
| ---------- | ---- | ------------------------------- |
| `skills/`  | 知识 | SKILL.md（工作流指南）          |
| `servers/` | 工具 | TypeScript 函数（调用外部服务） |

Skills 告诉 Agent "怎么做"，Servers 提供 "用什么工具"。

## 返回值处理

`callMCPTool()` 对 MCP 工具返回值的处理逻辑：

1. **文本内容**：尝试 JSON.parse()，失败则返回原始文本
2. **非文本内容**：`includeRawContent=true` 时返回 `rawContent` 数组
3. **错误响应**：`isError=true` 时返回 `{ success: false, error: "..." }`

## 参考

- [Anthropic Blog: Code Execution with MCP](https://www.anthropic.com/news/code-execution-with-mcp)
- [Cloudflare: Code Mode](https://blog.cloudflare.com/agents)
- [MCP Protocol](https://modelcontextprotocol.io/)

## 许可证

MIT

# @tachikoma/servers

Tachikoma MCP 服务器代理 - 外部工具集成。

## 目录结构

```
servers/
├── google-drive/
│   ├── getDocument.ts
│   └── index.ts
├── github/
│   ├── createPR.ts
│   ├── listIssues.ts
│   └── index.ts
├── salesforce/
│   ├── updateRecord.ts
│   └── index.ts
└── ...
```

## MCP 工具以代码 API 形式呈现

智能体生成的代码可以直接导入使用：

```typescript
import * as gdrive from './servers/google-drive';
import * as github from './servers/github';

// 读取文档
const doc = await gdrive.getDocument({ documentId: 'abc123' });

// 创建 PR
await github.createPR({
  repo: 'owner/repo',
  title: 'Feature: Add auth',
  body: 'Implements JWT authentication',
});
```

## 许可证

MIT

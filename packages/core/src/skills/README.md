# Skills 模块

Tachikoma Skills 提供 Claude Agent
Skills 兼容的技能发现、加载和执行功能，并支持从执行轨迹自动学习新技能。

## 核心概念

### 渐进披露机制

Skills 是可复用的领域专业知识包，采用渐进披露机制：

| Level | 加载时机 | Token 成本  | 内容                        |
| ----- | -------- | ----------- | --------------------------- |
| 1     | 启动时   | ~100 tokens | 元数据（name, description） |
| 2     | 触发时   | <5k tokens  | SKILL.md 正文               |
| 3     | 按需     | 无限制      | 脚本和资源                  |

### 技能类型

| 类型         | 说明                          | 应用场景                 |
| ------------ | ----------------------------- | ------------------------ |
| `executable` | 可执行脚本型，自动转换为 Tool | 有 `scripts/` 目录的技能 |
| `knowledge`  | 知识型，仅注入到 Context      | 最佳实践、规范文档等     |

## Skill 目录结构

```
skill-name/
├── SKILL.md           # 主入口（YAML frontmatter + Markdown 正文）
├── resource.md        # 可选：额外参考文档
└── scripts/           # 可选：可执行脚本（仅 executable 类型）
    ├── main.py
    └── utils.py
```

## SKILL.md 格式

```markdown
---
name: skill-name
description: 技能描述，用于 LLM 判断是否相关
skillType: knowledge
category: best-practices
tags:
  - typescript
  - testing
license: MIT
---

# 技能标题

## 工作流

[具体指令...]
```

### Frontmatter 字段

| 字段          | 必选 | 类型                        | 说明                           |
| ------------- | ---- | --------------------------- | ------------------------------ |
| `name`        | ✓    | string                      | kebab-case 名称，最大 100 字符 |
| `description` | ✓    | string                      | 触发条件描述，最大 1024 字符   |
| `skillType`   |      | `executable` \| `knowledge` | 默认 `executable`              |
| `category`    |      | string                      | 分类，如 `code-generation`     |
| `tags`        |      | string[]                    | 用于检索匹配                   |
| `license`     |      | string                      | 许可证信息                     |

## 发现路径

默认搜索以下目录：

1. `~/.tachikoma/skills/` - 全局 Skills
2. `${project}/.tachikoma/skills/` - 项目级 Skills

---

## Memory Blocks（内存块）

Skills 系统使用 Memory Blocks 进行上下文管理：

### Block 类型

| Block           | 说明           | 内容            |
| --------------- | -------------- | --------------- |
| `skills`        | 可用技能列表   | 名称 + 描述摘要 |
| `loaded_skills` | 已加载技能内容 | SKILL.md 正文   |

### API

```typescript
import { getGlobalSkillBlockManager } from '@tachikoma/core/skills';

const blockManager = getGlobalSkillBlockManager();

// 刷新技能列表
blockManager.refreshSkillsBlock(skills);

// 加载/卸载技能
blockManager.loadSkill('skill-name', content);
blockManager.unloadSkill('skill-name');

// 获取已加载技能 ID
const loaded = blockManager.getLoadedSkillIds();

// 渲染为 Prompt
const prompt = blockManager.renderLoadedSkillsForPrompt();
```

---

## Skill Tool

`skillTool` 提供 LLM 可调用的技能管理接口：

```typescript
import { skillTool } from '@tachikoma/core/tools';
import type { ExecutionContext } from '@tachikoma/core';

// 直接调用时需要提供 ExecutionContext（在 Worker 内部调用时会自动注入）
const ctx: ExecutionContext = {
  workDir: process.cwd(),
  permissions: [],
};

// 刷新技能列表
await skillTool.execute({ command: 'refresh' }, ctx);

// 列出已加载技能
await skillTool.execute({ command: 'list' }, ctx);

// 加载技能
await skillTool.execute({ command: 'load', skills: ['git-workflow'] }, ctx);

// 卸载技能
await skillTool.execute({ command: 'unload', skills: ['git-workflow'] }, ctx);
```

---

## Skill Learning（技能学习）

从执行轨迹自动学习新技能：

### 流程

```
执行轨迹 → 反思分析 → 技能生成 → 保存 SKILL.md
```

### API

```typescript
import { learnSkillFromTrajectory } from '@tachikoma/core/skills';

const result = await learnSkillFromTrajectory(trajectory, {
  llmCall: async (prompt) => /* LLM 调用 */,
  skillsDir: '.tachikoma/skills',
  taskDescription: 'API 实现模式',
  userGuidance: '关注错误处理',
  onSkillsRefresh: async () => { /* 刷新回调 */ },
});

if (result.success) {
  console.log(`Created skill: ${result.skill.name}`);
}
```

### 轨迹格式

```typescript
// 实际类型以 `packages/core/src/skills/learning/reflection.ts` 的导出为准
interface TrajectoryRecord {
  id: string;
  timestamp: number;
  subtaskId?: string;
  type: 'thinking' | 'action' | 'tool_call' | 'error';
  content: string;
  stage?: string;
  confidence?: number;
  toolName?: string;
  relatedTools?: string[];
  toolParams?: Record<string, unknown>;
  result?: { success: boolean; output?: unknown; error?: string; duration?: number };
}
```

---

## /skill CLI 命令

ConversationalRunner 提供交互式技能管理：

| 命令                   | 功能                                               |
| ---------------------- | -------------------------------------------------- |
| `/skill`               | 显示帮助                                           |
| `/skill list`          | 列出可用技能（✓=已加载，[K]=知识型，[E]=可执行型） |
| `/skill load <name>`   | 加载技能到上下文                                   |
| `/skill unload <name>` | 从上下文卸载技能                                   |
| `/skill learn [描述]`  | 从最近执行轨迹学习技能                             |

> 提示：`/skill learn` 需要 ConversationalRunner 的 LLM 配置（`llm.apiKey/model/baseUrl`）可用。

---

## 核心 API

### loadSkills

发现并加载 Skills 元数据。

```typescript
const outcome = loadSkills({
  enabled: true,
  globalDir: '~/.tachikoma/skills',
});
```

### renderSkillsSection

渲染 Skills 到 system prompt。

```typescript
const section = renderSkillsSection(outcome.skills);
```

### loadSkillContent

加载 Skill 完整内容（Level 2）。

```typescript
const content = await loadSkillContent(skill);
```

### executeSkillScript

通过 Sandbox 执行 Skill 脚本（Level 3）。

```typescript
const result = await executeSkillScript(
  {
    skill: content,
    script: 'scripts/main.py',
  },
  sandbox
);
```

---

## 配置选项

```typescript
interface SkillDiscoveryConfig {
  globalDir?: string; // 全局 Skills 目录
  projectDir?: string; // 项目级目录
  additionalDirs?: string[]; // 额外目录
  enabled?: boolean; // 启用/禁用
  ignoreDirs?: string[]; // 扫描时忽略的目录
  maxSkillTokens?: number; // Skills section 最大 token 预算（默认 2000）
}
```

---

## 注意事项

### YAML 格式限制

内置 YAML 解析器是轻量子集，支持：

- 简单的 `key: value` 格式
- 双引号/单引号字符串
- `|-` 多行字符串
- YAML 列表（`tags:` 格式）

**不支持**：复杂嵌套、YAML 锚点、带特殊字符的键名。

### name 格式建议

推荐使用 kebab-case（如 `pdf-processing`），非规范名称会输出警告。

### 安全

- 脚本执行有目录穿越保护
- System prompt 不暴露绝对路径
- 扫描默认跳过 `node_modules`、`dist` 等大目录

# Skills 模块

Tachikoma Skills 提供 Claude Agent Skills 兼容的技能发现、加载和执行功能。

## 核心概念

Skills 是可复用的领域专业知识包，采用渐进披露机制：

| Level | 加载时机 | Token 成本  | 内容                        |
| ----- | -------- | ----------- | --------------------------- |
| 1     | 启动时   | ~100 tokens | 元数据（name, description） |
| 2     | 触发时   | <5k tokens  | SKILL.md 正文               |
| 3     | 按需     | 无限制      | 脚本和资源                  |

## Skill 目录结构

```
skill-name/
├── SKILL.md           # 主入口（YAML frontmatter + Markdown 正文）
├── resource.md        # 可选：额外参考文档
└── scripts/           # 可选：可执行脚本
    ├── main.py
    └── utils.py
```

## SKILL.md 格式

```markdown
---
name: skill-name
description: 技能描述，用于 LLM 判断是否相关
license: MIT
---

# 技能标题

## 工作流

[具体指令...]
```

## 发现路径

默认搜索以下目录：

1. `~/.tachikoma/skills/` - 全局 Skills
2. `${project}/.tachikoma/skills/` - 项目级 Skills

## API

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

## 配置选项

```typescript
interface SkillDiscoveryConfig {
  globalDir?: string; // 全局 Skills 目录
  projectDir?: string; // 项目级目录
  additionalDirs?: string[]; // 额外目录
  enabled?: boolean; // 启用/禁用
  ignoreDirs?: string[]; // 扫描时忽略的目录（默认: node_modules, dist 等）
  maxSkillTokens?: number; // Skills section 最大 token 预算（默认 2000）
}
```

## 注意事项

### YAML 格式限制

内置 YAML 解析器是轻量子集，支持：

- 简单的 `key: value` 格式
- 双引号/单引号字符串
- `|-` 多行字符串

**不支持**：复杂嵌套、YAML 锚点、带特殊字符的键名。

### name 格式建议

推荐使用 kebab-case（如 `pdf-processing`），非规范名称会输出警告。

### 安全

- 脚本执行有目录穿越保护
- System prompt 不暴露绝对路径
- 扫描默认跳过 `node_modules`、`dist` 等大目录

# @tachikoma/skills

Tachikoma 官方 Skills 库 - 可发布的领域专业知识模块。

> ⚠️ **开发中**：此包尚未发布到 npm，目前处于内部开发阶段。

## 这是什么？

这个目录包含**可独立发布**的官方 Skills 集合。与项目级 Skills（`.tachikoma/skills/`）不同，这里的 Skills 设计为：

- 📦 可发布到 npm 供用户安装
- 🔄 跨项目复用
- 📚 作为 Skills 开发的参考示例

## 当前包含的 Skills

| Skill             | 描述                 |
| ----------------- | -------------------- |
| `search-subagent` | 网络搜索子代理工作流 |

## 目录结构

```
skills/
├── package.json           # npm 包定义
├── README.md
├── search-subagent/       # Skill 模块
│   └── SKILL.md           # Skill 入口文件
└── [future-skills]/       # 更多 Skills...
```

## Skill 加载机制

Skills 采用**渐进披露**机制，按需加载以节省 token：

| 层级 | 加载时机 | Token 预算  | 内容                        |
| ---- | -------- | ----------- | --------------------------- |
| L1   | 启动时   | ~100 tokens | 元数据（name, description） |
| L2   | 触发时   | <5k tokens  | SKILL.md 正文               |
| L3   | 按需     | 无限制      | 脚本和资源                  |

## 加载路径

默认情况下，Tachikoma CLI **不会**自动加载此目录。

默认搜索路径：

1. `~/.tachikoma/skills/` - 全局 Skills
2. `${workDir}/.tachikoma/skills/` - 项目级 Skills

### 使用此包中的 Skills

**方法 1：复制到全局目录**

```bash
cp -r skills/search-subagent ~/.tachikoma/skills/
```

**方法 2：配置额外搜索路径（计划中）**

```typescript
// 未来支持
const outcome = loadSkills({
  additionalDirs: ['./skills'],
});
```

## 开发新 Skill

### SKILL.md 格式

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

### 命名规范

- 使用 `kebab-case`（如 `pdf-processing`）
- 长度不超过 50 字符
- 描述不超过 200 字符

## 发布状态

```json
{
  "name": "@tachikoma/skills",
  "private": true // 尚未发布
}
```

将 `private` 改为 `false` 后可发布到 npm。

## 许可证

MIT

# 总结

这个 skills/ 目录是为将来发布官方 Skills 库准备的脚手架，但目前：

1.还没发布到 npm

2.CLI 也没有自动从 node_modules 加载 Skills 的逻辑

如果你想实现这个功能，需要：

1. 在 loader.ts 添加 node_modules/@tachikoma/skills 搜索路径

2. 将 package.json 的 private 改为 false 并发布

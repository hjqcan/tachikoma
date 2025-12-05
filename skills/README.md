# @tachikoma/skills

Tachikoma Skills 库 - 包含指令、脚本和资源的领域专业知识模块。

## 目录结构

```
skills/
├── code-review/
│   ├── SKILL.md           # 指令文件
│   ├── security-checklist.ts
│   └── examples/
├── data-analysis/
│   ├── SKILL.md
│   └── pandas-patterns.py
└── brand-guidelines/
    ├── SKILL.md
    ├── color-palette.json
    └── templates/
```

## Skill 加载策略

Skills 采用渐进披露机制：

| 层级     | 内容                                 | Token 预算  |
| -------- | ------------------------------------ | ----------- |
| Layer 1  | 元数据 (name, description, triggers) | ~100 tokens |
| Layer 2  | 指令 (SKILL.md)                      | <5k tokens  |
| Layer 3+ | 资源 (scripts, examples, assets)     | 按需加载    |

## 许可证

MIT

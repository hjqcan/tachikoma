# @tachikoma/cli

Tachikoma 命令行工具。

## 安装

```bash
bun add -g @tachikoma/cli
```

## 使用

```bash
# 显示帮助
tachikoma help

# 初始化项目
tachikoma init my-project

# 运行任务
tachikoma run "实现用户认证功能"

# 查看状态
tachikoma status
```

## 命令

| 命令     | 描述           |
| -------- | -------------- |
| `init`   | 初始化新项目   |
| `run`    | 运行智能体任务 |
| `status` | 查看任务状态   |
| `help`   | 显示帮助信息   |

## 开发

```bash
# 运行测试
bun test

# 本地运行
bun src/cli.ts help
```

## 许可证

MIT

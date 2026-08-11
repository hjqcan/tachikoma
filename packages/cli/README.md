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

# 默认使用 pi-mono ChatEngine 运行任务
tachikoma run "实现用户认证功能"

# 显式使用旧多智能体编排器
tachikoma orchestrate "规划并实现用户认证功能"
```

## 命令

| 命令          | 描述                                     |
| ------------- | ---------------------------------------- |
| `run`         | 使用 ChatEngine + pi 编码工具运行任务    |
| `orchestrate` | 使用旧 ConversationalRunner 多智能体编排 |
| `eval`        | 运行评估集                               |
| `help`        | 显示帮助信息                             |

`run --workdir` 指定的是 pi 工具的 cwd 和相对路径基准，目前不是沙盒边界。

## 开发

```bash
# 运行测试
bun test

# 本地运行
bun src/cli.ts help
```

## 许可证

MIT

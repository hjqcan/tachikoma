# @tachikoma/sandbox

Tachikoma 沙盒环境配置 - 安全隔离的代码执行环境。

## 功能

- 🔒 Docker/Firecracker 隔离执行
- 🖥️ Bun 运行时支持
- 📦 预装工具 (grep, glob, jq, yq, mcp-cli)
- 🌐 受限网络访问 (allowlist)
- ⏱️ 资源限制 (CPU, 内存, 存储, 超时)

## 配置示例

```yaml
sandbox:
  runtime: 'bun'
  os: 'linux-alpine'
  resources:
    cpu: '2 cores'
    memory: '4GB'
    storage: '10GB'
    timeout: '30min'
  network:
    mode: 'restricted'
    allowlist:
      - 'api.anthropic.com'
      - 'api.openai.com'
  filesystem:
    workdir: '/workspace'
    mounts:
      - source: './project'
        target: '/workspace/project'
        mode: 'rw'
```

## 许可证

MIT

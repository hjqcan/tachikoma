# Tachikoma Sandbox Dockerfile
# 安全隔离的代码执行环境

FROM oven/bun:1.3-alpine

# 安装基础工具
RUN apk add --no-cache \
    git \
    curl \
    jq \
    yq \
    grep \
    findutils \
    && rm -rf /var/cache/apk/*

# 创建非 root 用户
RUN addgroup -g 1000 sandbox && \
    adduser -u 1000 -G sandbox -s /bin/sh -D sandbox

# 设置工作目录
WORKDIR /workspace

# 切换到非 root 用户
USER sandbox

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun --version || exit 1

# 默认命令
CMD ["bun", "run", "--help"]

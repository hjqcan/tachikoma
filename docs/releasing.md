# Releasing

`@tachikoma/protocol`、`@tachikoma/core`、`@tachikoma/server` 三包发布到 npm（公开，MIT）。
`@tachikoma/cli` 暂不发布；`@tachikoma/desktop` 是 private 壳，永不发布。

## 版本策略

三包**锁步**：同一个版本号（`0.2.x`），一起发。版本号的单一来源是各包 `package.json`（pack验证脚本从
`packages/core/package.json` 读取并断言一致性）。`workspace:*` 依赖在 `bun pm pack`
时自动重写为精确版本。

协议兼容规则不随版本号弯曲：事件与 RPC 契约只增不改（见
[`tachikoma-protocol-design.md`](tachikoma-protocol-design.md) §7），破坏性变更要求
`PROTOCOL_VERSION` +1，整个 `0.x` 预期不发生。

## 首次发布（一次性）

1. `npm login`（发布者账号）。
2. `@tachikoma` scope 未注册：首个 `npm publish`
   会随包自动创建（组织名被占时需先在 npmjs.com 建 org）。三包 `publishConfig.access: public`
   已就位（scoped 首发必需）。

## 每次发布

```bash
# 1. 版本对齐（手动编辑三包 package.json + cli/desktop 的依赖区间，保持锁步）
# 2. 全量验证（含打包验证：tarball 内容、workspace 重写、scratch 消费者安装）
bun run verify

# 3. 按依赖顺序发布
cd packages/protocol && npm publish
cd ../core          && npm publish
cd ../server        && npm publish

# 4. 打 tag
git tag v0.2.x && git push origin v0.2.x
```

## sidecar 二进制

```bash
bun run build:bin   # → packages/server/dist/tachikoma-engined（内嵌 bun 运行时）
```

npm 包里的 `tachikoma-engined` bin 需要消费机有 Bun；分发独立二进制用上面的 compile 产物（桌面壳经
`TACHIKOMA_ENGINED_BIN` 显式选用）。签名/公证与自动更新属于桌面打包轨道（desktop-plan
D-C），不在本手册范围。

## 尚未自动化（有意为之）

CI publish job、changelog 生成、`--selftest` 编译冒烟。发布频率撑不起自动化之前，手动流程 +
`bun run verify` 是全部门槛。

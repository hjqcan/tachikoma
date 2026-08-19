#!/usr/bin/env bash

set -euo pipefail

export ANTHROPIC_API_KEY='poison-offline-credential'
export GOOGLE_API_KEY='poison-offline-credential'
export OPENAI_API_KEY='poison-offline-credential'
export OPENROUTER_API_KEY='poison-offline-credential'
export TACHIKOMA_RUN_LIVE_TESTS='0'

TACHIKOMA_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TACHIKOMA_PACK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tachikoma-pack.XXXXXX")"
trap 'rm -rf -- "$TACHIKOMA_PACK_ROOT"' EXIT

# 版本单一来源：core 的 package.json（三包锁步，见 docs/releasing.md）
TACHIKOMA_VERSION="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$TACHIKOMA_REPO_ROOT/packages/core/package.json")"

TACHIKOMA_PACK_DIR="$TACHIKOMA_PACK_ROOT/packages"
TACHIKOMA_UNPACK_DIR="$TACHIKOMA_PACK_ROOT/unpacked-cli"
TACHIKOMA_CONSUMER_DIR="$TACHIKOMA_PACK_ROOT/consumer"
mkdir -p "$TACHIKOMA_PACK_DIR" "$TACHIKOMA_UNPACK_DIR" "$TACHIKOMA_CONSUMER_DIR"

test -f "$TACHIKOMA_REPO_ROOT/packages/protocol/dist/index.js"
test -f "$TACHIKOMA_REPO_ROOT/packages/core/dist/index.js"
test -f "$TACHIKOMA_REPO_ROOT/packages/server/dist/engined.js"
test -f "$TACHIKOMA_REPO_ROOT/packages/server/dist/acp.js"
test -f "$TACHIKOMA_REPO_ROOT/packages/cli/dist/cli.js"

for TACHIKOMA_PKG in protocol core server cli; do
  (
    cd "$TACHIKOMA_REPO_ROOT/packages/$TACHIKOMA_PKG"
    bun pm pack \
      --ignore-scripts \
      --destination "$TACHIKOMA_PACK_DIR"
  )
done

TACHIKOMA_PROTOCOL_TGZ="$TACHIKOMA_PACK_DIR/hjqcan-tachikoma-protocol-$TACHIKOMA_VERSION.tgz"
TACHIKOMA_CORE_TGZ="$TACHIKOMA_PACK_DIR/hjqcan-tachikoma-core-$TACHIKOMA_VERSION.tgz"
TACHIKOMA_SERVER_TGZ="$TACHIKOMA_PACK_DIR/hjqcan-tachikoma-server-$TACHIKOMA_VERSION.tgz"
TACHIKOMA_CLI_TGZ="$TACHIKOMA_PACK_DIR/hjqcan-tachikoma-cli-$TACHIKOMA_VERSION.tgz"

tar -xOzf "$TACHIKOMA_CORE_TGZ" package/package.json | bun -e '
  const manifest = await Bun.stdin.json();
  const expected = {
    "@earendil-works/pi-agent-core": "0.84.2",
    "@earendil-works/pi-ai": "0.84.2",
    "@earendil-works/pi-coding-agent": "0.84.2",
    goodmemory: "0.7.4",
  };
  for (const [name, version] of Object.entries(expected)) {
    if (manifest.dependencies?.[name] !== version) {
      throw new Error(`${name}: expected ${version}, got ${manifest.dependencies?.[name]}`);
    }
  }
'

tar -xOzf "$TACHIKOMA_CLI_TGZ" package/package.json | bun -e '
  const manifest = await Bun.stdin.json();
  const version = process.argv[1];
  if (manifest.dependencies?.["@hjqcan/tachikoma-core"] !== version) {
    throw new Error(`packed CLI has @hjqcan/tachikoma-core ${manifest.dependencies?.["@hjqcan/tachikoma-core"]}`);
  }
  if (manifest.bin?.tachikoma !== "./dist/cli.js") {
    throw new Error(`unexpected bin target: ${manifest.bin?.tachikoma}`);
  }
' "$TACHIKOMA_VERSION"

# server：workspace:* 必须重写为精确版本；bin 指向 dist/engined.js
tar -xOzf "$TACHIKOMA_SERVER_TGZ" package/package.json | bun -e '
  const manifest = await Bun.stdin.json();
  const version = process.argv[1];
  for (const name of ["@hjqcan/tachikoma-core", "@hjqcan/tachikoma-protocol"]) {
    if (manifest.dependencies?.[name] !== version) {
      throw new Error(`packed server has ${name} ${manifest.dependencies?.[name]}`);
    }
  }
  if (manifest.bin?.["tachikoma-engined"] !== "./dist/engined.js") {
    throw new Error(`unexpected bin target: ${JSON.stringify(manifest.bin)}`);
  }
  if (manifest.bin?.["tachikoma-acp"] !== "./dist/acp.js") {
    throw new Error(`unexpected acp bin target: ${JSON.stringify(manifest.bin)}`);
  }
' "$TACHIKOMA_VERSION"

# protocol：发布物必须运行时中立（仅 zod 依赖）
tar -xOzf "$TACHIKOMA_PROTOCOL_TGZ" package/package.json | bun -e '
  const manifest = await Bun.stdin.json();
  const names = Object.keys(manifest.dependencies ?? {});
  if (names.length !== 1 || names[0] !== "zod") {
    throw new Error(`protocol dependencies must be exactly [zod], got: ${names.join(", ")}`);
  }
'

for TACHIKOMA_TGZ in "$TACHIKOMA_PROTOCOL_TGZ" "$TACHIKOMA_CORE_TGZ" "$TACHIKOMA_SERVER_TGZ" "$TACHIKOMA_CLI_TGZ"; do
  tar -tzf "$TACHIKOMA_TGZ" | bun -e '
    const paths = (await Bun.stdin.text()).trim().split("\n");
    const forbidden = paths.filter((path) =>
      /(^|\/)(src|tests?|\.env)(\/|$)/u.test(path),
    );
    if (forbidden.length > 0) {
      throw new Error(`source-only files entered the package: ${forbidden.join(", ")}`);
    }
  '
done

tar -xzf "$TACHIKOMA_CLI_TGZ" -C "$TACHIKOMA_UNPACK_DIR"
test -x "$TACHIKOMA_UNPACK_DIR/package/dist/cli.js"
test "$(head -n 1 "$TACHIKOMA_UNPACK_DIR/package/dist/cli.js")" = '#!/usr/bin/env bun'

(
  cd "$TACHIKOMA_CONSUMER_DIR"
  bun init -y
  # bun 不会用同名 file: 直接依赖满足包间的精确版本区间，
  # 用 overrides 把这些名字固定到本地 tarball，避免打到 npm registry。
  bun -e '
    const manifest = await Bun.file("package.json").json();
    manifest.overrides = {
      "@hjqcan/tachikoma-core": `file:${process.argv[1]}`,
      "@hjqcan/tachikoma-protocol": `file:${process.argv[2]}`,
    };
    await Bun.write("package.json", JSON.stringify(manifest, null, 2));
  ' "$TACHIKOMA_CORE_TGZ" "$TACHIKOMA_PROTOCOL_TGZ"
  bun add --exact "$TACHIKOMA_PROTOCOL_TGZ" "$TACHIKOMA_CORE_TGZ" "$TACHIKOMA_SERVER_TGZ" "$TACHIKOMA_CLI_TGZ"
  bun -e '
    const version = process.argv[1];
    const core = await import("@hjqcan/tachikoma-core");
    const cli = await import("@hjqcan/tachikoma-cli");
    const protocol = await import("@hjqcan/tachikoma-protocol");
    if (core.VERSION !== version || cli.VERSION !== version) {
      throw new Error("unexpected installed package versions");
    }
    if (typeof protocol.PROTOCOL_VERSION !== "number" || !protocol.CAPABILITIES.includes("skills")) {
      throw new Error("protocol package did not expose the expected surface");
    }
  ' "$TACHIKOMA_VERSION"
  # Node ESM 冒烟：protocol 承诺 renderer/browser 可依赖，core 是库入口——两者必须在
  # Node 下可 import。bun 的宽松解析曾遮蔽发布物里的无扩展名裸说明符，此通道防回归。
  node --input-type=module -e '
    const protocol = await import("@hjqcan/tachikoma-protocol");
    const core = await import("@hjqcan/tachikoma-core");
    if (typeof protocol.PROTOCOL_VERSION !== "number" || typeof core.VERSION !== "string") {
      throw new Error("Node ESM import surface mismatch");
    }
  '
  test -x ./node_modules/.bin/tachikoma-engined
  test "$(head -n 1 ./node_modules/.bin/tachikoma-engined)" = '#!/usr/bin/env bun'
  test -x ./node_modules/.bin/tachikoma-acp
  test "$(head -n 1 ./node_modules/.bin/tachikoma-acp)" = '#!/usr/bin/env bun'
  ./node_modules/.bin/tachikoma --version
  ./node_modules/.bin/tachikoma --help
  bun audit
)

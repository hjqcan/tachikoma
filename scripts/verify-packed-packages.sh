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

TACHIKOMA_PACK_DIR="$TACHIKOMA_PACK_ROOT/packages"
TACHIKOMA_UNPACK_DIR="$TACHIKOMA_PACK_ROOT/unpacked-cli"
TACHIKOMA_CONSUMER_DIR="$TACHIKOMA_PACK_ROOT/consumer"
mkdir -p "$TACHIKOMA_PACK_DIR" "$TACHIKOMA_UNPACK_DIR" "$TACHIKOMA_CONSUMER_DIR"

test -f "$TACHIKOMA_REPO_ROOT/packages/core/dist/index.js"
test -f "$TACHIKOMA_REPO_ROOT/packages/cli/dist/cli.js"

(
  cd "$TACHIKOMA_REPO_ROOT/packages/core"
  bun pm pack \
    --ignore-scripts \
    --destination "$TACHIKOMA_PACK_DIR"
)
(
  cd "$TACHIKOMA_REPO_ROOT/packages/cli"
  bun pm pack \
    --ignore-scripts \
    --destination "$TACHIKOMA_PACK_DIR"
)

TACHIKOMA_CORE_TGZ="$TACHIKOMA_PACK_DIR/tachikoma-core-0.2.0.tgz"
TACHIKOMA_CLI_TGZ="$TACHIKOMA_PACK_DIR/tachikoma-cli-0.2.0.tgz"

tar -xOzf "$TACHIKOMA_CORE_TGZ" package/package.json | bun -e '
  const manifest = await Bun.stdin.json();
  const expected = {
    "@earendil-works/pi-agent-core": "0.84.1",
    "@earendil-works/pi-ai": "0.84.1",
    "@earendil-works/pi-coding-agent": "0.84.1",
    goodmemory: "0.7.3",
  };
  for (const [name, version] of Object.entries(expected)) {
    if (manifest.dependencies?.[name] !== version) {
      throw new Error(`${name}: expected ${version}, got ${manifest.dependencies?.[name]}`);
    }
  }
'

tar -xOzf "$TACHIKOMA_CLI_TGZ" package/package.json | bun -e '
  const manifest = await Bun.stdin.json();
  if (manifest.dependencies?.["@tachikoma/core"] !== "0.2.0") {
    throw new Error(`packed CLI has @tachikoma/core ${manifest.dependencies?.["@tachikoma/core"]}`);
  }
  if (manifest.bin?.tachikoma !== "./dist/cli.js") {
    throw new Error(`unexpected bin target: ${manifest.bin?.tachikoma}`);
  }
'

for TACHIKOMA_TGZ in "$TACHIKOMA_CORE_TGZ" "$TACHIKOMA_CLI_TGZ"; do
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
  # bun 不会用同名 file: 直接依赖满足 CLI 包的 @tachikoma/core@0.2.0 传递区间，
  # 用 overrides 把该名字固定到本地 tarball，避免打到 npm registry。
  bun -e '
    const manifest = await Bun.file("package.json").json();
    manifest.overrides = { "@tachikoma/core": `file:${process.argv[1]}` };
    await Bun.write("package.json", JSON.stringify(manifest, null, 2));
  ' "$TACHIKOMA_CORE_TGZ"
  bun add --exact "$TACHIKOMA_CORE_TGZ" "$TACHIKOMA_CLI_TGZ"
  bun -e '
    const core = await import("@tachikoma/core");
    const cli = await import("@tachikoma/cli");
    if (core.VERSION !== "0.2.0" || cli.VERSION !== "0.2.0") {
      throw new Error("unexpected installed package versions");
    }
  '
  ./node_modules/.bin/tachikoma --version
  ./node_modules/.bin/tachikoma --help
  bun audit
)

#!/usr/bin/env bash
# Build this fork into the same self-contained Linux archive the upstream
# release workflow produces, install it under ~/.t3/runtime/versions/<version>,
# and switch the `t3` launcher and the t3code.service user unit to it.
#
# Why this exists: `t3 update` would pull upstream's release over a fork
# build, so the fork ships through this script instead. The chain mirrors
# .github/workflows/release-desktop.yml ("Build CLI single-executable" and
# "Build CLI archive") minus macOS/Windows signing.
#
# Host requirements (all user-local, no sudo):
#   ~/.local/node24  Node 24 (engines.node)          -> pnpm install, tsdown, web build
#   ~/.local/node26  Node 26.8.2 (VP_NODE_VERSION)   -> single-executable build (needs 25.7+)
#   pnpm via corepack (corepack enable --install-directory ~/.local/node24/bin pnpm)
#   A previously installed release that ships resource-monitor/linux-x64/
#   (the Rust helper; this box has no cargo). Default: the newest dir under
#   ~/.t3/runtime/versions that has one.
#
# Usage:
#   scripts/vps-build.sh <version>            e.g. 0.0.45-vip.2 (semver; bumps every package.json)
#   scripts/vps-build.sh <version> --no-install   build the archive only
set -euo pipefail

version="${1:-}"
[[ -n "$version" ]] || { echo "usage: $0 <version> [--no-install]" >&2; exit 2; }
install=1
[[ "${2:-}" == "--no-install" ]] && install=0

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node24="${NODE24_DIR:-$HOME/.local/node24}"
node26="${NODE26_DIR:-$HOME/.local/node26}"
t3_home="${T3CODE_HOME:-$HOME/.t3}"
versions_dir="$t3_home/runtime/versions"
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"

[[ -x "$node24/bin/node" ]] || { echo "missing Node 24 at $node24" >&2; exit 1; }
[[ -x "$node26/bin/node" ]] || { echo "missing Node 26 at $node26" >&2; exit 1; }

resmon="${RESOURCE_MONITOR_DIR:-}"
if [[ -z "$resmon" ]]; then
  for d in $(ls -1d "$versions_dir"/*/ 2>/dev/null | sort -V -r); do
    if [[ -x "$d/resource-monitor/linux-x64/t3-resource-monitor" ]]; then resmon="$d/resource-monitor"; break; fi
  done
fi
[[ -n "$resmon" ]] || { echo "no resource-monitor dir found; pass RESOURCE_MONITOR_DIR" >&2; exit 1; }

cd "$repo"
export PATH="$repo/node_modules/.bin:$node24/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

echo "== deps"
pnpm install --frozen-lockfile >/dev/null
echo "== version $version"
node scripts/update-release-package-versions.ts "$version"
echo "== web + server bundle"
pnpm --filter @t3tools/web build >/dev/null
node apps/server/scripts/cli.ts build
echo "== single executable (Node 26)"
PATH="$node26/bin:$PATH" VP_NODE_VERSION=26.8.2 node apps/server/scripts/cli.ts build-exe
echo "== archive"
rm -rf release-cli
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$resmon" --output-dir release-cli
archive="release-cli/t3-$version-linux-x64.tar.gz"
ls -la "$archive"

if (( install == 0 )); then exit 0; fi

echo "== install $version"
target="$versions_dir/$version"
rm -rf "$target"
mkdir -p "$target"
tar -xzf "$archive" -C "$target" --strip-components=1
"$target/t3" --version
printf '%s\n' "$version" > "$target/.install-complete"
mkdir -p "$bin_dir"
ln -sfn "$target/t3" "$bin_dir/t3"
echo "== service"
# The unit name is fixed per user; the drop-in in t3code.service.d/ (host, port, PATH) is kept.
"$bin_dir/t3" service install --allow-downgrade
sleep 5
systemctl --user is-active t3code.service
grep ExecStart "$HOME/.config/systemd/user/t3code.service"

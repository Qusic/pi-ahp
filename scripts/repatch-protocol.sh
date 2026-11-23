#!/usr/bin/env bash
# Upgrades @microsoft/agent-host-protocol and regenerates its patch.
#
# Usage: nix develop -c scripts/repatch-protocol.sh <version>
#
# The edit itself is one substitution: the package declares its enums `declare
# const enum` but compiles them with `preserveConstEnums`, so the runtime
# objects exist and only the declarations claim otherwise. A `const enum` has to
# be inlined across files, which neither `isolatedModules` nor node's type
# stripper can do — see the note in tsconfig.json.
#
# A postinstall script doing the same substitution would be shorter than the
# patch, but nixpkgs' pnpmConfigHook installs with `--ignore-scripts`, so it
# would never run in `nix build` and the hermetic typecheck would fail.
#
# The old patch goes first: it would not apply to the new version, so the
# upgrade would fail, and `pnpm patch` would start from the patched files.
set -euo pipefail

cd "$(dirname "$0")/.."

version=${1:?usage: nix develop -c scripts/repatch-protocol.sh <version>}
pkg="@microsoft/agent-host-protocol"
patch="patches/@microsoft__agent-host-protocol.patch"

pnpm patch-remove "$pkg"
pnpm up "$pkg@$version"

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
pnpm patch "$pkg" --edit-dir "$dir" >/dev/null

files=$(grep -rl 'declare const enum' "$dir" || true)
if [ -z "$files" ]; then
	echo "$pkg $version has no 'declare const enum' left, so it is now installed unpatched."
	echo "Delete this script."
	exit 0
fi

echo "$files" | xargs sed -i 's/declare const enum /declare enum /g'
pnpm patch-commit "$dir"

# pnpm drops comments when it rewrites pnpm-workspace.yaml, so the note lives
# in the patch. pnpm hashes the whole file, so install again to record it.
{
	echo "Required by isolatedModules; regenerate with scripts/repatch-protocol.sh <version>."
	echo
	cat "$patch"
} >"$patch.new"
mv "$patch.new" "$patch"
pnpm install

# pnpm also rewrites pnpm-workspace.yaml in its own quoting style.
pnpm exec biome format --write pnpm-workspace.yaml

echo
echo "Patched $(wc -l <<<"$files") files. Next: scripts/update-flake.sh, then nix flake check."

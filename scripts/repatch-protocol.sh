#!/usr/bin/env bash
# Regenerates patches/@microsoft__agent-host-protocol.patch.
#
# Run after bumping @microsoft/agent-host-protocol; the existing patch will not
# apply to new .d.ts files and `pnpm install` will say so.
#
# The edit itself is one substitution: the package declares its enums `declare
# const enum` but compiles them with `preserveConstEnums`, so the runtime
# objects exist and only the declarations claim otherwise. A `const enum` has to
# be inlined across files, which neither `isolatedModules` nor node's type
# stripper can do — see the note in tsconfig.json.
#
# A postinstall script doing the same substitution would be shorter than the
# patch, but nixpkgs' pnpmConfigHook installs with `--ignore-scripts`, so it
# would never run in `nix build` and the hermetic typecheck would fail with the
# 86 TS2748 errors this prevents.
set -euo pipefail

cd "$(dirname "$0")/.."

pkg="@microsoft/agent-host-protocol"
dir=$(mktemp -d)
# The path is chosen here rather than parsed out of pnpm's multi-line hint.
pnpm patch "$pkg" --edit-dir "$dir" >/dev/null

files=$(grep -rl 'declare const enum' "$dir" || true)
if [ -z "$files" ]; then
	echo "No 'declare const enum' left in $pkg — upstream may have fixed it."
	echo "If so, delete patches/, the patchedDependencies entry, and this script."
	exit 1
fi

echo "$files" | xargs sed -i 's/declare const enum /declare enum /g'
pnpm patch-commit "$dir"

# `pnpm patch-commit` rewrites pnpm-workspace.yaml and drops keys it did not
# put there, `minimumReleaseAgeExclude` among them. Restoring from git is the
# only reliable way back; a lost exclude block fails the next install with a
# supply-chain policy error that looks nothing like its cause.
if git -C . diff --quiet -- pnpm-workspace.yaml 2>/dev/null; then
	:
else
	echo
	echo "NOTE: pnpm-workspace.yaml changed. Check that only patchedDependencies moved:"
	git -C . diff -- pnpm-workspace.yaml || true
fi

echo
echo "Patched $(echo "$files" | wc -l) files. Verify with: pnpm run check"

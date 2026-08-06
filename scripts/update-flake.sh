#!/usr/bin/env bash
# Refreshes everything in flake.nix that tracks something outside it.
#
# Run after `pnpm install` changes pnpm-lock.yaml, or to pick up a newer
# nixpkgs. The three steps are ordered: newer inputs can change the pnpm major,
# which changes the dependency hash, and nix-update rewrites the file without
# regard for formatting.
#
# Nix reads flake.nix from git, not from disk, so an unstaged edit is invisible
# to every step here.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! git diff --quiet -- flake.nix || ! git diff --cached --quiet -- flake.nix; then
	echo "note: flake.nix has unstaged edits; nix reads the staged tree." >&2
fi

echo "==> nix flake update"
nix flake update

echo "==> nix-update (dependency hashes)"
git add flake.nix flake.lock
for attr in $(nix eval --impure --raw --expr '
	with builtins; concatStringsSep "\n" (
		filter (n: n != "default") (attrNames (getFlake (toString ./.)).packages.${currentSystem})
	)
'); do
	echo "    ${attr}"
	nix run nixpkgs#nix-update -- --flake --version=skip "$attr"
done

echo "==> nixfmt"
nix run nixpkgs#nixfmt -- flake.nix

git add flake.nix flake.lock
echo
echo "Done. Verify with: nix flake check"

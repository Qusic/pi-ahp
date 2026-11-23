#!/usr/bin/env bash
# Refreshes everything in flake.nix that tracks something outside it.
#
# Run after `pnpm install` changes pnpm-lock.yaml, or to pick up a newer
# nixpkgs. Update inputs before recomputing fixed-output dependency hashes, then
# format the file after nix-update rewrites it.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> nix flake update"
nix flake update

echo "==> nix-update (dependency hashes)"
for attr in $(nix eval --impure --raw --expr '
	with builtins; concatStringsSep "\n" (
		filter (n: n != "default") (attrNames (getFlake (toString ./.)).packages.${currentSystem})
	)
'); do
	echo "    ${attr}"
	# Work around https://github.com/Mic92/nix-update/issues/687 until nixpkgs has the fix.
	nix flake prefetch
	nix run nixpkgs#nix-update -- --flake --version=skip "$attr"
done

echo "==> nixfmt"
nix run nixpkgs#nixfmt -- flake.nix

echo
echo "Done. Verify with: nix flake check"

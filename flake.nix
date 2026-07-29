{
  description = "pi-ahp";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      forEachSystem =
        let
          systems = [
            "x86_64-linux"
            "aarch64-linux"
            "aarch64-darwin"
            "x86_64-darwin"
          ];
        in
        f:
        nixpkgs.lib.genAttrs systems (
          system: f (nixpkgs.legacyPackages.${system}.extend self.overlays.default)
        );
    in
    {
      overlays.default =
        final: prev:
        let
          pkgJson = builtins.fromJSON (builtins.readFile ./package.json);
          nodejs = final.nodejs_24;
          pnpm = final.pnpm_11;
        in
        {
          ahp-spec = final.fetchFromGitHub {
            owner = "microsoft";
            repo = "agent-host-protocol";
            rev = "spec/v${pkgJson.dependencies."@microsoft/agent-host-protocol"}";
            hash = "sha256-zpUrASnrqHpDTdXt9fhBBaUTti91c7T1x5psV2JRWIU=";
          };

          pi-ahp = final.stdenv.mkDerivation (finalAttrs: {
            pname = pkgJson.name;
            version = pkgJson.version;
            src = ./.;

            meta = {
              mainProgram = pkgJson.name;
              description = pkgJson.description;
              license = final.lib.licenses.mit;
              platforms = final.lib.platforms.unix;
            };

            pnpmDeps = final.fetchPnpmDeps {
              pname = pkgJson.name;
              version = pkgJson.version;
              inherit (finalAttrs) src;
              inherit pnpm;
              fetcherVersion = 4;
              hash = "sha256-NKGtrfoWCSaTa/ON2Z+zAZcMlYmHDPy2yXrqkhfQdW4=";
            };

            __structuredAttrs = true;
            strictDeps = true;

            nativeBuildInputs = [
              nodejs
              pnpm
            ]
            ++ (with final; [
              pnpmConfigHook
              makeWrapper
              jq
            ]);

            installPhase = ''
              runHook preInstall
              bin=$out/bin
              lib=$out/lib/${finalAttrs.pname}
              mkdir -p "$bin" "$lib"
              pnpm prune --prod --ignore-scripts
              cp -r src node_modules package.json "$lib/"
              jq -r '.bin | to_entries[] | "\(.key) \(.value)"' package.json | \
                while read -r name entry; do
                  makeWrapper ${nodejs}/bin/node "$bin/$name" --add-flag "$lib/''${entry#./}"
                done
              runHook postInstall
            '';
          });
        };

      packages = forEachSystem (pkgs: {
        default = pkgs.pi-ahp;
      });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          inputsFrom = [ pkgs.pi-ahp ];
          AHP_SPEC_PATH = pkgs.ahp-spec;
        };
      });

      checks = forEachSystem (
        pkgs:
        nixpkgs.lib.genAttrs [ "test" "check" "lint" ] (
          script:
          pkgs.pi-ahp.overrideAttrs (prev: {
            pname = "${prev.pname}-${script}";
            env.AHP_SPEC_PATH = "${pkgs.ahp-spec}";
            buildPhase = "pnpm run ${script}";
            installPhase = "touch $out";
          })
        )
      );
    };
}

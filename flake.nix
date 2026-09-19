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
          ahp-spec = final.fetchFromGitHub rec {
            pname = "ahp-spec";
            version = pkgJson.dependencies."@microsoft/agent-host-protocol";
            owner = "microsoft";
            repo = "agent-host-protocol";
            rev = "spec/v${version}";
            hash = "sha256-PzI0oEOIADtQPANmZQ8Z4O2r7znXYhoPjSAFUOpE+JM=";
            passthru.src = final.ahp-spec;
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
              hash = "sha256-rSuw7HGb/2HX3rLJ3ISjIDRbzcg3FMH/lWydtVk60Mc=";
            };

            __structuredAttrs = true;
            strictDeps = true;

            buildInputs =
              with final;
              lib.optionals stdenv.hostPlatform.isLinux [
                stdenv.cc.cc.lib
              ];

            nativeBuildInputs = [
              nodejs
              pnpm
            ]
            ++ (
              with final;
              [
                pnpmConfigHook
                makeWrapper
                jq
                python3
                git
                fd
                ripgrep
              ]
              ++ lib.optionals stdenv.hostPlatform.isLinux [
                autoPatchelfHook
              ]
            );

            preBuild = final.lib.optionalString final.stdenv.hostPlatform.isLinux ''
              autoPatchelf node_modules
            '';

            buildPhase = ''
              runHook preBuild
              pnpm run build
              runHook postBuild
            '';

            checkPhase = ''
              runHook preCheck
              pnpm run check
              pnpm run lint
              pnpm run test
              runHook postCheck
            '';

            installPhase = ''
              runHook preInstall
              package=${finalAttrs.pname}
              mkdir -p $out/{bin,lib}
              pnpm deploy --filter=. --config.inject-workspace-packages=true \
                --frozen-lockfile --ignore-scripts --offline --prod deploy
              mv deploy $out/lib/$package
              jq -r '.bin | to_entries[] | "\(.key) \(.value)"' package.json | \
                while read -r name entry; do
                  makeWrapper ${nodejs}/bin/node $out/bin/$name --add-flag $out/lib/$package/$entry
                done
              runHook postInstall
            '';
          });
        };

      packages = forEachSystem (pkgs: {
        default = pkgs.pi-ahp;
        inherit (pkgs) pi-ahp ahp-spec;
      });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          inputsFrom = [ pkgs.pi-ahp ];
          AHP_SPEC_PATH = pkgs.ahp-spec;
        };
      });

      checks = forEachSystem (pkgs: {
        default = pkgs.pi-ahp.overrideAttrs (prev: {
          pname = "${prev.pname}-check";
          env.AHP_SPEC_PATH = "${pkgs.ahp-spec}";
          doCheck = true;
          installPhase = "touch $out";
        });
      });
    };
}

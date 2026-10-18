{
  description = "Workbench go reference environment";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = function: nixpkgs.lib.genAttrs systems (system: function nixpkgs.legacyPackages.${system});
    in rec {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          inputsFrom = [ packages.${pkgs.stdenv.hostPlatform.system}.default ];
          nativeBuildInputs = [ (import ./check-inputs.nix { inherit pkgs; }) ];
          packages = with pkgs; [ git nodejs_24 openssh rsync which less vim ];
        };
      });
      packages = forAllSystems (pkgs:
        let
          count = pkgs.stdenvNoCC.mkDerivation {
            pname = "workbench-count";
            version = "0.1.0";
            src = builtins.path {
              path = ./.;
              name = "go-reference-source";
              filter = path: type: !(builtins.elem (baseNameOf path) [ "build" "dist" "coverage" ".git" ]);
            };
            nativeBuildInputs = [ pkgs.go_latest ];
            dontConfigure = true;
            buildPhase = ''
              export HOME="$TMPDIR" CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
              if [ "$NIX_BUILD_CORES" -gt 0 ]; then
                export GOMAXPROCS="$NIX_BUILD_CORES" GOFLAGS="-mod=readonly -p=$NIX_BUILD_CORES"
              fi
              go build -trimpath -ldflags="-s -w" -o count ./cmd/count
            '';
            meta.license = pkgs.lib.licenses.asl20;
            doCheck = true;
            checkPhase = ''
              go test ./...
              test "$(./count a banana)" = 3
            '';
            installPhase = ''
              install -Dm755 count "$out/bin/count"
              install -Dm644 LICENSE "$out/share/licenses/$pname/LICENSE"
            '';
          };
        in {
          default = count;
          apptainer = pkgs.apptainer;
          bootstrap = pkgs.buildEnv {
            name = "workbench-nix-bootstrap";
            paths = with pkgs; [ bashInteractive coreutils git nodejs_24 cacert shadow ];
            pathsToLink = [ "/bin" "/etc" ];
          };
          portable = pkgs.runCommand "workbench-count.tar.gz" { nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ]; } ''
            mkdir bin
            cp ${count}/bin/count bin/count
            cp ${count}/share/licenses/workbench-count/LICENSE LICENSE
            tar --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner -czf "$out" bin LICENSE
          '';
          docker = pkgs.dockerTools.buildLayeredImage {
            name = "workbench-count-nix";
            tag = "local";
            contents = [ count ];
            config = { Entrypoint = [ "${count}/bin/count" ]; Cmd = [ "a" "banana" ]; };
          };
        });
    };
}

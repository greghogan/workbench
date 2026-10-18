{
  description = "Workbench development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = function:
        nixpkgs.lib.genAttrs systems (system: function nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        bootstrap = pkgs.buildEnv {
          name = "workbench-nix-bootstrap";
          paths = with pkgs; [ bashInteractive coreutils findutils git nodejs_latest cacert shadow gnutar gzip xz zstd unzip util-linux ];
          pathsToLink = [ "/bin" "/etc" ];
        };
      });
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = [ (import ./check-inputs.nix { inherit pkgs; }) ];
          packages = with pkgs; [ git gnupg python3 nodejs_latest actionlint shellcheck shfmt gdb openssh rsync which less vim ];
          # Native binaries in the language lockfile use the selected runtime libraries.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
        };
      });
    };
}

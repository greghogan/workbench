{
  description = "Workbench Rust reference development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = function:
        nixpkgs.lib.genAttrs systems (system: function nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            git
            nodejs_24
            cargo
            cargo-nextest
            cargo-llvm-cov
            llvmPackages.llvm
            clippy
            docker-client
            rustc
            rustfmt
          ];
        };
      });
    };
}

{
  description = "Workbench rust packages and development environment";
  # Retain Rust 1.98.1 until Nixpkgs aligns Rust 1.99's LLVM backend and profiling runtime.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/e63c96e6b5c1cd2b726895cef537fd7363fc5de6";
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = function: nixpkgs.lib.genAttrs systems (system: function nixpkgs.legacyPackages.${system});
      packages = forAllSystems (pkgs: { default = import ./package.nix { inherit pkgs; }; });
    in {
      inherit packages;
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          inputsFrom = [ packages.${pkgs.stdenv.hostPlatform.system}.default ];
          nativeBuildInputs = [ (import ./check-inputs.nix { inherit pkgs; }) ];
          # Coverage readers must match the LLVM used by the selected Rust compiler.
          packages = with pkgs; [ git nodejs_24 cargo-nextest (cargo-llvm-cov.override { llvmPackages_22 = rustc.llvmPackages; }) rustc.llvmPackages.llvm clippy docker-client rustfmt openssh rsync which less vim ];
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
        };
      });
    };
}

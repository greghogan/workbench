{
  description = "Workbench cpp reference packages and development environment";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = function: nixpkgs.lib.genAttrs systems (system: function nixpkgs.legacyPackages.${system});
      packages = forAllSystems (pkgs: { default = import ./package.nix { inherit pkgs; }; });
    in {
      inherit packages;
      devShells = forAllSystems (pkgs:
        let
          stdenv = pkgs.overrideCC pkgs.stdenv pkgs.gcc_latest;
          llvm = pkgs.llvmPackages_latest;
          clang = llvm.clang.override { gccForLibs = pkgs.gcc_latest.cc; };
          clangTools = llvm.clang-tools.override { inherit clang stdenv; };
        in {
          default = (pkgs.mkShell.override { inherit stdenv; }) {
            inputsFrom = [ packages.${pkgs.stdenv.hostPlatform.system}.default ];
            nativeBuildInputs = [ (import ./check-inputs.nix { inherit pkgs; }) ];
            # Wrapped clang-tidy uses the same GCC headers as the selected compiler.
            packages = [ clangTools clang llvm.llvm llvm.lld llvm.lldb pkgs.gdb ]
              ++ (with pkgs; [ git openssh rsync which less vim curl zip unzip pkg-config nodejs_24 ]);
            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.curl ];
          };
        });
    };
}

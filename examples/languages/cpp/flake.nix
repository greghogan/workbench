{
  description = "Workbench cpp reference environment";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = function: nixpkgs.lib.genAttrs systems (system: function nixpkgs.legacyPackages.${system});
    in { devShells = forAllSystems (pkgs: {
      # Put wrapped clang-tidy before the unwrapped binaries supplied by clang.
      default = pkgs.mkShell {
        packages = with pkgs; [ git curl zip unzip pkg-config nodejs_24 clang-tools clang llvm lld cmake ninja ];
        # The pinned vcpkg executable loads libcurl dynamically.
        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.curl ];
      };
    }); };
}

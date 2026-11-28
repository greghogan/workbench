{
  description = "Workbench React packages and development environment";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = function: nixpkgs.lib.genAttrs systems (system: function nixpkgs.legacyPackages.${system});
      packages = forAllSystems (pkgs: { default = import ./package.nix { inherit pkgs; }; });
    in {
      inherit packages;
      devShells = forAllSystems (pkgs: let
        shell = withDependencies: pkgs.mkShell {
          inputsFrom = pkgs.lib.optionals withDependencies [ packages.${pkgs.stdenv.hostPlatform.system}.default ];
          nativeBuildInputs = pkgs.lib.optionals withDependencies [ (import ./check-inputs.nix { inherit pkgs; }) ];
          packages = with pkgs; [ nodejs_latest git openssh rsync which less vim ];
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
        };
      in {
        default = shell true;
        toolchain = shell false;
      });
    };
}

{
  description = "Workbench ruby packages and development environment";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
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
          packages = with pkgs; [ git nodejs_24 pkg-config libyaml openssl gnumake gcc gdb openssh rsync which less vim ];
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
        };
      });
    };
}

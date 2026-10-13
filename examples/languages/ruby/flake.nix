{
  description = "Workbench Ruby reference development environment";

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
          packages = with pkgs; [ git nodejs_24 ruby_4_0 pkg-config libyaml openssl gnumake gcc ];
          # The selected development tools own their runtime libraries.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
        };
      });
    };
}

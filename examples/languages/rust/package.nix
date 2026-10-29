{ pkgs }:
pkgs.rustPlatform.buildRustPackage {
  pname = "workbench-rust-reference";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type: !(builtins.elem (baseNameOf path)
      [ ".git" "node_modules" "build" "dist" "coverage" ".venv" "__pycache__" "target" ]);
  };
  nativeBuildInputs = [];
  propagatedBuildInputs = [];
  cargoLock.lockFile = ./Cargo.lock;
  postInstall = ''install -Dm644 LICENSE "$out/share/licenses/$pname/LICENSE"'';
  doCheck = true;
  meta.license = pkgs.lib.licenses.asl20;
}

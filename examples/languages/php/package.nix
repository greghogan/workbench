{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "workbench-php-reference";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type: !(builtins.elem (baseNameOf path)
      [ ".git" "node_modules" "build" "dist" "coverage" ".venv" "__pycache__" "target" ]);
  };
  nativeBuildInputs = [ pkgs.php85 pkgs.makeWrapper ];
  propagatedBuildInputs = [];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    true
    runHook postBuild
  '';
  checkPhase = ''
    runHook preCheck
    php -r "require 'src/Arithmetic.php'; if (WorkbenchReference\\Arithmetic::sum([20,22]) !== 42 || WorkbenchReference\\Arithmetic::countByte('banana',97) !== 3) exit(1);"
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/php $out/bin
    cp -r src bin $out/share/php/
    makeWrapper ${pkgs.php85}/bin/php $out/bin/count --add-flags "$out/share/php/bin/count"
    install -Dm644 LICENSE "$out/share/licenses/$pname/LICENSE"
    runHook postInstall
  '';
  doCheck = true;
  meta.license = pkgs.lib.licenses.asl20;
}

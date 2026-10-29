{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "workbench-python-reference";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type: !(builtins.elem (baseNameOf path)
      [ ".git" "node_modules" "build" "dist" "coverage" ".venv" "__pycache__" "target" ]);
  };
  nativeBuildInputs = [ pkgs.python315 ];
  propagatedBuildInputs = [ pkgs.python315 ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    true
    runHook postBuild
  '';
  checkPhase = ''
    runHook preCheck
    PYTHONPATH=src python3 -m unittest discover -s tests -v
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/${pkgs.python315.sitePackages}
    cp -r src/workbench_python_reference $out/${pkgs.python315.sitePackages}/
    install -Dm644 LICENSE "$out/share/licenses/$pname/LICENSE"
    runHook postInstall
  '';
  doCheck = true;
  meta.license = pkgs.lib.licenses.asl20;
}

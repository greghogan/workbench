{ pkgs }:
let runtime = pkgs.jre_minimal.override { jdk = pkgs.jdk25; jdkOnBuild = pkgs.jdk25; modules = [ "java.base" ]; }; in
pkgs.stdenvNoCC.mkDerivation {
  pname = "workbench-java-reference";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type: !(builtins.elem (baseNameOf path)
      [ ".git" "node_modules" "build" "dist" "coverage" ".venv" "__pycache__" "target" ]);
  };
  nativeBuildInputs = [ pkgs.jdk25 pkgs.nodejs_24 pkgs.makeWrapper ];
  propagatedBuildInputs = [];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    node scripts/build-managed.mjs
    runHook postBuild
  '';
  checkPhase = ''
    runHook preCheck
    java -jar build/count.jar 97 banana
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/java $out/bin
    cp build/count.jar $out/share/java/
    makeWrapper ${runtime}/bin/java $out/bin/count --add-flags "-jar $out/share/java/count.jar"
    install -Dm644 LICENSE "$out/share/licenses/$pname/LICENSE"
    runHook postInstall
  '';
  doCheck = true;
  meta.license = pkgs.lib.licenses.asl20;
}

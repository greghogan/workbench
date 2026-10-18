{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "workbench-javascript-reference";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type: !(builtins.elem (baseNameOf path)
      [ ".git" "node_modules" "build" "dist" "coverage" ".venv" "__pycache__" "target" ]);
  };
  nativeBuildInputs = [ pkgs.nodejs_latest ];
  propagatedBuildInputs = [ pkgs.nodejs_latest ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    true
    runHook postBuild
  '';
  checkPhase = ''
    runHook preCheck
    node --input-type=module -e "import assert from 'node:assert/strict';const m=await import('./src/arithmetic.js');assert.equal(m.sum([20,22]),42);assert.equal(m.countByte(new TextEncoder().encode('banana'),97),3);assert.throws(()=>m.countByte(new Uint8Array(),256),RangeError);"
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/nodejs/workbench-javascript-reference/build
    cp -r src $out/share/nodejs/workbench-javascript-reference/build/src
    cp package.json $out/share/nodejs/workbench-javascript-reference/package.json
    install -Dm644 LICENSE "$out/share/licenses/$pname/LICENSE"
    runHook postInstall
  '';
  doCheck = true;
  meta.license = pkgs.lib.licenses.asl20;
}

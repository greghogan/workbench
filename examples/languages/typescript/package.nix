{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "workbench-typescript-reference";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type: !(builtins.elem (baseNameOf path)
      [ ".git" "node_modules" "build" "dist" "coverage" ".venv" "__pycache__" "target" ]);
  };
  nativeBuildInputs = [ pkgs.nodejs_latest pkgs.typescript ];
  propagatedBuildInputs = [ pkgs.nodejs_latest ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    node -e "const f=require('node:fs');const c=JSON.parse(f.readFileSync('tsconfig.json'));c.compilerOptions.types=[];c.compilerOptions.outDir='build';c.include=['src/**/*.ts'];f.writeFileSync('tsconfig.managed.json',JSON.stringify(c));"
    tsc --project tsconfig.managed.json
    runHook postBuild
  '';
  checkPhase = ''
    runHook preCheck
    node --input-type=module -e "import assert from 'node:assert/strict';const m=await import('./build/src/arithmetic.js');assert.equal(m.sum([20,22]),42);assert.equal(m.countByte(new TextEncoder().encode('banana'),97),3);assert.throws(()=>m.countByte(new Uint8Array(),256),RangeError);"
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/nodejs/workbench-typescript-reference/build
    cp -r build/src $out/share/nodejs/workbench-typescript-reference/build/src
    cp package.json $out/share/nodejs/workbench-typescript-reference/package.json
    install -Dm644 LICENSE "$out/share/licenses/$pname/LICENSE"
    runHook postInstall
  '';
  doCheck = true;
  meta.license = pkgs.lib.licenses.asl20;
}

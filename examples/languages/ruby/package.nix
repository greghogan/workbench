{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "workbench-ruby-reference";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type: !(builtins.elem (baseNameOf path)
      [ ".git" "node_modules" "build" "dist" "coverage" ".venv" "__pycache__" "target" ]);
  };
  nativeBuildInputs = [ pkgs.ruby_4_0 pkgs.makeWrapper ];
  propagatedBuildInputs = [];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    true
    runHook postBuild
  '';
  checkPhase = ''
    runHook preCheck
    ruby -Ilib -rworkbench_ruby_reference -e 'abort unless WorkbenchRubyReference.sum([20,22]) == 42; abort unless WorkbenchRubyReference.count_byte("banana",97) == 3'
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/ruby $out/bin
    cp -r lib bin $out/share/ruby/
    makeWrapper ${pkgs.ruby_4_0}/bin/ruby $out/bin/count --add-flags "$out/share/ruby/bin/count" --prefix RUBYLIB : "$out/share/ruby/lib"
    install -Dm644 LICENSE "$out/share/licenses/$pname/LICENSE"
    runHook postInstall
  '';
  doCheck = true;
  meta.license = pkgs.lib.licenses.asl20;
}

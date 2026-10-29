{ pkgs }:
let
  dependencies = builtins.fromJSON (builtins.readFile ./managed-dependencies.json);
  sources = map (entry: {
    inherit (entry) name;
    source = pkgs.fetchurl { inherit (entry) url; hash = entry.integrity; };
  }) dependencies;
in pkgs.stdenvNoCC.mkDerivation {
  pname = "workbench-react-example";
  version = "0.1.0";
  src = pkgs.lib.fileset.toSource {
    root = ./.;
    fileset = pkgs.lib.fileset.unions [ ./src ./scripts ./index.html ./LICENSE ];
  };
  nativeBuildInputs = [ pkgs.nodejs_latest pkgs.esbuild ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    ${pkgs.lib.concatMapStringsSep "\n" (entry: ''
      mkdir -p node_modules/${entry.name}
      tar -xzf ${entry.source} --strip-components=1 -C node_modules/${entry.name}
    '') sources}
    node scripts/build-managed.mjs
    runHook postBuild
  '';
  installPhase = ''
    mkdir -p $out/share/site
    cp -r build/. $out/share/site/
    install -Dm644 LICENSE "$out/share/licenses/$pname/LICENSE"
  '';
  # The release verifier exercises the built site in a fresh DOM outside the builder.
  meta.license = pkgs.lib.licenses.asl20;
}

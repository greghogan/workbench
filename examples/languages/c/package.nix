{ pkgs }:
let
  stdenv = pkgs.overrideCC pkgs.stdenv pkgs.gcc_latest;
  dependency = pkgs.yyjson.override { inherit stdenv; };
in stdenv.mkDerivation {
  pname = "workbench-c-reference";
  version = "0.1.0";
  src = pkgs.lib.fileset.toSource {
    root = ./.;
    fileset = pkgs.lib.fileset.unions [ ./CMakeLists.txt ./README.md ./LICENSE ./src ./include ./tests ];
  };
  nativeBuildInputs = [ pkgs.cmake pkgs.ninja ];
  buildInputs = [ dependency ];
  cmakeFlags = [ "-DWORKBENCH_COMPILER_FAMILY=gcc" "-DWORKBENCH_LTO=full"
    "-DCMAKE_C_COMPILER_AR=${pkgs.gcc_latest.cc}/bin/gcc-ar"
    "-DCMAKE_C_COMPILER_RANLIB=${pkgs.gcc_latest.cc}/bin/gcc-ranlib" ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    ctest --output-on-failure --no-tests=error -j "$NIX_BUILD_CORES"
    runHook postCheck
  '';
  meta.license = pkgs.lib.licenses.asl20;
}

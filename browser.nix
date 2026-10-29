{ pkgs }:
let
  version = builtins.head (builtins.match ".*chromium-headless-shell[[:blank:]]+([0-9.]+).*" (builtins.readFile ./.tool-versions));
  platform = { x86_64-linux = "linux-x64"; aarch64-linux = "linux-arm64"; }.${pkgs.stdenv.hostPlatform.system};
  asset = (builtins.fromJSON (builtins.readFile ./scripts/native-assets.json)).chromium-headless-shell.${version}.${platform};
  libraries = with pkgs; [
    stdenv.cc.cc.lib glib nspr nss dbus at-spi2-core
    libgbm expat libxkbcommon systemd alsa-lib fontconfig
    libx11 libxcomposite libxdamage libxext libxfixes libxrandr libxcb
  ];
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "workbench-headless-shell";
  inherit version;
  src = pkgs.fetchurl { inherit (asset) url sha256; };
  nativeBuildInputs = with pkgs; [ unzip autoPatchelfHook makeWrapper ];
  buildInputs = libraries;
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/libexec/workbench-headless-shell" "$out/bin"
    cp -r . "$out/libexec/workbench-headless-shell/"
    chmod +x "$out/libexec/workbench-headless-shell/chrome-headless-shell"
    makeWrapper "$out/libexec/workbench-headless-shell/chrome-headless-shell" "$out/bin/chrome-headless-shell" \
      --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath libraries}" \
      --set FONTCONFIG_FILE "${pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts pkgs.liberation_ttf ]; }}"
    runHook postInstall
  '';
}

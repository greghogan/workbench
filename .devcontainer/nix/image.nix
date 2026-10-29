{ system, project ? "/preparation", output ? "/output" }:
let
  flake = builtins.getFlake ("path:" + project);
  pkgs = flake.inputs.nixpkgs.legacyPackages.${system};
  rootsFile = builtins.path { path = output + "/roots.json"; name = "workbench-roots.json"; };
  profiles = map builtins.storePath (builtins.fromJSON (builtins.readFile (output + "/profiles.json")));
  runtime = pkgs.buildEnv {
    name = "workbench-container-runtime";
    paths = with pkgs; [ bashInteractive coreutils findutils gnugrep gnused git gnupg nodejs_latest nix cacert gnutar gzip xz which ];
    pathsToLink = [ "/bin" "/etc" ];
  };
  environments = pkgs.runCommand "workbench-environments" {} ''
    mkdir -p "$out/opt/workbench-environments"
    cp ${rootsFile} "$out/opt/workbench-environments/roots.json"
    ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.imap0 (index: profile: ''
      ln -s ${profile} "$out/opt/workbench-environments/${toString index}"
    '') profiles)}
  '';
  accounts = pkgs.runCommand "workbench-container-accounts" {} ''
    mkdir -p "$out/etc" "$out/usr" "$out/lib64"
    printf 'root:x:0:0:root:/root:/bin/bash\nworkbench:x:1000:1000:Workbench:/home/workbench:/bin/bash\n' > "$out/etc/passwd"
    printf 'root:x:0:\nworkbench:x:1000:\nnixbld:x:30000:' > "$out/etc/group"
    for index in $(seq 1 64); do
      printf 'nixbld%s:x:%s:30000:Nix builder:/var/empty:/bin/false\n' "$index" "$((30000 + index))" >> "$out/etc/passwd"
      test "$index" = 1 || printf ',' >> "$out/etc/group"
      printf 'nixbld%s' "$index" >> "$out/etc/group"
    done
    printf '\n' >> "$out/etc/group"
    printf 'ID=nix\nNAME="Nix development container"\n' > "$out/etc/os-release"
    ln -s ${runtime}/bin "$out/usr/bin"
    ln -s ${pkgs.stdenv.cc.bintools.dynamicLinker} "$out/lib64/${builtins.baseNameOf pkgs.stdenv.cc.bintools.dynamicLinker}"
  '';
  start = pkgs.writeShellScriptBin "workbench-start" ''
    set -eu
    mkdir -p /tmp /home/workbench /root /opt/workbench/cache /opt/workbench/data /opt/workbench/state /var/empty
    chmod 1777 /tmp
    chown -R 1000:1000 /home/workbench /opt/workbench/cache /opt/workbench/data /opt/workbench/state
    mkdir -p /nix/var/nix/daemon-socket /nix/var/nix/profiles/per-user
    chmod 1777 /nix/var/nix/profiles/per-user
    exec ${pkgs.nix}/bin/nix-daemon
  '';
in pkgs.dockerTools.buildLayeredImage {
  name = "workbench-nix-prepared";
  includeNixDB = true;
  contents = [ runtime environments accounts start ];
  config = {
    Cmd = [ "${start}/bin/workbench-start" ];
    Env = [ "PATH=/bin" "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" "NIX_CONFIG=experimental-features = nix-command flakes\n" ];
    WorkingDir = "/";
  };
}

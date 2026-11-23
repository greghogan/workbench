#!/usr/bin/env bash
set -euo pipefail
workspace=$(mktemp -d "${RUNNER_TEMP:-/tmp}/workbench-app-sandbox.XXXXXX")
probe_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
export probe_id
trap 'rm -rf -- "$workspace"' EXIT
cd "$workspace"
workspace=$(pwd -P)
mkdir -p input output outside Probe.app/Contents/MacOS Copy.app/Contents/MacOS
printf 'visible\n' > input/expected
printf 'private\n' > outside/omitted
chmod 755 . outside
chmod 644 outside/omitted
cat > launch.c <<'C'
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  fputs("scope launcher entered\n", stderr);
  int fd = open(argv[1], O_RDONLY);
  if (fd < 0) { perror("declared input"); return 3; }
  close(fd);
  fd = open(argv[2], O_RDONLY);
  if (fd >= 0) { close(fd); fputs("undeclared input is readable\n", stderr); return 4; }
  execl("/bin/sh", "sh", "-eu", "-c",
        "test \"$(cat \"$1\")\" = visible; "
        "if cat \"$2\"; then exit 6; fi; "
        "if echo changed >> \"$1\"; then exit 7; fi; "
        "echo report > \"$3/pending\"; mv \"$3/pending\" \"$3/final\";",
        "probe", argv[1], argv[2], argv[3], (char *)0);
  perror("sandboxed child"); return 5;
}
C
python3 - "$workspace" <<'PY'
import os
import plistlib
import shutil
import sys

workspace = sys.argv[1]
entitlements = {

    "com.apple.security.app-sandbox": True,
    "com.apple.security.network.client": True,
    "com.apple.security.network.server": True,
    "com.apple.security.temporary-exception.files.absolute-path.read-only": [workspace + "/input/", os.path.dirname(os.path.dirname(os.path.realpath(shutil.which("node")))) + "/"],
    "com.apple.security.temporary-exception.files.absolute-path.read-write": [workspace + "/output/"],
}
with open("entitlements.plist", "wb") as out:
    plistlib.dump(entitlements, out)
with open("Probe.app/Contents/Info.plist", "wb") as out:
    plistlib.dump({
        "CFBundleIdentifier": "org.workbench.scopeprobe." + os.environ["probe_id"],
        "CFBundleName": "Workbench Scope Probe",
        "CFBundleExecutable": "workbench-scope-probe",
        "CFBundlePackageType": "APPL",
    }, out)
with open("Copy.app/Contents/Info.plist", "wb") as out:
    plistlib.dump({
        "CFBundleIdentifier": "org.workbench.scopeshell." + os.environ["probe_id"],
        "CFBundleName": "Workbench Scope Shell",
        "CFBundleExecutable": "scope-shell",
        "CFBundlePackageType": "APPL",
    }, out)
PY
clang -Wall -Wextra -Werror launch.c -o workbench-scope-probe
cp workbench-scope-probe seatbelt-probe
mv workbench-scope-probe Probe.app/Contents/MacOS/
codesign --force --sign - --entitlements entitlements.plist Probe.app
codesign --verify --strict Probe.app
if ./Probe.app/Contents/MacOS/workbench-scope-probe "$workspace/input/expected" "$workspace/outside/omitted" "$workspace/output"; then
  echo "App Sandbox passed"
else
  echo "App Sandbox failed ($?). Testing a per-process Seatbelt profile."
  log show --last 1m --style compact --predicate 'eventMessage CONTAINS[c] "workbench-scope-probe"' || true
  cat > scope.sb <<POLICY
(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow process-info*)
(allow file-read-metadata)
(allow file-read* (subpath "/usr/lib") (subpath "/System/Library")
   (subpath "/usr/bin") (subpath "/bin") (literal "$workspace/seatbelt-probe")
   (subpath "$workspace/input") (subpath "$workspace/output")
   (literal "/dev/null") (literal "/dev/urandom"))
(allow file-write* (subpath "$workspace/output") (literal "/dev/null"))
POLICY
  if ! /usr/bin/sandbox-exec -f scope.sb ./seatbelt-probe "$workspace/input/expected" "$workspace/outside/omitted" "$workspace/output"; then
    log show --last 1m --style compact --predicate 'eventMessage CONTAINS[c] "seatbelt-probe"' || true
    exit 1
  fi
  echo "Seatbelt passed"
fi
test "$(cat output/final)" = report
test "$(cat input/expected)" = visible

cp /bin/sh Copy.app/Contents/MacOS/scope-shell
codesign --force --sign - --entitlements entitlements.plist Copy.app
codesign --verify --strict Copy.app
cat > input/check.sh <<'SH'
test "$(cat "$1")" = visible
if /bin/sh -c 'cat "$1"' descendant "$2"; then exit 6; fi
if echo changed >> "$1"; then exit 7; fi
cp "$3/final" "$3/copy"
SH
./Copy.app/Contents/MacOS/scope-shell -eu "$workspace/input/check.sh" "$workspace/input/expected" "$workspace/outside/omitted" "$workspace/output"

test "$(cat output/copy)" = report
echo "Signed shell passed"
mkdir repository
git -C repository init --quiet
printf "staged snapshot\n" > repository/input.txt
git -C repository add input.txt
printf "working edit\n" > repository/input.txt
git -C repository show :input.txt > input/staged.txt
cat > input/verify.cjs <<'JS'
const { readFileSync, appendFileSync, writeFileSync, renameSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const [, , original, output] = process.argv;
assert.equal(readFileSync("staged.txt", "utf8"), "staged snapshot\n");
assert.throws(() => appendFileSync("staged.txt", "denied"), { code: "EPERM" });
const child = spawnSync(process.execPath, ["-e", "require('node:fs').readFileSync(process.argv[1])", original],
                        { encoding: "utf8", timeout: 5000 });
assert.equal(child.status, 1);
assert.match(child.stderr, /EPERM|EACCES/);
writeFileSync(output + "/pending.json", "{}");
renameSync(output + "/pending.json", output + "/stable.json");
const server = require("node:http").createServer((_, reply) => reply.end("scope"));
server.listen(0, "127.0.0.1", async () => {
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port, { signal: AbortSignal.timeout(5000) });
    assert.equal(await response.text(), "scope");
    console.log("Loopback check passed");
  } finally {
    server.close();
  }
});
JS
node=$(command -v node)
./Copy.app/Contents/MacOS/scope-shell -eu -c 'cd "$1"; shift; exec "$@"' probe "$workspace/input" "$node" \
    verify.cjs "$workspace/repository/input.txt" "$workspace/output"
test "$(cat output/stable.json)" = '{}'
test "$(cat repository/input.txt)" = 'working edit'
echo "Pinned Node passed with the staged snapshot"
for name in scopeprobe scopeshell; do
  container="$HOME/Library/Containers/org.workbench.$name.$probe_id"
  if [ -d "$container" ]; then
    rm -rf -- "$container"
    test ! -d "$container"
    echo "Removed owned container $name"
  fi
done

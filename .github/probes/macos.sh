#!/usr/bin/env bash
set -euo pipefail
workspace=$(mktemp -d "${RUNNER_TEMP:-/tmp}/workbench-app-sandbox.XXXXXX")
trap 'rm -rf -- "$workspace"' EXIT
cd "$workspace"
workspace=$(pwd -P)
mkdir input output outside
printf 'visible\n' > input/expected
printf 'private\n' > outside/omitted
cat > launch.c <<'C'
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 4) return 2;
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
import plistlib
import sys

workspace = sys.argv[1]
entitlements = {
    "com.apple.security.app-sandbox": True,
    "com.apple.security.temporary-exception.files.absolute-path.read-only": [workspace + "/input/"],
    "com.apple.security.temporary-exception.files.absolute-path.read-write": [workspace + "/output/"],
}
with open("entitlements.plist", "wb") as out:
    plistlib.dump(entitlements, out)
PY
clang -Wall -Wextra -Werror launch.c -o workbench-scope-probe
codesign --force --sign - --entitlements entitlements.plist ./workbench-scope-probe
codesign --verify --strict ./workbench-scope-probe
./workbench-scope-probe "$workspace/input/expected" "$workspace/outside/omitted" "$workspace/output"
test "$(cat output/final)" = report
test "$(cat input/expected)" = visible

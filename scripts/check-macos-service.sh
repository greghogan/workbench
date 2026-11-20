#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $(uname -s) != Darwin || $# != 1 || $(id -u) == 0 ]]; then
    echo 'Usage on a disposable macOS desktop: check-macos-service.sh ARTIFACTS' >&2
    exit 2
fi

node=$(command -v node)
home=$("$node" -p 'require("node:fs").realpathSync(require("node:os").userInfo().homedir)')
artifacts=$(cd "$1" && pwd -P)
domain=gui/$(id -u)
label=org.workbench.app
target="$domain/$label"
definition="$home/Library/LaunchAgents/$label.plist"
/bin/launchctl print "$domain" >/dev/null || {
    echo 'Native user service qualification requires a macOS graphical login session' >&2
    exit 1
}
if [[ -e $definition || -L $definition ]] || /bin/launchctl print "$target" >/dev/null 2>&1; then
    echo 'A Workbench LaunchAgent already exists for this session' >&2
    exit 1
fi
(cd "$artifacts" && shasum -a 256 -c SHA256SUMS)
checksum=$(awk '$2 == "workbench.tar.gz" {print $1}' "$artifacts/SHA256SUMS")
[[ $checksum =~ ^[a-f0-9]{64}$ ]]

fixture=$(mktemp -d "$home/.workbench-launchd-test.XXXXXXXX")
launcher="$fixture/bin/workbench"
environment=(/usr/bin/env -i "HOME=$home" PATH=/usr/bin:/bin:/usr/sbin:/sbin)
managed=("${environment[@]}" "$fixture/node" "$launcher")
cleanup() {
    local status=$?
    if [[ -f $fixture/registered.plist && -e $definition ]]; then
        if cmp -s "$definition" "$fixture/registered.plist"; then
            if [[ -f $fixture/bin/.workbench-installation/update.json ]]; then
                "${managed[@]}" update --recover || status=1
            fi
            "${managed[@]}" uninstall --service user || status=1
        else
            echo 'A changed LaunchAgent was preserved for inspection' >&2
            status=1
        fi
    fi
    if ((status == 0)); then
        rm -r -- "${fixture:?}" || status=1
    else
        printf 'Qualification fixture retained at %s\n' "$fixture" >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -m 0555 "$node" "$fixture/node"
tar -xzf "$artifacts/workbench.tar.gz" -C "$fixture"
cd "$fixture"
"${environment[@]}" "WORKBENCH_CONFIG_HOME=$fixture/config" "WORKBENCH_STATE_HOME=$fixture/state" \
    ./node workbench/bin/workbench.mjs install --archive "$artifacts/workbench.tar.gz" \
    --sha256 "$checksum" --directory "$fixture/bin"
gzip -dc "$artifacts/workbench.tar.gz" | gzip -1n >"$fixture/successor.tar.gz"
next_checksum=$(shasum -a 256 "$fixture/successor.tar.gz" | awk '{print $1}')
[[ $next_checksum != "$checksum" ]]
mv workbench/bundle/main.cjs "$fixture/original-main.cjs"
start_fixture() {
    local name=$1 body=$2
    {
        printf 'if (process.argv[2] === "serve" && process.argv.includes("--service")) { %s }\n' "$body"
        cat "$fixture/original-main.cjs"
    } >workbench/bundle/main.cjs
    COPYFILE_DISABLE=1 tar -czf "$fixture/$name.tar.gz" workbench
    shasum -a 256 "$fixture/$name.tar.gz" | awk '{print $1}'
}
failed_checksum=$(start_fixture failing 'process.exit(69);')
interrupted_checksum=$(start_fixture interrupted 'setInterval(() => {}, 1000); return;')
port=$(
    "$fixture/node" --input-type=module <<'JS'
import { createServer } from "node:net";
const probe = createServer();
probe.listen(0, "127.0.0.1", () => {
  console.log(probe.address().port);
  probe.close();
});
JS
)
"${managed[@]}" install --service user --port "$port"
cp -p "$definition" "$fixture/registered.plist"
/usr/bin/plutil -lint "$definition"
"${managed[@]}" install --service user --port "$port"
cmp -s "$definition" "$fixture/registered.plist"
/bin/launchctl bootstrap "$domain" "$definition"
"$fixture/node" --input-type=module - "$target" "$port" "$checksum" "$next_checksum" "$failed_checksum" "$interrupted_checksum" \
    "${managed[@]}" <<'JS'
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const [target, port, original, successor, failing, interrupted, command, ...args] = process.argv.slice(2);
const origin = `http://127.0.0.1:${port}`;
const launchctl = (...options) => execFileSync("/bin/launchctl", options, { encoding: "utf8" });
const pid = () => Number(/^\s*pid = (\d+)$/m.exec(launchctl("print", target))?.[1] ?? 0);
async function browse(authorization) {
  return fetch(origin + "/projects", {
    headers: authorization ? { authorization } : {},
    signal: AbortSignal.timeout(1000),
  });
}
async function ready(previous) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = pid();
    try {
      const response = await browse();
      if (current > 0 && current !== previous && response.status === 401 && response.headers.has("www-authenticate"))
        return current;
    } catch {
      // The HTTP listener can still be starting.
    }
    await delay(125);
  }
  throw new Error("The registered LaunchAgent did not challenge browser requests");
}
function signIn() {
  const output = execFileSync(command, [...args, "serve"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(/^Workbench web UI: (.+)$/m.exec(output)?.[1], origin);
  const { username } = userInfo();
  assert.equal(/^Sign-in username: (.+)$/m.exec(output)?.[1], username);
  const secret = /^Sign-in password: ([A-Za-z0-9_-]{43})$/m.exec(output)?.[1];
  assert.ok(secret, "Expected an interactive sign-in credential");
  const logs = /^Server logs: (.+)$/m.exec(output)?.[1];
  assert.ok(logs && statSync(logs).isDirectory(), "Expected retained server logs");
  return "Basic " + Buffer.from(username + ":" + secret).toString("base64");
}
const first = await ready();
const authorization = signIn();
assert.equal((await browse(authorization)).status, 200);
launchctl("kill", "SIGTERM", target);
for (let attempt = 0; attempt < 60 && pid() > 0; attempt++) await delay(125);
assert.equal(pid(), 0);
launchctl("kickstart", target);
const restarted = await ready(first);
assert.equal((await browse(authorization)).status, 401);
assert.equal((await browse(signIn())).status, 200);

const active = () => JSON.parse(readFileSync("bin/.workbench-installation/active.json", "utf8")).sha256;
const update = (...options) => spawnSync(command, [...args, "update", ...options], { encoding: "utf8", timeout: 90_000 });
function assertUpdate(result) {
  assert.equal(result.status, 0, result.stderr);
}
assertUpdate(update("--archive", "successor.tar.gz", "--sha256", successor));
assert.equal(active(), successor);
const updated = await ready(restarted);
assert.equal((await browse(signIn())).status, 200);

const rejected = update("--archive", "failing.tar.gz", "--sha256", failing);
assert.equal(rejected.status, 1);
assert.match(rejected.stderr, /previous service release is running/i);
assert.equal(active(), successor);
const restored = await ready(updated);
assert.equal((await browse(signIn())).status, 200);

const updater = spawn(command, [...args, "update", "--archive", "interrupted.tar.gz", "--sha256", interrupted], {
  stdio: "ignore",
});
const exited = once(updater, "exit");
try {
  for (let attempt = 0; attempt < 120 && active() !== interrupted && updater.exitCode === null; attempt++) {
    await delay(125);
  }
  assert.equal(active(), interrupted, "The interrupted update did not reach replacement selection");
} finally {
  updater.kill("SIGKILL");
  await exited;
}
const receipt = "bin/.workbench-installation/update.json";
assert.ok(existsSync(receipt), "The interrupted update did not retain its recovery receipt");
assertUpdate(update("--recover"));
assert.equal(active(), successor);
assert.ok(!existsSync(receipt), "Recovery left a pending update receipt");
const recovered = await ready(restored);
assert.equal((await browse(signIn())).status, 200);

assertUpdate(update("--rollback"));
assert.equal(active(), original);
await ready(recovered);
assert.equal((await browse(signIn())).status, 200);
JS

printf '\n<!-- edited by the qualification fixture -->\n' >>"$definition"
if "${managed[@]}" uninstall --service user; then
    echo 'Removal accepted an edited LaunchAgent' >&2
    exit 1
fi
/bin/launchctl print "$target" >/dev/null
grep -F 'edited by the qualification fixture' "$definition" >/dev/null
cp -p "$fixture/registered.plist" "$definition"
"${managed[@]}" uninstall --service user
[[ ! -e $definition && ! -L $definition && -x $launcher ]]
if /bin/launchctl print "$target" >/dev/null 2>&1; then
    echo 'The LaunchAgent is still registered' >&2
    exit 1
fi
echo 'Verified native macOS LaunchAgent installation, sign-in, update recovery, rollback, and removal.'

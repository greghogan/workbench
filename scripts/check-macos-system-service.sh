#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $(uname -s) != Darwin || $# != 1 || $(id -u) == 0 ]]; then
    echo 'Usage on a disposable macOS runner: check-macos-system-service.sh ARTIFACTS' >&2
    exit 2
fi
sudo -n true
artifacts=$(cd "$1" && pwd -P)
(cd "$artifacts" && shasum -a 256 -c SHA256SUMS)
checksum=$(awk '$2 == "workbench.tar.gz" {print $1}' "$artifacts/SHA256SUMS")
[[ $checksum =~ ^[a-f0-9]{64}$ ]]
target=system/org.workbench.app
definition=/Library/LaunchDaemons/org.workbench.app.plist
runtime=/private/var/db/workbench
for path in "$definition" "$runtime"; do
    if sudo -n test -e "$path" || sudo -n test -L "$path"; then
        echo 'The disposable system service paths are already occupied' >&2
        exit 1
    fi
done
if sudo -n launchctl print "$target" >/dev/null 2>&1; then
    echo 'The disposable Workbench LaunchDaemon is already loaded' >&2
    exit 1
fi

node=$(command -v node)
developer_git="$(/usr/bin/xcode-select --print-path)/usr/bin/git"
[[ -x "$developer_git" ]]
fixture=$(sudo -n mktemp -d /private/var/db/workbench-qualification.XXXXXXXX)
install_bin="$fixture/bin"
management=(sudo -n /usr/bin/env -i HOME=/var/root PATH=/usr/bin:/bin:/usr/sbin:/sbin "$fixture/node")
installed=("${management[@]}" "$install_bin/workbench")
accounts=()
registered=0
cleanup() {
    local status=$? account
    if ((status != 0 && registered)); then
        sudo -n launchctl print "$target" 2>/dev/null |
            awk '/^[[:space:]]*(state|pid|last exit code|last terminating signal) = /' >&2 || true
        sudo -n /usr/bin/log show --last 3m --style compact \
            --predicate 'process == "workbench-launchd" || (process == "launchd" && eventMessage CONTAINS "org.workbench.app")' |
            tail -n 25 >&2 || true
        if sudo -n test -d /var/root/Library/Logs/workbench/server; then
            sudo -n find /var/root/Library/Logs/workbench/server -name events.jsonl -type f \
                -exec /usr/bin/tail -n 3 {} \; | tail -n 20 >&2 || true
        fi
        for home in "$fixture"/account[01]; do
            if sudo -n test -d "$home/Library/Logs/workbench/server"; then
                sudo -n find "$home/Library/Logs/workbench/server" -name events.jsonl -type f \
                    -exec /usr/bin/tail -n 12 {} \; | tail -n 24 >&2 || true
            fi
        done
    fi
    if ((registered)); then
        if sudo -n cmp -s "$definition" "$fixture/registered.plist"; then
            if sudo -n test -f "$install_bin/.workbench-installation/update.json"; then
                "${installed[@]}" update --recover || status=1
            fi
            "${installed[@]}" uninstall --service system || status=1
        elif sudo -n test -e "$definition"; then
            echo 'Preserving changed LaunchDaemon for inspection' >&2
            status=1
        fi
    fi
    for account in "${accounts[@]}"; do
        sudo -n dscl . -delete "/Users/$account" || status=1
    done
    if ((status == 0)); then
        sudo -n rm -r -- "${runtime:?}" "${fixture:?}" || status=1
    else
        printf 'Native fixture retained at %s\n' "$fixture" >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sudo -n chmod 0755 "$fixture"
cd "$fixture"
sudo -n install -m 0555 "$node" "$fixture/node"
sudo -n tar -xzf "$artifacts/workbench.tar.gz" -C "$fixture"
sudo -n install -m 0644 "$artifacts/workbench.tar.gz" "$fixture/archive.tar.gz"
"${management[@]}" "$fixture/workbench/bin/workbench.mjs" install --archive "$fixture/archive.tar.gz" \
    --sha256 "$checksum" --directory "$install_bin"
gzip -dc "$artifacts/workbench.tar.gz" | gzip -1n | sudo -n tee "$fixture/successor.tar.gz" >/dev/null
successor=$(sudo -n shasum -a 256 "$fixture/successor.tar.gz" | awk '{print $1}')
[[ $successor != "$checksum" ]]
main="$fixture/workbench/bundle/main.cjs"
sudo -n mv "$main" "$fixture/original-main.cjs"
{
    printf '%s\n' 'if (process.argv[2] === "serve" && process.argv.includes("--service")) process.exit(69);'
    cat "$fixture/original-main.cjs"
} | sudo -n tee "$main" >/dev/null
sudo -n /usr/bin/env COPYFILE_DISABLE=1 tar -czf "$fixture/failing.tar.gz" workbench
failing=$(sudo -n shasum -a 256 "$fixture/failing.tar.gz" | awk '{print $1}')
port=861
"${installed[@]}" install --service system --port "$port"
sudo -n cp -p "$definition" "$fixture/registered.plist"
registered=1
sudo -n plutil -lint "$definition"
"${installed[@]}" install --service system --port "$port"
sudo -n cmp -s "$definition" "$fixture/registered.plist"

for index in 0 1; do
    account="wb${fixture##*.}$index"
    uid=$((8100 + index))
    home="$fixture/account$index"
    if id "$account" >/dev/null 2>&1 || id -nu "$uid" >/dev/null 2>&1; then
        echo 'An ordinary qualification identity is already occupied' >&2
        exit 1
    fi
    sudo -n dscl . -create "/Users/$account"
    accounts+=("$account")
    sudo -n dscl . -create "/Users/$account" Password '*'
    sudo -n dscl . -create "/Users/$account" UniqueID "$uid"
    sudo -n dscl . -create "/Users/$account" PrimaryGroupID 20
    sudo -n dscl . -create "/Users/$account" UserShell /usr/bin/false
    sudo -n dscl . -create "/Users/$account" NFSHomeDirectory "$home"
    sudo -n install -d -o "$uid" -g staff -m 0700 "$home" "$home/project" "$home/project/workbench"
    printf '[[project]]\nid = "qualification"\nname = "macOS service project %s"\npath = "."\n' "$index" |
        sudo -n -u "$account" tee "$home/project/workbench/projects.toml" >/dev/null
    printf 'schema_version = 1\n[compatibility]\nrequired = false\n' |
        sudo -n -u "$account" tee "$home/project/workbench/config.toml" >/dev/null
    project_git=(sudo -n -u "$account" /usr/bin/env -i "HOME=$home" PATH=/usr/bin:/bin
        "$developer_git" -C "$home/project")
    "${project_git[@]}" init -q
    "${project_git[@]}" add workbench
    "${project_git[@]}" -c user.name=Qualification -c user.email=qualification@example.invalid commit -qm "Baseline"
    sudo -n -u "$account" /usr/bin/env -i "HOME=$home" PATH=/usr/bin:/bin \
        "$fixture/node" "$install_bin/workbench" project add "$home/project" >/dev/null
done
sudo -n launchctl bootstrap system "$definition"
"$node" --input-type=module - "$fixture" "$port" "$target" "$runtime" "$checksum" "$successor" "$failing" "${accounts[@]}" <<'JS'
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [fixture, port, target, runtime, original, successor, failing, ...users] = process.argv.slice(2);
const origin = `http://127.0.0.1:${port}`;
const launchctl = (...args) => execFileSync("sudo", ["-n", "/bin/launchctl", ...args], { encoding: "utf8" });
const pid = () => Number(/^\s*pid = (\d+)$/m.exec(launchctl("print", target))?.[1] ?? 0);
const credentials = (user, password) => "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
const browse = (authorization) => fetch(origin + "/projects", {
  headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(10000),
});
function signIn(index) {
  const user = users[index];
  const result = spawnSync("sudo", ["-n", "-u", user, "/usr/bin/env", "-i", `HOME=${fixture}/account${index}`,
    "PATH=/usr/bin:/bin", `${fixture}/node`, `${fixture}/bin/workbench`, "serve"],
    { encoding: "utf8", timeout: 15000 });
  const detail = (result.stderr?.trim() || result.error?.message || "No diagnostic output.")
    .replace(/[A-Za-z0-9_-]{43}/g, "[redacted]").slice(0, 2048);
  assert.equal(result.status, 0, `The installed CLI failed to obtain system sign-in for account ${index}: ${detail}`);
  assert.equal(/^Workbench web UI: (.+)$/m.exec(result.stdout)?.[1], origin);
  assert.equal(/^Sign-in username: (.+)$/m.exec(result.stdout)?.[1], user);
  const password = /^Sign-in password: ([A-Za-z0-9_-]{43})$/m.exec(result.stdout)?.[1];
  assert.ok(password, "The sign-in password was unavailable");
  return { password, authorization: credentials(user, password) };
}
const firstAccess = users.map((_, index) => signIn(index));
assert.notEqual(firstAccess[0].password, firstAccess[1].password);
for (const [index, access] of firstAccess.entries()) {
  let page = "";
  for (let retry = 0; retry < 40; retry++) {
    const response = await browse(access.authorization);
    assert.equal(response.status, 200);
    page = await response.text();
    if (page.includes('data-review-count="0"')) break;
    await delay(125);
  }
  assert.ok(page.includes('data-review-count="0"'), "The managed account's Git review inventory did not complete");
  assert.ok(page.includes(`macOS service project ${index}`));
  assert.ok(!page.includes(`macOS service project ${1 - index}`));
  const rejected = await browse(credentials(users[1 - index], access.password));
  assert.equal(rejected.status, 401);
  await rejected.text();
}
const first = pid();
assert.ok(first > 0);
launchctl("kill", "SIGTERM", target);
for (let retry = 0; retry < 80 && pid(); retry++) await delay(125);
if (pid()) {
  const processes = execFileSync("/bin/ps", ["-axc", "-o", "pid=,ppid=,state=,comm="], { encoding: "utf8" })
    .trim().split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), state: match[3], command: match[4] }] : [];
    });
  const tree = [first];
  for (const parent of tree) tree.push(...processes.filter((process) => process.parent === parent).map(({ pid }) => pid));
  console.error("Remaining service processes:", processes.filter((process) => tree.includes(process.pid)));
  for (const worker of processes.filter((process) => process.parent === first)) {
    const capture = `${fixture}/shutdown-${worker.pid}.txt`;
    const sample = spawnSync("sudo", ["-n", "/usr/bin/sample", String(worker.pid), "1", "10", "-file", capture],
      { encoding: "utf8", timeout: 5000 });
    if (sample.status === 0) {
      const data = execFileSync("sudo", ["-n", "cat", capture], { encoding: "utf8" });
      console.error(data.split("\n").filter((line) => /uv_|node::|waitpid|posix_spawn|SynchronousRun|DispatchQueue|Thread_/.test(line))
        .slice(0, 80).join("\n"));
    }
  }
}
assert.equal(pid(), 0, `The installed process ${first} left a running service with its launchd registration loaded`);
const replacement = signIn(0);
const second = pid();
assert.ok(second > 0 && first !== second);
assert.notEqual(replacement.password, firstAccess[0].password);
for (const old of firstAccess) {
  const response = await browse(old.authorization);
  assert.equal(response.status, 401, "A stopped macOS process's credential remained valid");
  await response.text();
}
const response = await browse(replacement.authorization);
assert.equal(response.status, 200);
await response.text();

const installedState = fixture + "/bin/.workbench-installation";
const active = () => JSON.parse(readFileSync(installedState + "/active.json", "utf8")).sha256;
const endpoint = () => {
  const { ino, dev } = lstatSync(runtime + "/control.sock");
  return [ino, dev];
};
const originalEndpoint = endpoint();
function update(expectedStatus, ...args) {
  const result = spawnSync("sudo", ["-n", "/usr/bin/env", "-i", "HOME=/var/root", "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    fixture + "/node", fixture + "/bin/workbench", "update", ...args], { encoding: "utf8", timeout: 90_000 });
  assert.equal(result.status, expectedStatus, result.stderr);
  assert.deepEqual(endpoint(), originalEndpoint, "The protected launchd socket changed during release transition");
  return result;
}
update(0, "--archive", fixture + "/successor.tar.gz", "--sha256", successor);
assert.equal(active(), successor);
const updated = pid();
assert.ok(updated > 0 && updated !== second);
assert.equal((await browse(replacement.authorization)).status, 401);
assert.equal((await browse(signIn(0).authorization)).status, 200);
const rejected = update(1, "--archive", fixture + "/failing.tar.gz", "--sha256", failing);
assert.match(rejected.stderr, /previous service release is running/i);
assert.equal(active(), successor);
assert.equal((await browse(signIn(0).authorization)).status, 200);
update(0, "--rollback");
assert.equal(active(), original);
assert.ok(pid() > 0 && pid() !== updated);
assert.equal((await browse(signIn(0).authorization)).status, 200);
JS
sudo -n test ! -e "$runtime/browser-sessions.json"
"${installed[@]}" uninstall --service system
registered=0
[[ ! -e $definition && -x $install_bin/workbench ]]
sudo -n test -d "$runtime"
if sudo -n launchctl print "$target" >/dev/null 2>&1; then
    echo 'The Workbench LaunchDaemon is still loaded' >&2
    exit 1
fi
printf '%s\n' 'Verified installed macOS shared sign-in, account isolation, restart, protected release switch, and owned removal.'

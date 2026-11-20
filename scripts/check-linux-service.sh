#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# != 2 || ($1 != user && $1 != system) ]]; then
    echo 'Usage: check-linux-service.sh user|system ARTIFACTS' >&2
    exit 2
fi

scope=$1
artifacts=$(realpath "$2")
node=$(command -v node)
native_unit=workbench.service
[[ -d /run/systemd/system ]] || {
    echo 'Native systemd is required' >&2
    exit 1
}
sudo -n true
if [[ $scope == system ]]; then
    # The system check uses the real registration name on a disposable runner.
    [[ $(sudo -n systemctl show --property=LoadState --value "$native_unit") == not-found ]]
    [[ ! -e /etc/systemd/system/$native_unit && ! -L /etc/systemd/system/$native_unit ]]
    [[ ! -e /run/systemd/system/$native_unit.d ]]
fi
(cd "$artifacts" && sha256sum --check --strict SHA256SUMS)

fixture=$(sudo -n mktemp -d /run/workbench-systemd-test.XXXXXXXX)
account=wbtest${fixture##*.}
account=${account,,}
uid=""
second_account=""
second_uid=""
registered=0
dropin=""
definition=""
management=()
installed=()
manual_pid=""
updater_pid_file=""
variants=""
status=0
cleanup() {
    status=$?
    if [[ -n $manual_pid ]]; then
        "${account_env[@]}" /usr/bin/kill -TERM "$manual_pid" 2>/dev/null || true
    fi
    if [[ -n $updater_pid_file ]] && sudo -n test -f "$updater_pid_file"; then
        local updater
        updater=$(sudo -n cat "$updater_pid_file")
        if [[ $updater =~ ^[1-9][0-9]*$ ]] &&
            sudo -n grep -Fzqx -- "$updater_pid_file" "/proc/$updater/cmdline" 2>/dev/null; then
            sudo -n kill -KILL "$updater" || status=1
        fi
    fi
    if ((registered)); then
        # This directory and the source definition were created by this invocation.
        if sudo -n cmp -s "$definition" "$fixture/original.service"; then
            if sudo -n cmp -s "${release[1]}" "$fixture/damaged-launcher"; then
                sudo -n cp -- "$fixture/working-launcher" "${release[1]}" || status=1
            fi
            if sudo -n test -f "$install_bin/.workbench-installation/update.json"; then
                "${installed[@]}" update --recover >/dev/null || status=1
            fi
            "${installed[@]}" uninstall --service "$scope" >/dev/null || status=1
        elif sudo -n test -e "$definition"; then
            echo 'A changed service registration was preserved for inspection' >&2
            status=1
        fi
    fi
    if [[ -n $dropin ]]; then
        sudo -n rm -- "$dropin" || status=1
        sudo -n rmdir -- "${dropin%/*}" || status=1
        sudo -n systemctl daemon-reload || status=1
    fi
    if [[ -n $uid ]]; then
        if [[ $scope == user ]]; then
            sudo -n systemctl stop "user@$uid.service" "user-runtime-dir@$uid.service" || status=1
        fi
        sudo -n userdel "$account" || status=1
    fi
    if [[ -n $second_uid ]]; then
        sudo -n userdel "$second_account" || status=1
    fi
    if [[ -n $variants ]]; then
        rm -r -- "$variants" || status=1
    fi
    if ((status == 0)); then
        sudo -n rm -r -- "${fixture:?}" || status=1
    else
        printf 'Qualification files retained at %s\n' "$fixture" >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sudo -n chmod 0755 "$fixture"
sudo -n tar --no-same-owner -xzf "$artifacts/workbench.tar.gz" -C "$fixture"
sudo -n install -m 0644 "$artifacts/workbench.tar.gz" "$fixture/archive.tar.gz"
checksum=$(awk '{print $1}' "$artifacts/SHA256SUMS")
sudo -n install -m 0755 "$node" "$fixture/node"
sudo -n install -d -m 0700 "$fixture/config" "$fixture/state"
sudo -n install -d -m 0755 "$fixture/runtime"
sudo -n useradd -M -d "$fixture/account" -s /sbin/nologin "$account"
uid=$(id -u "$account")
gid=$(id -g "$account")
home="$fixture/account"
sudo -n install -d -o "$account" -g "$gid" -m 0700 "$home"
account_env=(
    sudo -n /usr/bin/setpriv --reuid "$uid" --regid "$gid" --init-groups /usr/bin/env -i
    "HOME=$home" "USER=$account" "LOGNAME=$account" PATH=/usr/bin:/bin
    "XDG_RUNTIME_DIR=/run/user/$uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus"
    "WORKBENCH_SYSTEM_RUNTIME_DIRECTORY=$fixture/runtime"
)
release=("$fixture/node" "$fixture/workbench/bin/workbench.mjs")
started=$(date +%s)
if [[ $scope == user ]]; then
    sudo -n systemctl start "user@$uid.service"
    management=("${account_env[@]}" /usr/bin/systemctl --user)
    installed=("${account_env[@]}" "${release[@]}")
    definition="$home/.config/systemd/user/$native_unit"
    install_bin="$home/bin"
    data="$home/.local/state/workbench/retained-data"
    "${account_env[@]}" mkdir -p "${data%/*}"
    "${account_env[@]}" touch "$data"
    journal=(sudo -n journalctl "_SYSTEMD_USER_UNIT=$native_unit" "_UID=$uid")
else
    management=(sudo -n systemctl)
    installed=(
        sudo -n /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin
        "WORKBENCH_CONFIG_HOME=$fixture/config" "WORKBENCH_STATE_HOME=$fixture/state"
        "${release[@]}"
    )
    definition="/etc/systemd/system/$native_unit"
    install_bin="$fixture/bin"
    data="$fixture/state/retained-data"
    sudo -n touch "$data"
    journal=(sudo -n journalctl -u "$native_unit" --since "@$started")
    second_account="${account}b"
    second_home="$fixture/second-account"
    sudo -n useradd -M -d "$second_home" -s /sbin/nologin "$second_account"
    second_uid=$(id -u "$second_account")
    second_gid=$(id -g "$second_account")
    sudo -n install -d -o "$second_uid" -g "$second_gid" -m 0700 "$second_home"
    second_env=(
        sudo -n /usr/bin/setpriv --reuid "$second_uid" --regid "$second_gid" --init-groups /usr/bin/env -i
        "HOME=$second_home" "USER=$second_account" "LOGNAME=$second_account" PATH=/usr/bin:/bin
        "WORKBENCH_SYSTEM_RUNTIME_DIRECTORY=$fixture/runtime"
    )
fi

if "${installed[@]}" install --archive "$fixture/archive.tar.gz" --sha256 "$(printf '%064d' 0)" --directory "$install_bin"; then
    echo 'Installation accepted an incorrect archive checksum' >&2
    exit 1
fi
sudo -n test ! -e "$install_bin/workbench"
"${installed[@]}" install --archive "$fixture/archive.tar.gz" --sha256 "$checksum" --directory "$install_bin"
external_installer=("${installed[@]}")
release[1]="$install_bin/workbench"
installed[-1]="${release[1]}"

port=$(
    sudo -n "$fixture/node" --input-type=module - "$scope" <<'JS'
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

const scope = process.argv[2];
const maximum = Math.min(1024, Number(readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8")));
const choices = scope === "user" ? [0] : Array.from({ length: maximum - 1 }, (_, index) => maximum - index - 1);
for (const port of choices) {
  const server = createServer();
  const actual = await new Promise((resolve) => {
    server.once("error", () => resolve(0));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address().port;
      server.close(() => resolve(address));
    });
  });
  if (actual) {
    console.log(actual);
    process.exit(0);
  }
}
throw new Error("Could not select a test listener port");
JS
)
check_protected_port() {
    "${account_env[@]}" "$fixture/node" --input-type=module - "$port" <<'JS'
import { createServer } from "node:net";
const server = createServer();
server.on("error", (error) => {
  if (error.code !== "EACCES") throw error;
});
server.listen(Number(process.argv[2]), "0.0.0.0", () => {
  server.close();
  throw new Error("An ordinary account claimed the reserved service port");
});
JS
}
if [[ $scope == system ]]; then
    check_protected_port
    "${external_installer[@]}" config set --scope global daemon.worker_idle_seconds 2
fi
"${installed[@]}" install --service "$scope" --port "$port"
sudo -n grep -F -- "${release[1]}" "$definition" >/dev/null
sudo -n cp -- "$definition" "$fixture/original.service"
registered=1
"${installed[@]}" install --service "$scope" --port "$port"
printf '%s\n' '# edited by the qualification fixture' | sudo -n tee -a "$definition" >/dev/null
if "${installed[@]}" uninstall --service "$scope"; then
    echo 'Removal accepted an edited service definition' >&2
    exit 1
fi
sudo -n grep -F '# edited by the qualification fixture' "$definition" >/dev/null
sudo -n cp -- "$fixture/original.service" "$definition"

if [[ $scope == system ]]; then
    dropin="/run/systemd/system/$native_unit.d/qualification.conf"
    sudo -n mkdir -- "${dropin%/*}"
    cat <<ENV | sudo -n tee "$dropin" >/dev/null
[Service]
RuntimeDirectory=
StateDirectory=
Environment=WORKBENCH_SYSTEM_RUNTIME_DIRECTORY=$fixture/runtime
Environment=WORKBENCH_SYSTEM_STATE_DIRECTORY=$fixture/state
Environment=WORKBENCH_STATE_HOME=$fixture/state
Environment=WORKBENCH_CONFIG_HOME=$fixture/config
ENV
fi
"${management[@]}" daemon-reload
"${management[@]}" enable --now "$native_unit"
started_pid=$("${management[@]}" show --property=MainPID --value "$native_unit")
sudo -n cp -- "${release[1]}" "$fixture/working-launcher"
{
    sudo -n head -n 2 -- "${release[1]}"
    printf 'process.exit(67);\n'
} | sudo -n tee "$fixture/damaged-launcher" >/dev/null
sudo -n cp -- "$fixture/damaged-launcher" "${release[1]}"
if "${installed[@]}" executable --json; then
    echo 'The damaged launcher unexpectedly ran Workbench' >&2
    exit 1
fi
"${external_installer[@]}" install --repair --archive "$fixture/archive.tar.gz" --sha256 "$checksum" \
    --directory "$install_bin"
sudo -n cmp -s "${release[1]}" "$fixture/working-launcher"
entry_digest=$(sudo -n sha256sum "$fixture/damaged-launcher" | awk '{print $1}')
sudo -n cmp -s "$fixture/damaged-launcher" "$install_bin/.workbench-installation/repair/workbench-$entry_digest"
[[ $("${management[@]}" show --property=MainPID --value "$native_unit") == "$started_pid" ]]
sudo -n test -f "$data"
if [[ $scope == user ]]; then
    alternate="$home/alternate"
    elsewhere=("${account_env[@]}" "XDG_CONFIG_HOME=$alternate" "${release[@]}")
    "${elsewhere[@]}" install --service user --port "$port"
    if "${elsewhere[@]}" uninstall --service user; then
        echo 'Removal accepted a different definition from the one the manager loaded' >&2
        exit 1
    fi
    "${management[@]}" is-active --quiet "$native_unit"
    sudo -n test -f "$alternate/systemd/user/$native_unit"
fi

"$node" --input-type=module - "$scope" "$fixture" "$port" "$account" "${release[1]}" "${account_env[@]}" <<'JS'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const [scope, fixture, port, account, launcher, ...accountCommand] = process.argv.slice(2);
const expected = new URL(`http://127.0.0.1:${port}`).origin;
function invoke([command, ...args]) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
  assert.equal(result.status, 0, "The native service qualification command failed");
  return result.stdout;
}
async function browse(authorization) {
  return fetch(expected + "/projects", {
    headers: authorization ? { authorization } : {},
    signal: AbortSignal.timeout(2000),
  });
}
async function ready() {
  for (let attempt = 0; attempt < 75; attempt++) {
    try {
      const response = await browse();
      if (response.status === 401 && response.headers.has("www-authenticate")) return;
    } catch {
      // The loopback listener may still be starting.
    }
    await delay(100);
  }
  throw new Error("The installed service did not challenge browser requests");
}
await ready();
const signIn = invoke([...accountCommand, `${fixture}/node`, launcher, "serve"]);
assert.equal(/^Workbench web UI: (.+)$/m.exec(signIn)?.[1], expected);
assert.equal(/^Sign-in username: (.+)$/m.exec(signIn)?.[1], account);
const secret = /^Sign-in password: ([A-Za-z0-9_-]{43})$/m.exec(signIn)?.[1];
assert.ok(secret, "Sign-in did not issue a credential");
const authorization = "Basic " + Buffer.from(account + ":" + secret).toString("base64");
const mismatched = "Basic " + Buffer.from(account + "-incorrect:" + secret).toString("base64");
assert.equal((await browse(mismatched)).status, 401);
assert.equal((await browse(authorization)).status, 200);
const manager = scope === "user" ? [...accountCommand, "/usr/bin/systemctl", "--user"] : ["sudo", "-n", "/usr/bin/systemctl"];
invoke([...manager, "restart", "workbench.service"]);
await ready();
assert.equal((await browse(authorization)).status, scope === "user" ? 401 : 200);
JS

if [[ $scope == system ]]; then
    register_fixture_project() {
        local name=$1 project=$2
        shift 2
        "$@" mkdir -p "$project/workbench"
        printf '[[project]]\nid = "qualification"\nname = "%s"\npath = "."\n' "$name" |
            "$@" tee "$project/workbench/projects.toml" >/dev/null
        "$@" "${release[@]}" project add "$project" >/dev/null
        "$@" "${release[@]}" project --json
    }
    first_projects=$(register_fixture_project 'Native service project one' "$home/project" "${account_env[@]}")
    second_projects=$(register_fixture_project 'Native service project two' "$second_home/project" "${second_env[@]}")
    {
        "${account_env[@]}" "${release[@]}" serve
        "${second_env[@]}" "${release[@]}" serve
    } | "$node" --input-type=module -e "$(
        cat <<'JS'
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [port, runtime, firstAccount, secondAccount, secondHome, ...registries] = process.argv.slice(1);
const origin = new URL(`http://127.0.0.1:${port}`).origin;
const signIns = Array.from(readFileSync(0, "utf8").matchAll(/^Sign-in username: ([^\r\n:]+)\nSign-in password: ([A-Za-z0-9_-]{43})$/gm));
assert.deepEqual(signIns.map((entry) => entry[1]), [firstAccount, secondAccount]);
assert.equal(new Set(signIns.map((entry) => entry[2])).size, 2, "Independent OS accounts must have different credentials");
const users = registries.map((registry, index) => {
  const projects = JSON.parse(registry);
  assert.equal(projects.length, 1, "Each OS account should own one registration");
  return {
    href: `/projects/${projects[0].id}/`,
    authorization: "Basic " + Buffer.from(signIns[index][1] + ":" + signIns[index][2]).toString("base64"),
  };
});
assert.notEqual(users[0].href, users[1].href);
const browse = (user, path = "/projects", init = {}) =>
  fetch(origin + path, {
    signal: AbortSignal.timeout(5000),
    ...init,
    headers: { authorization: user.authorization, ...init.headers },
  });
const workers = () =>
  execFileSync("sudo", ["-n", "find", runtime, "-path", "*/ready/*", "-type", "s", "-print"], {
    encoding: "utf8",
  }).trim();
function accountIsBusy() {
  const probe = spawnSync("sudo", ["-n", "/usr/bin/pgrep", "-u", secondAccount], { stdio: "ignore" });
  if (probe.error || ![0, 1].includes(probe.status)) throw new Error("Could not inspect the test account's processes");
  return probe.status === 0;
}
async function checkProjectIsolation() {
  await Promise.all(users.map(async (user, index) => {
    const response = await browse(user);
    assert.equal(response.status, 200);
    const dashboard = await response.text();
    assert.ok(dashboard.includes(user.href), "The account dashboard is missing its project");
    assert.ok(!dashboard.includes(users[1 - index].href), "Another account project appeared in the dashboard");
    assert.equal((await browse(user, users[1 - index].href)).status, 404);
  }));
}
await checkProjectIsolation();
const stream = await browse(users[0], "/events", { signal: AbortSignal.timeout(20_000) });
assert.equal(stream.status, 200);
assert.equal(stream.headers.get("content-type"), "text/event-stream");
try {
  const deadline = Date.now() + 15_000;
  while (workers().split("\n").filter(Boolean).length > 1 && Date.now() < deadline) await delay(125);
  assert.match(workers(), /^[^\n]+$/, "Only the worker with an open event stream should remain");
} finally {
  await stream.body.cancel();
}
async function waitForIdleWorkers() {
  const deadline = Date.now() + 15_000;
  while ((workers() || accountIsBusy()) && Date.now() < deadline) await delay(125);
  assert.equal(workers(), "", "Idle workers should stop while the shared listener stays up");
  assert.ok(!accountIsBusy(), "Wait for the test account's process exit before changing its home");
}
function changeHome(home) {
  execFileSync("sudo", ["-n", "/usr/sbin/usermod", "--home", home, secondAccount]);
}
await waitForIdleWorkers();
changeHome(secondHome + "/changed");
try {
  const stale = await browse(users[1]);
  await stale.arrayBuffer();
  assert.equal(stale.status, 403, "A saved sign-in must match the account at worker startup");
  assert.equal(workers(), "", "A stale account must not start a new worker");
} finally {
  await waitForIdleWorkers();
  changeHome(secondHome);
}
await checkProjectIsolation();
const signedOut = await browse(users[0], "/sign-out", { method: "POST", headers: { origin } });
assert.equal(signedOut.status, 200);
assert.equal((await browse(users[0])).status, 401);
assert.equal((await browse(users[1])).status, 200);
JS
    )" "$port" "$fixture/runtime" "$account" "$second_account" "$second_home" "$first_projects" "$second_projects"
    echo 'Verified isolated project access, account revalidation at worker startup, and independent sign-out.'
fi

transcript=$("${journal[@]}" --no-pager -o cat)
grep -F 'Workbench web UI:' <<<"$transcript" >/dev/null
if grep -Fi 'Sign-in password:' <<<"$transcript" >/dev/null; then
    echo 'The native service journal contains a sign-in credential' >&2
    exit 1
fi
# The variants differ only in archive bytes or the controlled outcome during service startup.
prepare_update_variants() {
    variants=$(mktemp -d)
    tar -xzf "$artifacts/workbench.tar.gz" -C "$variants"
    local bundle="$variants/workbench/bundle/main.cjs"
    local variant prelude
    cp -- "$bundle" "$variants/main.cjs"
    gzip -dc "$artifacts/workbench.tar.gz" | gzip -1n >"$variants/successor.tar.gz"
    for variant in failed-start interrupted-start; do
        prelude='process.exit(69);'
        if [[ $variant == interrupted-start ]]; then
            prelude='setInterval(() => {}, 1000); return;'
        fi
        {
            printf 'if (process.argv[2] === "serve" && process.argv.includes("--service")) { %s }\n' "$prelude"
            cat "$variants/main.cjs"
        } >"$bundle"
        tar -czf "$variants/$variant.tar.gz" -C "$variants" workbench
    done
    for variant in successor failed-start interrupted-start; do
        sudo -n install -m 0644 "$variants/$variant.tar.gz" "$fixture/$variant.tar.gz"
    done
}
archive_checksum() {
    sha256sum "$1" | awk '{print $1}'
}
active_digest() {
    sudo -n "$fixture/node" --input-type=module - "$install_bin" <<'JS'
import { readFileSync } from "node:fs";
console.log(JSON.parse(readFileSync(process.argv[2] + "/.workbench-installation/active.json", "utf8")).sha256);
JS
}
main_pid() {
    "${management[@]}" show --property=MainPID --value "$native_unit"
}
interrupt_update() {
    local archive=$1 digest=$2 previous=$3 manager_state updater waiter changed before_recovery
    updater_pid_file="$install_bin/updater.pid"
    "${installed[@]:0:${#installed[@]}-1}" --input-type=module - \
        "$updater_pid_file" "${release[1]}" "$archive" "$digest" <<'JS' &
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [pidFile, launcher, archive, digest] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid), { flag: "wx", mode: 0o600 });
process.argv = [process.execPath, launcher, "update", "--archive", archive, "--sha256", digest];
await import(pathToFileURL(launcher).href);
JS
    waiter=$!
    changed=0
    for _ in {1..200}; do
        manager_state=$("${management[@]}" show --property=ActiveState --value "$native_unit")
        if [[ $(active_digest) == "$digest" && $manager_state == activating ]]; then
            changed=1
            break
        fi
        kill -0 "$waiter" 2>/dev/null || break
        sleep 0.05
    done
    if ((changed == 0)); then
        echo 'The interrupted update did not reach service startup' >&2
        return 1
    fi
    updater=$(sudo -n cat "$updater_pid_file")
    [[ $updater =~ ^[1-9][0-9]*$ ]]
    sudo -n grep -Fzqx -- "$updater_pid_file" "/proc/$updater/cmdline"
    sudo -n kill -KILL "$updater"
    if wait "$waiter"; then
        echo 'The terminated update incorrectly reported success' >&2
        return 1
    fi
    updater_pid_file=""
    sudo -n test -f "$install_bin/.workbench-installation/update.json"
    if "${installed[@]}" executable --json; then
        echo 'The launcher exposed the unconfirmed release' >&2
        return 1
    fi
    "${installed[@]}" update --recover
    [[ $(active_digest) == "$previous" ]]
    "${management[@]}" is-active --quiet "$native_unit"
    sudo -n test ! -e "$install_bin/.workbench-installation/update.json"
    before_recovery=$(main_pid)
    "${installed[@]}" update --recover
    [[ $(main_pid) == "$before_recovery" ]]
    printf 'Verified recovery after interrupting the systemd %s update during startup.\n' "$scope"
}
prepare_update_variants
candidate="$fixture/successor.tar.gz"
next_checksum=$(archive_checksum "$candidate")
[[ $checksum != "$next_checksum" ]]
before=$(main_pid)
"${installed[@]}" update --archive "$candidate" --sha256 "$next_checksum"
[[ $(active_digest) == "$next_checksum" ]]
[[ $(main_pid) != "$before" ]]
"${management[@]}" is-active --quiet "$native_unit"
failed_candidate="$fixture/failed-start.tar.gz"
failed_checksum=$(archive_checksum "$failed_candidate")
[[ $failed_checksum != "$next_checksum" && $failed_checksum != "$checksum" ]]
before=$(main_pid)
if "${installed[@]}" update --archive "$failed_candidate" --sha256 "$failed_checksum"; then
    echo 'The update accepted a replacement that cannot start its service' >&2
    exit 1
fi
[[ $(active_digest) == "$next_checksum" ]]
[[ $(main_pid) != "$before" ]]
"${management[@]}" is-active --quiet "$native_unit"
interrupted_candidate="$fixture/interrupted-start.tar.gz"
interrupted_checksum=$(archive_checksum "$interrupted_candidate")
interrupt_update "$interrupted_candidate" "$interrupted_checksum" "$next_checksum"
before=$(main_pid)
"${installed[@]}" update --rollback
[[ $(active_digest) == "$checksum" ]]
[[ $(main_pid) != "$before" ]]
"${management[@]}" is-active --quiet "$native_unit"
"${management[@]}" stop "$native_unit"
manual_output=$(cd "$fixture" && "${account_env[@]}" "${release[@]}" serve --daemon --port 0)
manual_pid=$(sed -n 's/^Server PID: \([0-9][0-9]*\)$/\1/p' <<<"$manual_output")
[[ $manual_pid =~ ^[1-9][0-9]*$ ]]
if "${installed[@]}" update --archive "$candidate" --sha256 "$next_checksum"; then
    echo 'The update switched releases while a manual server was active' >&2
    exit 1
fi
[[ $(active_digest) == "$checksum" ]]
"${account_env[@]}" /usr/bin/kill -TERM "$manual_pid"
for _ in {1..100}; do
    if ! "${account_env[@]}" /usr/bin/kill -0 "$manual_pid" 2>/dev/null; then break; fi
    sleep 0.05
done
if "${account_env[@]}" /usr/bin/kill -0 "$manual_pid" 2>/dev/null; then
    echo 'The manually started qualification service did not stop' >&2
    exit 1
fi
manual_pid=""
"${management[@]}" start "$native_unit"
printf 'Verified native systemd %s release update and rollback.\n' "$scope"
"${installed[@]}" uninstall --service "$scope"
registered=0
[[ $("${management[@]}" show --property=ActiveState --value "$native_unit") == inactive ]]
sudo -n test ! -e "$definition"
sudo -n test -f "$data"
sudo -n test -f "${release[1]}"
if [[ $scope == system ]]; then
    check_protected_port
    sudo -n test -f "$fixture/state/browser-sessions.json"
fi
"${installed[@]}" uninstall --service "$scope"
printf 'Verified native systemd %s registration, browser sign-in, restart, and state-preserving removal.\n' "$scope"

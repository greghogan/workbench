#!/bin/bash
set -euo pipefail

if [[ $(uname -s) != Darwin || $# != 2 || ! $2 =~ ^[0-9]{1,4}$ ]] || (($2 < 1 || $2 > 1023)); then
    printf '%s\n' 'Usage on a disposable macOS host: test-launchd.sh NODE RESERVED_PORT' >&2
    exit 2
fi
sudo -n true
source_directory=$(cd "$(dirname "$0")" && pwd -P)
scratch=$(mktemp -d /private/tmp/workbench-launchd.XXXXXXXX)
suffix=$(basename "$scratch" | cut -d. -f2)
node="$scratch/node"
probe="$scratch/launchd-probe.mjs"
port="$2"
server="org.workbench.qualification.$suffix"
declare -a users=() labels=()
cleanup() {
    local label user status=$?
    for label in "${labels[@]}"; do
        if sudo -n launchctl print "system/$label" >/dev/null 2>&1; then
            sudo -n launchctl bootout "system/$label" || status=1
        fi
    done
    for user in "${users[@]}"; do
        sudo -n dscl . -delete "/Users/$user" || status=1
    done
    sudo -n rm -rf -- "$scratch" || status=1
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sudo -n chown root:wheel "$scratch"
sudo -n chmod 755 "$scratch"
sudo -n install -m 0555 "$1" "$node"
sudo -n install -m 0444 "$source_directory/launchd-probe.js" "$probe"

# The disposable host must have a free port and both address families before this qualifies its permissions.
baseline=$(sudo -n "$node" "$probe" bind-check "$port" 0)
"$node" -e 'if (!Object.values(JSON.parse(process.argv[1])).every((x) => x === "listened")) throw Error(process.argv[1])' "$baseline"

new_user() {
    local user=$1 uid=$2 directory=$3
    if id "$user" >/dev/null 2>&1 || id -nu "$uid" >/dev/null 2>&1; then
        printf 'Temporary account %s or UID %s is already in use\n' "$user" "$uid" >&2
        return 1
    fi
    sudo -n dscl . -create "/Users/$user"
    users+=("$user")
    sudo -n dscl . -create "/Users/$user" Password '*'
    sudo -n dscl . -create "/Users/$user" UniqueID "$uid"
    sudo -n dscl . -create "/Users/$user" PrimaryGroupID 20
    sudo -n dscl . -create "/Users/$user" UserShell /usr/bin/false
    sudo -n dscl . -create "/Users/$user" NFSHomeDirectory "$directory"
    sudo -n install -d -o "$uid" -g staff -m 0700 "$directory"
    printf '%s\n' 'own fixture' | sudo -n -u "$user" tee "$directory/project" >/dev/null
}
create_service() {
    local label=$1 user=$2
    shift 2
    local temporary
    temporary=$(mktemp)
    "$node" --input-type=module -e '
        const [label, user, ...program] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({ Label: label, UserName: user, ProgramArguments: program, RunAtLoad: true }));
    ' "$label" "$user" "$node" "$probe" "$@" >"$temporary"
    sudo -n plutil -convert xml1 -o "$scratch/$label.plist" "$temporary"
    rm -f -- "$temporary"
    sudo -n chmod 0644 "$scratch/$label.plist"
    labels+=("$label")
    sudo -n launchctl bootstrap system "$scratch/$label.plist"
}
check_bindings() {
    local situation=$1 index=$2 result
    result=$(sudo -n -u "${users[$index]}" "$node" "$probe" bind-check "$port" "$((8100 + index))")
    printf '%s account %s %s\n' "$situation" "$index" "$result"
    "$node" --input-type=module -e '
        const results = Object.values(JSON.parse(process.argv[1]));
        const allowed = ["EACCES", "EPERM"];
        if (process.argv[2] === "running") allowed.push("EADDRINUSE");
        process.exitCode = results.every((code) => allowed.includes(code)) ? 0 : 1;
    ' "$result" "$situation"
}
wait_for_listener() {
    for _ in {1..30}; do
        if "$node" "$probe" connect "$port" >/dev/null 2>&1; then
            return
        fi
        sleep 0.1
    done
    sudo -n launchctl print "system/$server" >&2
    return 1
}

new_user "wbAs$suffix" 8100 "$scratch/a"
new_user "wbBs$suffix" 8101 "$scratch/b"
unprotected=0
for index in 0 1; do
    check_bindings before "$index" || unprotected=1
done

create_service "$server" root serve "$port"
wait_for_listener
for index in 0 1; do
    check_bindings running "$index" || unprotected=1
done

create_service "$server.a" "${users[0]}" worker "$scratch/a/project" "$scratch/b/project" 8100 "$scratch/a/proof"
create_service "$server.b" "${users[1]}" worker "$scratch/b/project" "$scratch/a/project" 8101 "$scratch/b/proof"
for _ in {1..30}; do
    if sudo -n test -s "$scratch/a/proof" && sudo -n test -s "$scratch/b/proof"; then
        break
    fi
    sleep 0.1
done
[[ $(sudo -n cat "$scratch/a/proof") == 8100 && $(sudo -n cat "$scratch/b/proof") == 8101 ]]
printf '%s\n' 'Two native launchd workers read their own project data and were denied access to the other account.'

sudo -n launchctl bootout "system/$server"
for index in 0 1; do
    check_bindings stopped "$index" || unprotected=1
done
if ((unprotected)); then
    printf '%s\n' 'The configured port did not protect the origin under all address forms and lifecycle states.' >&2
    exit 1
fi

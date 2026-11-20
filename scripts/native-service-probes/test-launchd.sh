#!/bin/bash
set -euo pipefail

if [[ $(uname -s) != Darwin || $# -lt 2 || $# -gt 3 || ! $2 =~ ^[0-9]{1,4}$ ]] || (($2 < 1 || $2 > 1023)); then
    printf '%s\n' 'Usage on a disposable macOS host: test-launchd.sh NODE RESERVED_PORT [activation]' >&2
    exit 2
fi
sudo -n true
source_directory=$(cd "$(dirname "$0")" && pwd -P)
scratch=$(mktemp -d /private/tmp/workbench-launchd.XXXXXXXX)
suffix=$(basename "$scratch" | cut -d. -f2)
node="$scratch/node"
probe="$scratch/launchd-probe.mjs"
port="$2"
mode=${3:-direct}
[[ $mode == direct || $mode == activation ]]
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
    local temporary program
    temporary=$(mktemp)
    if [[ $1 == activation ]]; then
        program="$scratch/socket-probe"
        xcrun clang -std=c17 -Wall -Wextra -Werror "$source_directory/launchd-socket-probe.c" -o "$temporary.bin"
        sudo -n install -m 0555 "$temporary.bin" "$program"
        rm -f -- "$temporary.bin"
        "$node" --input-type=module -e '
            const [label, user, program, port] = process.argv.slice(1);
            const listener = (SockNodeName, SockFamily) => ({ SockNodeName, SockFamily,
                SockServiceName: port, SockType: "stream", SockProtocol: "TCP" });
            const Sockets = { Loopback: [listener("127.0.0.1", "IPv4"), listener("::1", "IPv6")] };
            process.stdout.write(JSON.stringify({ Label: label, UserName: user, ProgramArguments: [program],
                Sockets, ThrottleInterval: 1 }));
        ' "$label" "$user" "$program" "$port" >"$temporary"
    else
        "$node" --input-type=module -e '
            const [label, user, ...program] = process.argv.slice(1);
            process.stdout.write(JSON.stringify({ Label: label, UserName: user, ProgramArguments: program, RunAtLoad: true }));
        ' "$label" "$user" "$node" "$probe" "$@" >"$temporary"
    fi
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
        if (!["before", "stopped"].includes(process.argv[2])) allowed.push("EADDRINUSE");
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

registered_pid() {
    sudo -n launchctl print "system/$server" | awk '$1 == "pid" && $2 == "=" && $3 ~ /^[1-9][0-9]*$/ {print $3}'
}

check_registered_bindings() {
    local index
    for index in 0 1; do
        check_bindings "$1" "$index"
    done
}

verify_activation() {
    local first second host actual current
    create_service "$server" root activation
    current=$(registered_pid)
    [[ -z $current ]]
    check_registered_bindings waiting-for-activation

    first=$("$node" "$probe" activation-pid "$port" 127.0.0.1)
    actual=$("$node" "$probe" activation-pid "$port" ::1)
    current=$(registered_pid)
    [[ $actual == "$first" && $current == "$first" ]]
    printf 'Initial activation on both loopback addresses used process %s.\n' "$first"
    check_registered_bindings running
    sudo -n launchctl kill SIGTERM "system/$server"
    for _ in {1..60}; do
        current=$(registered_pid)
        if [[ -z $current ]] && ! sudo -n kill -0 "$first" 2>/dev/null; then
            break
        fi
        sleep 0.1
    done
    [[ -z $current ]]
    if sudo -n kill -0 "$first" 2>/dev/null; then
        printf 'The initial launchd probe process is still running.\n' >&2
        return 1
    fi
    printf 'The launchd registration remains loaded without a service process.\n'
    check_registered_bindings waiting-for-restart

    second=$("$node" "$probe" activation-pid "$port" 127.0.0.1)
    [[ $second != "$first" ]]
    for host in 127.0.0.1 ::1; do
        actual=$("$node" "$probe" activation-pid "$port" "$host")
        [[ $actual == "$second" ]]
    done
    current=$(registered_pid)
    [[ $current == "$second" ]]
    printf 'The same loopback endpoints activated a new process %s.\n' "$second"
    check_registered_bindings reactivated
    sudo -n launchctl bootout "system/$server"
    if sudo -n launchctl print "system/$server" >/dev/null 2>&1; then
        printf 'The launchd registration is still loaded after deliberate unload.\n' >&2
        return 1
    fi
    printf 'The ownership proof ends when the registration is deliberately unloaded.\n'
}

new_user "wbAs$suffix" 8100 "$scratch/a"
new_user "wbBs$suffix" 8101 "$scratch/b"
if [[ $mode == activation ]]; then
    verify_activation
    exit
fi
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

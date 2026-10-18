#!/bin/sh
set -eu
builder=$1
case "$builder" in
nix) nix-daemon --option sandbox true & ;;
guix) /opt/workbench-guix/bin/guix-daemon --build-users-group=guixbuild & ;;
*)
    echo 'Expected nix or guix' >&2
    exit 2
    ;;
esac
daemon=$!
owner=$(stat -c '%u:%g' /output)
cleanup() {
    status=$?
    kill "$daemon" || true
    wait "$daemon" || true
    chown -R --no-dereference "$owner" /output
    exit "$status"
}
trap cleanup EXIT
# Only the store daemon retains privilege. Evaluate project definitions as an ordinary builder client.
cp -a /preparation /tmp/workbench-builder-source
mkdir -p /tmp/workbench-builder-home
chown -R --no-dereference 1000:1000 /tmp/workbench-builder-source /tmp/workbench-builder-home /output
export HOME=/tmp/workbench-builder-home NIX_REMOTE=daemon
export XDG_CACHE_HOME="$HOME/.cache" XDG_CONFIG_HOME="$HOME/.config" XDG_STATE_HOME="$HOME/.local/state"
cd /tmp/workbench-builder-source
attempt=0
while :; do
    case "$builder" in
    nix) nix --extra-experimental-features 'nix-command flakes' store ping >/dev/null 2>&1 && break ;;
    guix) /opt/workbench-guix/bin/guix gc --list-roots >/dev/null 2>&1 && break ;;
    esac
    attempt=$((attempt + 1))
    if ! kill -0 "$daemon" 2>/dev/null || [ "$attempt" -ge 60 ]; then
        echo "$builder store daemon did not become ready" >&2
        exit 1
    fi
    sleep 1
done
setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --no-new-privs \
    /bin/sh ".devcontainer/$builder/prepare.sh"

#!/bin/sh
set -eu
output=${WORKBENCH_MANAGED_OUTPUT:-/output}
if [ -z "${WORKBENCH_GUIX_PROFILES_FILE:-}" ]; then
    node "${WORKBENCH_PREPARATION_DISTRIBUTION:-.}/scripts/prepare-guix-profiles.mjs"
    WORKBENCH_GUIX_TIME_MACHINE_PROFILE=$(cat "$output/guix-runtime")
    WORKBENCH_GUIX_MANAGER=$(cat "$output/guix-manager")
    export WORKBENCH_GUIX_TIME_MACHINE_PROFILE
    export WORKBENCH_GUIX_MANAGER
    WORKBENCH_GUIX_PROFILES_FILE=$output/guix-profiles.json
    export WORKBENCH_GUIX_PROFILES_FILE
fi
node "${WORKBENCH_PREPARATION_DISTRIBUTION:-.}/scripts/pack-guix-image.mjs"

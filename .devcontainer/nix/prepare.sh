#!/bin/sh
set -eu
node "${WORKBENCH_PREPARATION_DISTRIBUTION:-.}/scripts/prepare-nix-profiles.mjs"

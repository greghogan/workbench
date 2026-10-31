---
status: Done
---

# TSK-0: Preserve explicitly configured native Cargo target directories

## Review summary

Native Rust commands and checks preserve an explicitly supplied Cargo target directory. Managed Nix/Guix environments
continue to use Workbench-owned build directories.

## Context

Catalog's direnv configuration selected its machine-specific Rust cache, but Workbench's external-build environment
overrode that selection. Native checks also lost the value after accepting it through `checks.pass_environment`.

## Progress

- [x] Reproduce both overrides in focused tests.
- [x] Preserve native caller configuration and retain defaults for absent/empty values.
- [x] Document ownership and pruning boundaries; configure Catalog to pass its selected target to native checks.
- [x] Verify the rebuilt CLI reports Catalog's actual direnv-selected target.
- [x] Complete the repository pre-commit check.

## Plan

Keep the change limited to native environment precedence; do not change managed build identities or retention authority.

## Findings

The build environment was merged after caller-declared variables, so an unconditional Rust override displaced the value.
Changing the command's working directory alone does not activate that project's direnv environment.

## Outcome

Native Rust uses a supplied, nonempty `CARGO_TARGET_DIR`, otherwise its existing Workbench default. Caller-owned target
directories are outside Workbench's automatic build pruning. Catalog's `.envrc` remains unchanged.

## Validation

- Before the fix: two regression failures, 48 passes, four Windows-only skips.
- After the fix: 50 passes, four Windows-only skips in builds and native-check environment tests.
- Configured build role: setup and build both passed, including type checking and CLI bundle generation.
- Actual `direnv exec /efs/devel/catalog ... workbench paths` reports the target selected by Catalog's `.envrc`.
- Full pre-commit validation: passed under benchctl hold `01a18e952a547893be2639604b051513`, check run
  `28574844-477b-4335-9eb0-a6914abf7eae`.

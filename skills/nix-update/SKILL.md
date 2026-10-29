---
name: nix-update
description:
  Update a project's pinned Nix flake inputs or package versions when a human explicitly requests that update and the
  project uses Nix for checks locally or in CI.
---

# Nix update

Use this skill only for a human-requested Nix update where configured local or CI checks use `nix` or `nix-docker`.

1. Read the shared environment policy, the Nix decision, applicable project decisions, and `workbench/config.toml`.
   Identify the check root and its `flake.nix` and `flake.lock`; do not assume the repository root owns every
   environment.
2. Show the current input revisions and requested target. If the request leaves the target open, identify suitable
   upstream revisions and say what you selected. Update only the requested inputs or package specifications.
3. Verify the lockfile resolves, then run the affected checks in the pinned environment. Report old and new revisions,
   checks run, and any unavailable platform.

Do not stage or commit the change unless the user explicitly asks.

After verified updates, respect `cache.auto_prune`. If more space is needed, inspect `workbench cache` and review a
fresh `workbench cache prune` plan before applying it. Preserve active or uncertain assets; do not delete cache
directories directly.

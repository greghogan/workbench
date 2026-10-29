---
name: guix-update
description:
  Update a project's pinned Guix channel or package versions when a human explicitly requests that update and the
  project uses Guix for checks locally or in CI.
---

# Guix update

Use this skill only for a human-requested Guix update where configured local or CI checks use `guix`.

1. Read the shared environment policy, the Guix decision, applicable project decisions, and `workbench/config.toml`.
   Identify each affected check root's effective `channels.scm` and its `manifest.scm`: a root-specific channel file
   completely replaces the project-root default; absent that file, use the project-root pin. Check roots need not be
   separate project scopes.
2. Show the current channel revision and requested target. If the request leaves the target open, identify a suitable
   upstream revision and say what you selected. Do not refresh unrelated pins or switch to Nix.
3. Change the requested pin or package specification, preserving the existing channel structure. Do not enter a Guix
   environment in the user's shell or change `.envrc`.
4. Verify the pinned environments and run the affected checks across check roots using the changed declaration. Report
   the old and new revisions, checks run, and any unavailable package or platform.

Do not stage or commit the change unless the user explicitly asks.

After verified updates, respect `cache.auto_prune`. If more space is needed, inspect `workbench cache` and review a
fresh `workbench cache prune` plan before applying it. Preserve active or uncertain assets; do not delete cache
directories directly.

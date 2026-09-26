---
name: nix-update
description: Update a project's pinned Nix flake inputs or package versions when a human explicitly requests that update and the project uses Nix for checks.
---

# Nix update

Use this skill only for a human-requested Nix update in a project whose selected check environment is `nix`.

1. Read the project's environment decision and `workbench/config.toml`. Identify the check root and its `flake.nix`
   and `flake.lock`; do not assume the repository root owns every environment.
2. Show the current input revisions and requested target. If the request leaves the target open, identify suitable
   upstream revisions and say what you selected. Update only the requested inputs or package specifications.
3. Verify the lockfile resolves, then run the affected checks in the pinned environment. Use `benchctl hold` for heavy
   work when benchd is installed. Report old and new revisions, checks run, and any unavailable platform.

Do not stage or commit the change unless the user explicitly asks.

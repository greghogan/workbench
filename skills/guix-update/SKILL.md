---
name: guix-update
description: Update a project's pinned Guix channel or package versions when a human explicitly requests that update and the project uses Guix for checks.
---

# Guix update

Use this skill only for a human-requested Guix update in a project whose selected check environment is `guix`.

1. Read the project's environment decision and `workbench/config.toml`. Identify the check root and its
   `channels.scm` and `manifest.scm`; do not assume the repository root owns every environment.
2. Show the current channel revision and requested target. If the request leaves the target open, identify a suitable
   upstream revision and say what you selected. Do not refresh unrelated pins or switch to Nix.
3. Change the requested pin or package specification, preserving the existing channel structure. Do not enter a Guix
   environment in the user's shell or change `.envrc`.
4. Verify the pinned environment and run the affected checks. Use `benchctl hold` for heavy work when benchd is
   installed. Report the old and new revisions, checks run, and any unavailable package or platform.

Do not stage or commit the change unless the user explicitly asks.

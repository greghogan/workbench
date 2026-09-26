# ADR-G: Explicit development environments

Summary: Configured checks use a pinned Guix or Nix environment when selected.

Agent instruction: Do not update Guix or Nix versions or pins unless a human explicitly requests it.

`[checks].environment` selects `none`, `guix`, `nix`, or `nix-docker`; an individual check may override it. `none` runs
on the host. Guix uses pinned `channels.scm` and `manifest.scm` in a container shell. Both Nix modes use `flake.nix`
and `flake.lock`: `nix` runs the host CLI, while `nix-docker` runs Nix in a Docker container using the image digest in
`checks.nix_docker_image`.

The Docker mode copies the project into an ephemeral container worktree before running its command, so checks cannot
leave root-owned artifacts in the repository. Each Docker check must therefore be self-contained; changes made by one
check are not available to the next. A Docker volume keyed by the image digest retains the Nix store between checks.

The selected environment supplies tools for the configured command. Language lockfiles still govern project
dependencies. A missing environment definition is an error, not a fallback to host tools.

Humans choose when to change Guix or Nix package versions, channel commits, flake input revisions, or the Nix Docker
image digest. Workbench never updates them automatically; an agent may prepare a human-requested update for review.

Workbench executes selected checks inside the environment; `.envrc` never loads one into the user's shell.

Guix and Nix updates are separate skills. Both Nix modes activate the same Nix update skill. Sync exposes an
environment's update skill only if a configured check uses that environment; merely having a manifest or flake does
not activate it.

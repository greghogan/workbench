---
summary:
  Local selection, managed tool authority, package-derived environments, development tools, and human-led updates.
agent_instruction:
  Prefer configured Workbench runners for builds and checks. Direct tool commands are appropriate within an already
  prepared environment. Change Nix or Guix package versions or environment pins only at a human's explicit request.
---

# ADR-P: Development environments

Native, Nix, and Guix independently determine tool versions; Nix and Guix are managed environments. A workspace runs the
selected environment on the host or in a Dev Container. One local development profile is active; CI selects coverage
separately. Development and CI use the same committed definitions. Missing definitions or failed setup never permit
native fallback.

Select the builder and host or container workspace independently within a development profile. Local development and CI
may use different workspaces while sharing the same environment definitions.

Selection precedence is explicit command, active Workbench shell, ignored local preference, then shared check default.
Preferences cannot redefine commands, CI coverage, or generated shared context. Staged checks retain local selection
while reading commands and definitions from the proposed tree.

Prefer configured Workbench runners for builds and checks. Direct tool commands are appropriate within an already
prepared environment. Explicit development shells use selected tools and the working checkout. Managed shells retain one
root's environment; changing it requires leaving the shell. Native workspaces may select pins per root. Setup and
dependent checks share a session; never activate an environment in the user's existing shell automatically.

Report actual tools: native versions match native pins, while managed versions come from pinned definitions
independently of native support floors. All environments share application dependency declarations. Never silently
substitute another environment's tools or download a replacement interpreter. Equal upstream versions do not promise
identical recipes or builds.

For Nix and Guix, derive release packages and development build inputs from one package definition, adding check,
debugging, interactive, and IDE tools only for development. Include version-control, SSH, synchronization, navigation,
and editing capabilities. Release packages retain only application and runtime requirements. Copied definitions remain
project-owned without implicit Workbench updates.

Humans initiate changes to Guix/Nix package versions, channels, flake inputs, and the Nix container image digest. Agents
may prepare and verify requested updates; verification failures do not authorize pin changes.

Rationale: Explicit selection and shared package definitions preserve provenance without duplicating build inputs or
changing the user's shell. Human-led updates keep repairs from silently changing the environment under evaluation.

---
summary: Local selection, provenance, human-led updates.
agent_instruction: Change Guix/Nix environment versions or pins only on explicit human request.
---

# ADR-Q: Development environments

Apply ADR-9. Projects may support both Guix and Nix while retaining a native workflow requiring neither. One local
development profile selects native, Guix, or Nix tooling, optionally within a Dev Container; CI selects coverage
independently. Local execution and CI use the same committed environment definitions. Missing definitions or failed
setup are errors; never fall back to native tools.

Selection precedence is explicit command, active Workbench shell, ignored machine-local preference, then shared check
default. Local preferences cannot redefine commands, CI coverage, or shared generated context. Staged-tree checks retain
local execution selection but take commands and definitions from the staged tree.

Explicitly opened development shells use the selected tools and working checkout. Guix/Nix shells retain one root's
tools; changing that root or environment requires leaving the shell. Native-tool Dev Containers select native pins for
each root; managed profiles retain their Nix or Guix tool authority within the container workspace. Keep setup and
dependent checks in one session to retain intermediate files. Never activate an environment in the user's existing shell
automatically.

Inspect and report actual tools: native versions must match native pins; managed tools must satisfy supported-version
requirements. Guix and Nix own their package versions under ADR-9; Dev Containers retain the selected profile's tool
authority. All environments share language dependency declarations. Never silently substitute another environment's
tools or download a replacement interpreter. Matching upstream versions does not promise identical builds across recipes
and platforms.

Environment definition files copied from references become project-owned under ADR-1. Updating Workbench does not
implicitly replace those files or advance their pins.

Humans initiate changes to Guix or Nix package versions, channel commits, flake input revisions, or the Nix container
image digest. Agents may prepare and verify requested updates; verification failures do not authorize a pin update.

Rationale: Explicit selection makes tool provenance reproducible without changing the user's shell. Human control of
environment updates prevents incidental repairs from silently changing the toolchain under evaluation.

---
summary: Local selection, provenance, human-led updates.
agent_instruction: Change Guix/Nix environment versions or pins only on explicit human request.
---

# ADR-R: Development environments

Apply ADR-B. Projects may support both Guix and Nix while retaining a native workflow requiring neither. One local
selection chooses native, Guix, Nix, or a Dev Container; CI selects coverage independently under ADR-Z. Local execution
and CI use the same committed environment definitions. Missing definitions or failed setup are errors; never fall back
to native tools.

Selection precedence is explicit command, active Workbench shell, ignored machine-local preference, then shared check
default. Local preferences cannot redefine commands, CI coverage, or shared generated context. Staged-tree checks retain
local execution selection but take commands and definitions from the staged tree.

Explicitly opened development shells use the selected tools and working checkout. Guix/Nix shells retain one root's
tools; changing that root or environment requires leaving the shell. Dev Containers select native pins for each root
within their workspace. Keep setup and dependent checks in one session to retain intermediate files. Never activate an
environment in the user's existing shell automatically.

Inspect and report actual tools: native versions must match native pins; managed tools must satisfy supported-version
requirements. Guix and Nix own their package versions under ADR-B; Dev Containers reuse native selections under ADR-14.
All environments share language dependency declarations. Never silently substitute another environment's tools or
download a replacement interpreter. Matching upstream versions does not promise identical builds across recipes and
platforms. Nix and Guix specialize this policy in ADR-S and ADR-T.

Humans initiate changes to Guix or Nix package versions, channel commits, flake input revisions, or the Nix container
image digest. Agents may prepare and verify requested updates; verification failures do not authorize a pin update.

Rationale: Explicit selection makes tool provenance reproducible without changing the user's shell. Human control of
environment updates prevents incidental repairs from silently changing the toolchain under evaluation.

---
name: update-ci
description:
  Refresh CI tool versions, action revisions, compiler images, and Debian bases on request in a Workbench project.
  Preserve narrower update or inspection scope; use fix-ci for failure diagnosis.
---

# CI updates

Identify version owners across workflows, registered roots, matrices, native pins, containers, and cache identities.
Preserve inspection-only and targeted scope. General updates include newer Debian stable and point releases. Follow the
applicable language and environment support policies; report proposed boundary changes for human review.

When developing Workbench, prefer `maintenance:plan` and `maintenance:apply` for repeatable discovery and source
updates. Inspect unavailable and constrained targets before claiming completeness. These scripts update development
inputs; installed releases and adopted collections have separate workflows. Consumers retain their own maintenance
tools.

Choose maintained stable inputs from primary sources. For Debian bases or LLVM APT packages, read
[compiler-environments.md](references/compiler-environments.md) for suite, architecture, provenance, and reproducibility
checks. Preserve the configured platform/compiler matrix and libc compatibility; report unavailable combinations.

Coordinate compilers, formatters, linters, coverage tools, and runtimes within each environment. Install required
components, verify stripped/repackaged artifacts, pin images and archives immutably, and resolve action releases to full
commits. Update acquisition metadata, documentation, and cache identities together. Coordinate separate toolchain
publishers with consumer pins; Linux images do not replace native macOS/Windows verification.

Nix/Guix changes require a request covering those environments; use their update skills. Their package versions may
differ from native or APT pins.

Build changed containers and run affected checks in their actual environments, then the applicable gate. Identify
emulation and unavailable platforms. Report retained version changes, relevant sizes, verification, and limitations; a
local pass does not establish a hosted pass. Staging, commits, publication, and remote runs retain the user's
authorization boundaries.

After verified updates, respect `cache.auto_prune`. If more space is needed, inspect `workbench cache` and review a
fresh `workbench cache prune` plan before applying it. Preserve active or uncertain assets; do not delete cache
directories directly.

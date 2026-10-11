---
summary:
  Named development and release profiles, native and managed builders, portable packages, and artifact verification.
---

# ADR-Y: Builds and deployment artifacts

Apply ADR-9, ADR-U, and ADR-Q. Projects declare named development and release profiles with their builders, locked
inputs, target platforms, and output formats. One local development profile is active for a workspace; release
preparation can select one profile, several, or all configured release profiles, defaulting to all. Development
selection does not redefine release targets or CI coverage.

Native, Nix, and Guix builders may coexist in a project. Dev Containers provide a workspace around any selected builder;
they do not establish an independent compiler authority. A native profile consumes native tool declarations, while Nix
or Guix owns a managed profile's toolchain. Avoid independently installing those compilers through container features.
Projects may provide a pinned prebuilt development image or a local container build definition without requiring the
managed builder to be installed on the host.

Release profiles may prepare native artifacts, OCI images, Nix closures or portable bundles, Guix relocatable tarballs,
Guix squashfs packs, and Apptainer workflows where supported by the selected builder. Configuration selects supported
combinations explicitly; unavailable formats fail rather than being approximated silently. Complete operating-system
deployments are outside this framework's release scope.

Prefer builders native to the target architecture. Cross-compilation and emulation are explicit in build provenance;
identify every dependence on emulation for human review. Compilation alone does not demonstrate target execution.
Separate development, instrumented, and optimized release builds, retaining toolchain and dependency identities.

Preparation creates local artifacts without tagging or publishing them. Keep generated Workbench runtime bundles
distinct from project release outputs. Verify artifacts outside the source checkout, including runtime dependencies,
relocation or container behavior, declared architecture, and supported release flags. Provided packaging workflows
require behavioral evidence on the reference projects.

Registry publication is a separate selected operation with explicit credentials and verification of the published
artifact's identity and behavior. Routine quality gates do not publish releases. Local rehearsal cannot substitute for
hosted registry authorization or publication evidence.

Release and development profile declarations are project-owned under ADR-1. Shared language specifications retain their
replacement semantics; copied environment and packaging definitions receive no implicit upstream updates.

Rationale: Separate development selection and release targets permit several reproducible outputs without changing the
contributor's active tools. Explicit builders, provenance, and artifact execution make deployment claims verifiable.

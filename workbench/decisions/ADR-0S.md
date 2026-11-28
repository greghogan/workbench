---
summary: Artifact profiles, separate toolchain and dependency inputs, verified transfer, and retention.
---

# ADR-S: Builds and deployment artifacts

Projects declare named artifact profiles that select builders, project scopes, and supported combinations of artifact
kind, target, and format. Toolchain artifacts supply verified tools and their runtime libraries. Development artifacts
also supply the locked project inputs needed to build and check a fresh checkout offline. Release artifacts supply the
application and its runtime requirements.

## Prepared environments

Identify the recipe, realized artifact, and verification separately. Recipe identity follows content-producing inputs,
including builder, target, and relevant pins. Project dependency changes can reuse a matching toolchain artifact. Record
actual bytes and environment provenance. Match verification to those bytes, relevant source, target, and verifier.
Verify offline development through fresh source builds and execution with networking disabled and empty host caches.

Native operating-system packages follow ADR-A. Nix and Guix derive toolchains and locked dependency inputs from their
respective environment definitions. Realize those inputs independently of application builds, within declared resource
limits.

Managed preparation preserves the selected environment's authority and isolates its effects from unrelated host state.
Retain realized development profiles against garbage collection until their owning cache is explicitly pruned. Include
persistent builder stores in cache reporting and protect active preparation during cleanup.

Reuse a matching local image, otherwise try the configured project registry. Report retrieval failures before building
locally from the same pinned recipe.

Images are internal project artifacts selected by checked-out configuration, without promotion. Apply configured
retention only to owned local cached images, protecting active use and images explicitly selected for retention.
Preserve existing images when ownership or replacement evidence is uncertain. Deletion of published registry images
remains explicit.

## Release artifacts

Release requirements apply only to configured builders and formats. Reject unsupported combinations explicitly. Complete
operating systems are outside release scope. Release images contain only the application and required runtime
dependencies.

Runnable release artifacts declare supported operating systems and architectures and their complete runtime
requirements, including native libraries, external tools and child processes, assets, and system services. Bundling a
language runtime alone does not establish independence from other system dependencies. Running a released application
does not require installing its authoring toolchain or development dependency tree.

Release support is defined by target behavior and runtime requirements, independently of the builder's host. Native and
cross-built artifacts meet the same verification requirements. Provenance identifies cross-compilation and emulation;
emulation dependencies require human review. Release evidence includes execution outside the source checkout on the
supported targets, covering promised behavior, runtime dependencies, relocation or container operation, architecture,
and supported flags.

An explicitly unverified transfer may carry a candidate to its target host. Authenticate the transferred manifest and
payload before staging them privately. Target verification is required before activation or publication.

Preparation creates local artifacts. An authorized publication operation verifies the published identity and behavior,
including offline claims for prepared images.

Rationale: Independent profiles and shared preparation inputs support reproducible outputs. Artifact execution verifies
offline and deployment claims. Explicit runtime requirements separate deployment needs from authoring choices.

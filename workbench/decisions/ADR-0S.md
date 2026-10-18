---
summary: Development and release profiles, prepared image identities, portability, and artifact verification.
---

# ADR-S: Builds and deployment artifacts

Projects declare named development and release profiles selecting builders, locked inputs, platforms, and formats.
Development selection does not change release targets. Container profiles use pinned images or local build recipes
without requiring their selected builder on the host.

## Prepared environments

Projects may prepare project-wide offline development images. Select images by hashes of builder, native architecture,
image definitions, OS repository snapshot, and locked inputs. Changes only to orchestration, cache handling,
publication, or verification do not change image identity. Local development and CI share recipes and identities. Verify
offline capability through fresh source builds and execution with networking disabled and no host caches before
publication.

Build Nix and Guix images entirely from their respective environment definitions and all resulting dependencies,
including the inputs needed to build and check each included subproject. Preparation stays within declared resource
limits. Do not populate these images by running project builds or language package managers.

Managed preparation preserves the selected environment's authority and isolates its effects from unrelated host state.
Retain realized development profiles against garbage collection until their owning cache is explicitly pruned. Include
persistent builder stores in cache reporting and protect active preparation during cleanup.

Reuse a matching local image, otherwise try the configured project registry. Report retrieval failures before building
locally from the same pinned recipe.

Images are internal project artifacts selected by checked-out configuration, without promotion. Image deletion is
explicit; neither infer supersession nor prune automatically.

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

Preparation creates local artifacts without tagging or publishing. Publication is separately selected with explicit
credentials and verification of published identity and behavior, including offline claims for prepared images. Routine
gates never publish releases.

Rationale: Independent profiles and shared preparation inputs support reproducible outputs. Artifact execution verifies
offline and deployment claims. Explicit runtime requirements separate deployment needs from authoring choices.

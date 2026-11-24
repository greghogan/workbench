---
summary: Configured CI coverage, shared local execution, prepared environments, and publication authorization.
---

# ADR-Y: Continuous integration

Run the complete configured gate for the CI stage on pushes and proposed merges, with manual execution available. Each
project configures its platforms, environments, and compatibility profiles; changed-path filtering does not replace
required gates. Copied workflows are project-owned; shared adapters follow the project's executable pin.

Promised native platform support requires native execution evidence. Derive prepared environments from the artifact
catalog in ADR-S. CI can use verified host tools or prepared toolchain images and restore locked project dependencies
separately. Move to toolchain images after qualified replacements are available. Verify restored and reacquired tools
against the declared pins and host ABI.

Preserve distinct platforms, toolchains, and build settings in CI coverage. Equivalent variants can share source checks.
Verify each packaged format on its promised target.

Pin external workflow components immutably, grant minimum permissions, bound job durations, and expose independent
failures. Restrict publication credentials to authorized publication jobs and source revisions. Use explicit publication
by default. Projects may separately enable publication on selected branch pushes and version tags. Each publication
requires matching verification.

Provide local rehearsal sharing checks, profiles, images, and artifact verification with hosted CI. Preserve the
checkout and index, isolate outputs, coordinate shared caches, and retain diagnostics without implicit emulation.

Rationale: Shared execution definitions keep local and hosted verification consistent. Native execution supports
platform claims; publication authorization and credential isolation limit which code can publish artifacts.

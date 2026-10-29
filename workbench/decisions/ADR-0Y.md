---
summary: Configured CI coverage, shared local execution, prepared environments, and publication authorization.
---

# ADR-Y: Continuous integration

Run the complete configured gate for the CI stage on pushes and proposed merges, with manual execution available. Each
project configures its platforms, environments, and compatibility profiles; changed-path filtering does not replace
required gates. Copied workflows are project-owned; shared adapters follow the project's executable pin.

Promised native platform support requires native execution evidence. Native jobs may use verified host installations or
ADR-S prepared images. CI may assemble container environments when preparation is lightweight; otherwise, pull published
prepared images and fail if retrieval fails. Restored and reacquired tools receive the same integrity and host ABI
checks; verification never advances pins.

Pin external workflow components immutably, grant minimum permissions, bound job durations, and expose independent
failures. Restrict publication credentials to authorized publication jobs and source revisions. Publish preparation
images only after verification.

Provide local rehearsal sharing checks, profiles, images, and artifact verification with hosted CI. Preserve the
checkout and index, isolate outputs, coordinate shared caches, and retain diagnostics without implicit emulation.

Rationale: Shared execution definitions keep local and hosted verification consistent. Native execution supports
platform claims; publication authorization and credential isolation limit which code can publish artifacts.

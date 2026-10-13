---
summary: Complete gates, native platforms, project-wide prepared environments, and local rehearsal.
---

# ADR-10: GitHub continuous integration

Run ADR-U's complete configured CI gate on pushes and pull requests, with manual execution available. Configuration owns
platforms, environments, and compatibility profiles. Documentation changes retain the complete gate; no changed-path
filtering substitutes for it. Consumers may narrow their configured coverage. Copied workflows are project-owned under
ADR-1; referenced shared definitions and adapters follow the distribution pin.

Workbench and all language and framework examples exercise Linux x64/ARM64, macOS ARM64, and Windows x64. Group roots
and tool profiles within each native platform job. Examples use their selected development releases; Workbench's own
Node runtime support receives its maintained-release matrix. Optional GCC profiles run on Linux. These examples
demonstrate multiple languages in one project without claiming exhaustive compiler compatibility testing.

Native host jobs may retain verified installations or reacquire them under project policy. Linux may instead reuse the
prepared development images of ADR-T. Nix and Guix CI use those retained images and run Workbench and every configured
example; local managed development may use host installations. Keep tool authorities separate. Local preparation and CI
share recipes, configuration identities, and registry acquisition. An explicitly authorized trusted job may publish a
verified preparation image; untrusted changes receive no publication credentials. Release publication remains separate.

Coverage replaces ordinary suite execution on configured targets. Use immutable action revisions, minimum permissions,
and bounded job durations. Keep independent failures visible. Verification does not advance tool or environment pins.
Retained artifacts and verified downloads receive the same acquisition checks and host ABI validation.

Provide a Linux x64 rehearsal through the CLI and Makefile, defaulting to all configured Linux x64 targets with explicit
subset selection. Share checks, tool profiles, images, and release verification with hosted CI. Preserve the checkout
and index, isolate workspaces and build outputs, share locked caches, and retain diagnostic reports. Never select
emulation implicitly. Other native platforms, registry authorization, and publication require their own hosted evidence.

Rationale: One configured execution model serves development and CI while keeping examples useful and verification costs
proportional to their purpose.

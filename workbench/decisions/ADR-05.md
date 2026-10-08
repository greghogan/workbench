---
summary: Pinned artifacts, isolated updates, recovery.
---

# ADR-5: Workbench distribution

A consuming project pins Workbench separately from its project-owned records. The distribution contains runnable
artifacts and required runtime dependencies; setup does not build or download the application. Distribution checks
verify that artifacts match source and locked build dependencies.

Distribute compact runnable artifacts without development source maps. Coverage measures an isolated build before
minification; development dependencies and temporary instrumentation stay outside the runnable distribution.

Projects select artifact compression with a compact default. Runnable artifacts use runtime-provided decompression
without external tools, downloads, or persistent expanded copies.

Updates resolve an exact dependency revision and use its executable to migrate every registered scope, including
retained historical records. Migrations, canonical formatting, derived context, and validation are prepared in an
isolated checkout before applying a reviewable dependency and project change. Unsupported migrations or missing
information fail without inventing record content. Application failures restore the previous state or retain explicit
recovery evidence.

Updates require a clean committed checkout and do not stage or commit their result. Changed ADRs and experiments retain
their human-review requirements. The update report identifies changed agent context so inherited instructions can be
reviewed alongside the dependency.

Rationale: A pinned, ready-to-run dependency makes bootstrap reproducible and lets projects adopt shared improvements at
their own pace without requiring Workbench's development toolchain.

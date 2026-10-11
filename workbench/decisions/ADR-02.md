---
summary: Consumer ownership, submodules or shared installations, project pins, retained versions, updates, and recovery.
---

# ADR-2: Workbench adoption and distribution

Apply ADR-1. A consuming project pins Workbench as a separate dependency and executes its tools and shared adapters from
that distribution. Shared decisions and selected definitions remain at their pinned source; do not duplicate them into
project-owned records merely to make them available. The project owns its charter, local decisions, other records, root
registrations, and configuration. Workbench's own repository settings are not consumer defaults.

Support a project Git submodule or a shared user/system installation. Shared installations retain immutable versions
side by side; each project tracks an exact portable revision and content identity independently of its machine location.
Installing a new version does not update projects. Resolve the project pin consistently for executables, policy,
definitions, skills, and adapters; missing versions fail without silently selecting another version.

Shared installations use owner-controlled project profiles as retention roots. Updates record the new selection before
releasing the old one. Retained rollback generations and active uses also keep versions reachable. Pruning removes only
unreferenced versions under coordinated ownership; inaccessible projects and uncertain recovery do not release roots.
System pruning accounts for every user's roots. Inspection reports retention reasons without changing selections.

Adoption preserves existing source, human-written intent, agent guidance, hooks, skills, and tool selections. Configure
actual project boundaries and commands, resolve conflicts explicitly, and generate context from the applicable shared
and local sources. Missing human-written charters remain missing until supplied by a human. Setup does not establish a
successful quality gate without configured commands or an explicit structural-only choice.

Executable references may supply starter source, native tool configuration, environment definitions, Makefiles, and
workflows. Copied files become project-owned and receive no implicit updates; their explicit references to shared
implementations still follow the distribution pin. Reusable language definitions use their declared inheritance mode.
Keep procedural adoption instructions in user documentation and skills.

The distribution contains runnable artifacts and required runtime dependencies; setup does not build or download the
application. Distribution checks verify that artifacts match source and locked build dependencies.

Source, tests, and executable examples may accompany installed revisions as reference material without becoming runtime
prerequisites. Their presence does not change consumer ownership or inheritance.

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

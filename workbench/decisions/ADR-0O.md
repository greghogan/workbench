---
summary:
  Optional LTO and profile-guided optimization, compatible tools, representative training, and verified artifacts.
---

# ADR-O: Build optimization

Projects explicitly select disabled, full, or thin LTO where supported. Keep development, coverage, sanitizer, and
optimized builds independently selectable, with distinct identities and dependency ABI tracking. LTO preserves the CPU
requirements declared under ADR-M; speedup claims require ADR-8 evidence.

Use compatible compilers, linkers, archive tools, runtimes, and bitcode dependencies, including across languages.
Preserve required tools when filtering installations. Reject unsupported requested modes. Keep compiler-specific flags
and recipes in the reference configuration.

Verify LTO by linking and executing the optimized program, including calls across translation units and static
libraries. Run behavioral tests and standalone release checks across the configured compilers and platforms.

Profile-guided optimization is optional and explicitly selected. Identify the training workload and profile provenance,
define compatible reuse and refresh, and surface missing or incompatible requested profiles. Training represents
intended use; verify optimized behavior on independent inputs and preserve declared portability and numerical contracts.
Instrumented training, ordinary checks, and optimized release artifacts remain independently identifiable. Profiles and
matching compiler tools are build inputs governed by the same acquisition and ownership rules as other inputs.

Evaluate optimization claims against representative workloads under ADR-8, including material costs and regressions.
Example workflows establish reproducible mechanics and behavior without promising a speedup for consuming projects.

Rationale: Explicit optimization inputs and compatible tools preserve assessable builds. Independent execution verifies
behavior; representative evidence determines whether an optimization is worth retaining.

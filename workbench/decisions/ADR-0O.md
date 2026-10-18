---
summary: Optional release LTO, compiler/linker coherence, isolated builds, optimized behavioral verification.
---

# ADR-O: Link-time optimization

Projects explicitly select disabled, full, or thin LTO where supported. Keep development, coverage, sanitizer, and
optimized builds independently selectable, with distinct identities and dependency ABI tracking. LTO preserves the CPU
requirements declared under ADR-M; speedup claims require ADR-8 evidence.

Use compatible compilers, linkers, archive tools, runtimes, and bitcode dependencies, including across languages.
Preserve required tools when filtering installations. Reject unsupported requested modes. Keep compiler-specific flags
and recipes in the reference configuration.

Verify LTO by linking and executing the optimized program, including calls across translation units and static
libraries. Run behavioral tests and standalone release checks across the configured compilers and platforms.

Rationale: Explicit LTO selection and compatible tools preserve reproducible builds; executing optimized artifacts
verifies their behavior.

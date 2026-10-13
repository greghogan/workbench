---
summary: Maintained Ruby baselines, checksummed Bundler locks, strict analysis, coverage, and portable gems.
---

# ADR-19: Ruby implementation

Apply ADR-9. Use the newest suitable stable CRuby for development and the latest patch of the oldest maintained release
line as the application baseline. Declare support in the project's gem specification, configure RuboCop for that syntax
baseline, and select compatibility profiles for the project's promised runtime boundaries. Projects may raise their
minimum. Managed environments own their Ruby versions; do not substitute native tooling for a managed runtime.

Use project-owned Bundler manifests and frozen locks with gem checksums. RubyGems and Bundler own package installation
and dependency selection, including the verified locked bootstrap. Acquisition follows ADR-O. Isolate runtime-specific
gems, native extensions, and bootstrap installations in external caches.

Use broad RuboCop rules, explicit RBS signatures with strict Steep diagnostics, behavioral tests, and line and branch
coverage. Syntax targeting and type signatures do not establish complete compatibility with an older standard library;
the declared runtime matrix verifies that boundary. Language servers come from the root's locked tools.

Build portable gems with a declared Ruby requirement and verify library and executable behavior after installation
outside the checkout. The reference does not require optional JIT compilers. Native source builds use the host SDK;
Windows uses signed RubyInstaller archives and its compatible toolchain for native extensions. Keep platform acquisition
recipes in reference documentation.

Rationale: Ruby's native package tools preserve its ecosystem conventions, while explicit support boundaries and
behavioral verification distinguish development preferences from the application's compatibility promise.

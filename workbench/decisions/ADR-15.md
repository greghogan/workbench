---
summary: Gem-declared support, frozen checksummed dependencies, strict Ruby analysis, and portable gems.
---

# ADR-15: Ruby

Use CRuby for native development. Declare application support in the gem specification and align RuboCop syntax
targeting with it.

Use project-owned Bundler manifests and frozen locks with gem checksums. Runtime-specific gems and native extensions
must match the selected Ruby ABI.

Use broad RuboCop analysis, explicit RBS signatures, strict Steep diagnostics, and line/branch coverage. Build portable
gems with declared Ruby requirements. Verify installed library and executable behavior under ADR-S.

Rationale: Ecosystem-native dependency ownership and explicit type and runtime evidence retain Ruby conventions without
confusing development preferences with application support.

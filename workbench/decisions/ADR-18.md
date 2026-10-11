---
summary: Checked JavaScript, JSDoc types, Node support, source-preserving builds, and independent examples.
---

# ADR-18: JavaScript implementation

Apply ADR-9 and ADR-13's Node runtime, package-manager, and dependency ownership policies. JavaScript has its own
complete language definition and executable reference. Reuse Node acquisition and compatibility machinery; do not infer
JavaScript project coverage from TypeScript source tests.

Use strict static checking of JavaScript with JSDoc and `allowJs`/`checkJs`, alongside type-aware linting, canonical
formatting, and behavioral tests. Keep JavaScript source executable without a transpilation step. Build and release
commands may prepare distributable packages without changing the language or requiring TypeScript source.

Keep the supported Node runtime range, JavaScript syntax, and runtime API declarations aligned with the project
baseline. Projects can replace the complete definition or adopt an equivalent toolchain. Browser and framework
applications add their own platform and build requirements.

Rationale: A distinct reference verifies JavaScript authoring, checking, and packaging while retaining the shared Node
support contract.

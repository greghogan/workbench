---
summary: Maintained PHP baselines, verified Composer distributions, strict analysis and portable packages.
---

# ADR-1A: PHP implementation

Apply ADR-9. Develop with the newest suitable stable PHP while declaring the latest patch of the oldest maintained
release line as the application minimum. Keep Composer's platform setting and PHPStan's syntax and API target aligned
with that minimum. Verify every supported maintained release line at runtime. Managed environments own their PHP
versions. Projects may raise their minimum.

Keep application and tool dependencies in separate Composer manifests and locks when runtime requirements differ,
including a compatible locked test runner for older runtimes. Composer owns resolution, downloads, and extraction.
Enforce reviewed SHA-256 values before extracting distributions, including cached archives; reject unverified source
fallbacks. Only explicit dependency updates record hashes. Verification plugins are trusted project source. Keep
installations and downloads outside the checkout; bootstrap and runtime acquisition follow ADR-O.

Use strict types, broad formatting and lint rules, maximum-level PHPStan analysis, behavioral and CLI tests, and line,
branch and function coverage through Xdebug. Report coverage changes and enforce recorded floors under ADR-U. Runtime
compatibility tests complement static baseline targeting. Build portable application packages without development tools
and verify their library and executable behavior outside the source checkout.

Use signed sources for native Unix CLI builds and official native ZIPs for Windows x64. Record upstream proof
availability in acquisition metadata. Native source builds require the host SDK; extension caches belong to the selected
PHP executable and ABI. Keep acquisition recipes in reference documentation.

Rationale: Composer remains the ecosystem owner while explicit distribution verification and separate tool requirements
preserve both reproducibility and an application support boundary independent of current analysis tools.

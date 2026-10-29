---
summary:
  Independent application and tool locks, verified Composer distributions, strict analysis, and portable packages.
---

# ADR-16: PHP

Align Composer's platform setting and PHPStan syntax/API targets with the declared application minimum.

Separate application and tool Composer manifests and locks when runtime requirements differ. Enforce reviewed SHA-256
values before extracting distributions, including cached archives; reject unverified source fallbacks. Only explicit
updates record replacement hashes. Native extensions must match the selected PHP ABI.

Use strict types, maximum-level PHPStan, and Xdebug line, branch, and function coverage. Package applications without
development tools. Verify library and executable behavior under ADR-S.

Rationale: Composer retains ecosystem ownership while separate tool requirements and verified distributions preserve
application compatibility independently of current analysis tools.

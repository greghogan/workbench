---
summary: Verified acquisition, upgrades, credentials.
---

# ADR-K: Dependencies, credentials, and supply-chain evidence

Dependency locking follows ADR-9. Verify dependency and executable artifacts against a recorded digest and verify
available upstream signatures or attestations against declared signer identities and trust roots. Record unavailable
authentication mechanisms explicitly; a failed verification never permits an automatic digest-only fallback. Review
upgrade compatibility and provenance; isolate disruptive upgrades when practical.

Verify artifacts before execution or activation using a trusted verifier. Keep HTTPS acquisition on HTTPS through
redirects; extraction must contain paths and links within its destination. Runtime trust boundaries follow ADR-J.

Configure relevant dependency, advisory, license, and secret checks as project roles. Use each provider's runtime
credential lookup; keep credentials out of tracked files and logs.

Rationale: Recorded dependency identities support reproducibility and verification; runtime credentials avoid durable
exposure.

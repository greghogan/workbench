---
summary: Verified acquisition, upgrades, credentials.
---

# ADR-Q: Dependencies, credentials, and supply-chain evidence

Dependency locking follows ADR-B. Verify dependency and executable artifacts against a recorded digest or signature.
Review upgrade compatibility and provenance; isolate disruptive upgrades when practical.

Verify artifacts before execution or activation using a trusted verifier. Keep HTTPS acquisition on HTTPS through
redirects; extraction must contain paths and links within its destination. Runtime trust boundaries follow ADR-13.

Configure relevant dependency, advisory, license, and secret checks as project roles. Use each provider's runtime
credential lookup; keep credentials out of tracked files and logs.

Rationale: Recorded dependency identities support reproducibility and verification; runtime credentials avoid durable
exposure.

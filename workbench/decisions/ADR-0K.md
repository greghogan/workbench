---
summary: Verified acquisition, upgrades, credentials.
agent_instruction:
  Verify acquired dependencies and executables before execution or activation; preserve required authentication and keep
  credentials out of tracked files and logs.
---

# ADR-K: Dependencies, credentials, and supply-chain evidence

Verify dependency and executable artifacts against recorded digests and available upstream signatures or attestations,
using declared signer identities, trust roots, and trusted verifiers. Explicitly record unavailable authentication;
verification failure never permits an automatic digest-only fallback. Review upgrade compatibility and provenance,
isolating disruptive upgrades when practical.

Verification precedes execution or activation. HTTPS acquisition remains HTTPS through redirects; extracted paths and
links remain contained. Runtime trust boundaries follow ADR-J; native extraction and installation follow the dedicated
acquisition decision.

Configure relevant dependency, advisory, license, and secret checks as project roles. Use provider runtime credential
lookup and keep credentials out of tracked files and logs.

Rationale: Recorded identities and authentication establish reproducibility and provenance without durable credential
exposure.

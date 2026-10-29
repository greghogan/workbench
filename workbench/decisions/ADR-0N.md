---
summary: Delegated installation, selective native archive acquisition, verified activation, and cache reuse.
---

# ADR-N: Native artifact acquisition and installation

Delegate installation, dependency resolution, integrity, and extraction to existing package and environment managers
using pinned or locked inputs under ADR-A and ADR-K. Local development and CI share installers. Direct native
acquisition preserves host SDK and system-library selection; project bootstrap definitions use ADR-2's complete
replacement mode.

For directly acquired native artifacts, stream and filter suitable archives when the storage benefit warrants it.
Language-owned rules retain usable toolsets and dependencies while keeping examples independent. Hash incoming and
retained contents during streaming; revalidate selections when sources or rules change.

Extract privately with contained filesystem effects and independent bounds on input, expansion, storage, memory, and
time. Authenticate and validate retained components before atomic activation; failure or cancellation removes owned
staging while preserving existing installations. Package definitions declare usability checks shared with environment
verification. Run probes only after authentication and check only the selected package and its dependencies.

Reuse verified installations from user-cache storage, with identities covering the artifact, platform, and acquisition
policy. Verify restored contents and metadata; retain provenance and applicable upstream proofs for offline
revalidation. Reject missing or invalid required evidence.

Rationale: Existing managers avoid duplicated installation logic. Selective native acquisition reduces storage while
preserving authentication, containment, and verified reuse.

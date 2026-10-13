---
summary: Authenticated channels and working-tree builds.
---

# ADR-S: Guix development environments

Apply ADR-Q. Committed channel revisions and a manifest define each Guix development environment. Instantiate local
shells and checks from that recorded channel history; the installed Guix supplies the bootstrap rather than selecting
the check toolchain. Retain channel authentication information alongside the revisions.

Guix development shells and checks run in a container that exposes the check root in the project checkout. Generated
project files remain in that checkout, so setup and subsequent checks can share them.

Rationale: Recorded channels and manifests preserve tool selection across machines and bootstrap installations. A
container supplies the selected tools while keeping the project's working files available.

---
summary: Locked flakes and disposable containers.
---

# ADR-S: Nix development environments

Apply ADR-R. A committed flake and its lockfile define each Nix development environment. Local development and checks
use the locked inputs and fail if evaluation requires a lockfile update.

Local development works in the checkout. Native and container execution use the same flake definition. Container
execution uses an image pinned by digest, mounts the source read-only, and runs checks in a disposable writable copy.
Discard generated project files with that copy; when external storage is selected, mount its owned build and dependency
caches separately and preserve host ownership. The Nix store may persist as a cache. Apply ADR-R's session rule;
separate disposable invocations must be self-contained.

Rationale: One locked environment definition supports both execution modes. Disposable copies isolate container writes
while a persistent store avoids rebuilding unchanged dependencies.

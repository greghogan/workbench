---
summary: Optional container workspaces, native or managed tool ownership, and CI coverage.
---

# ADR-T: Dev Container development environments

Apply ADR-Q. Dev Containers are optional Linux workspaces described by the standard specification and operated through
its CLI. Pin the environment image by digest and installation inputs deliberately. Reuse the selected profile's tool
authority, dependency declarations, and configured commands; the container supplies the OS development prerequisites.
Native profiles use native pins. Nix and Guix profiles use their pinned environments without independently installing
the same compilers through container features. A pinned prebuilt image or a local container build may provide the
workspace; the host need not have the selected managed builder installed.

Local development retains changes in the working checkout. CI selects container coverage independently and shares one
container session across its selected roots. Native macOS and Windows checks remain separate compatibility evidence.
Opening an existing container does not authorize changing pins or rebuilding it destructively. Resource scheduling
follows applicable installed policies, including container creation and dependency preparation.

Dev Container configuration copied from a reference becomes project-owned under ADR-1. Shared language definitions are
selected independently; copying the workspace definition does not copy or merge those definitions.

Rationale: A reusable workspace makes native prerequisites repeatable while keeping container tooling optional and
avoiding another language-version authority.

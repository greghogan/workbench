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

Projects may opt into project-wide prepared profiles. Images retain their builder's toolchains and locked dependency
inputs. Accept offline capability only after a fresh source build and execution with networking disabled and without
host caches. Select images by a hash of the builder, native architecture, preparation recipe, OS repository snapshot,
and locked inputs. Pull the project's matching registry image before building when absent; authentication or transport
failures are not evidence of absence. Native profiles may instead use verified host installations and caches.

Keep a project-owned JSON catalog of preparation inputs and verified image identities, including publication digests and
UTC observation times. Retain history after explicit manual image deletion; do not infer supersession or prune
automatically. Images belong to the project and are selected by the checked-out configuration, without promotion.
Publication is an explicitly selected operation that verifies the registry digest and offline behavior. Implement
GitHub/GHCR first without requiring another hosting provider.

Local development retains changes in the working checkout. CI selects container coverage independently and shares one
container session across its selected roots. Native macOS and Windows checks remain separate compatibility evidence.
Opening an existing container does not authorize changing pins or rebuilding it destructively. Resource scheduling
follows applicable installed policies, including container creation and dependency preparation.

Dev Container configuration copied from a reference becomes project-owned under ADR-1. Shared language definitions are
selected independently; copying the workspace definition does not copy or merge those definitions.

Rationale: A reusable workspace makes native prerequisites repeatable while keeping container tooling optional and
avoiding another language-version authority.

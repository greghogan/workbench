---
summary: Standard Linux workspaces, selected tool authority, checkout preservation, and independent native evidence.
---

# ADR-T: Dev Container workspaces

Dev Containers provide optional Linux workspaces using the standard specification and CLI. Pin images by digest and
installation inputs deliberately. Run the selected environment of ADR-P with its dependencies and commands. Dev
Container Features must not install or select compilers independently of that environment.

Prepared images and offline verification follow ADR-S. Development retains edits in the checkout. CI selects coverage
independently and shares a container session across its selected roots; macOS and Windows native builds remain separate
evidence. Opening a container does not authorize pin changes or destructive rebuilds. Applicable resource scheduling
also covers container creation and dependency preparation.

Prepared images provide verified offline capability; ordinary development workspaces may retain network access.

Dev Container configurations are project-owned copies.

Rationale: Standard reusable workspaces provide OS prerequisites while keeping container tooling optional and compiler
ownership explicit.

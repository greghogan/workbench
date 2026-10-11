---
summary:
  Automatic local applicability, shared project installations, immutable revisions, provenance, and ADR integration.
---

# ADR-L: Installed shared collections

Apply ADR-1 and ADR-2. Collections distribute independently maintained shared material, initially ADRs and routing
metadata. Adding a content type requires its defining decision to specify ownership, inheritance, discovery, and review.
Installation does not adopt provider charters, other records, configuration, or executable tooling.

## Installation and applicability

Use ADR-1's integration mode in two cases:

- Local installations automatically apply to their system, user, or checkout. Installation selects an immutable revision
  without a separate activation step or changes to shared pins and generated files.
- Shared project installations supply verified contents and portable pins through the tracked project or pinned
  dependencies. Declared scopes apply to every contributor and CI without machine-specific installations.

Providers may install collections with applications or distribute them independently. Shipping an available export does
not install or adopt it. A Workbench distribution may explicitly declare shared dependencies separately from its own
repository settings.

Revisions mirror the Workbench hierarchy and remain immutable side by side in durable storage under ADR-I. Ignore local
registries and project-local installations in version control; machine-specific paths belong in local configuration.
Local upgrades select a revision while retaining older ones. Shared revisions change through reviewed pins. Missing
selected contents fail explicitly rather than silently dropping policy.

## Identity and resolution

Manifests declare identity, namespaces, immutable revision, digest, format, exported records, and dependencies. Local
registries record verified selections; shared pins also declare applicable scopes and accessible contents. Optional
local installations cannot satisfy shared dependencies or references.

Verify contents against pins under ADR-K and install complete verified revisions under ADR-G. Reject invalid content,
unsupported formats, namespace collisions, unresolved references, and cycles. Identical selections covering the same
scopes may be deduplicated; differing selections require explicit resolution. Lookup order and installation location
grant no precedence.

Preflight the resulting policy graph before changing selections; related revisions may be selected together. Rejection
preserves previous pins, though verified unused contents may remain stored. Validate available project context without
claiming compatibility with undiscovered projects affected by a system or user installation.

Discovery, inspection, context, and validation work offline. Acquisition and updates are explicit. Shared updates expose
policy changes for ADR-0 review; local updates affect only their installation scope. Local CI may freeze verified local
selections into disposable workspaces without adding shared dependencies or release contents.

## Governing decisions and context

Integrated decisions retain provider ownership, namespaces, scopes, and ADR-0's ordering and explicit overrides.
Registration order and cross-namespace numbers grant no precedence; reject reference and override cycles. Providers
explicitly select consumer policies. Collections require no consumer charter or project-record registration.

Maps, context, queries, validation, and update reports identify source, revision, namespace, scope, and local/shared
applicability. Under ADR-5, tracked context includes shared policy and directs discovery of local context. Resolve local
instructions when read without rewriting tracked files.

Keep credentials untracked and local policies out of ordinary packaging and exports. Redistributing shared private
policies requires an explicit permitted audience; installation alone grants no redistribution permission.

Rationale: Automatic local applicability lets installed tools provide instructions without changing every project.
Tracked shared installations provide reproducible standards for contributors and CI. Separating their context preserves
both local guidance and portable project policy without allowing machine settings to change shared authority.

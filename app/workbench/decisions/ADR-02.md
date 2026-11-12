---
summary: Personal project admission, recoverable cleanup, shared-cache protection, and automatic retention.
---

# ADR-2: Project registration and owned caches

Storage ownership and cleanup follow workbench:ADR-I.

Consuming checkouts require explicit personal registration before project operations are available. Discover configured
projects during use and offer registration before continuing an interactive project operation. Remember registration
approval and decline separately; a declined project receives a concise manual-registration reminder without repeated
prompts. Noninteractive execution requires explicit registration. Help and project and cache management remain
available. Registration neither adopts policy nor approves records.

Removing registration requires reviewed, verified cleanup of the project's eligible owned caches first; failed cleanup
preserves registration. Project files and shared assets still needed elsewhere are preserved.

Build products and dependencies default to ignored project directories. User preferences may select external cache
storage, overridden by ignored checkout preferences; tracked configuration cannot select machine storage. Checks,
shells, and package-manager entry points apply the same selection before dependency installation, without overriding
storage controlled by an active managed environment or silently falling back.

Ordinary project-cache cleanup removes generated products, including prepared release artifacts, while preserving
dependency installations. Deep project-cache cleanup may also remove those installations. Both preserve shared downloads
and tools, which are pruned separately.

Inspection may reuse cached size estimates; pruning uses a fresh, revalidated selection.

Interrupted installations and cleanup remain inspectable and recoverable. Resolve pending operations affecting a cache
before installing into or reusing it, preserving active work and newer replacements. Inspection identifies uncertain
ownership; deleting that data requires human confirmation of a current selection. CLI and browser maintenance apply the
same recovery and protection rules.

Shared-tool pruning preserves installations required by registered projects, active commands, retained results, or
explicit retention choices. Requirements include toolchains needed for compatibility testing. Unavailable or stale
project requirements cannot establish that an installation is unused.

Automatic pruning of owned local cache assets is a personal preference enabled by default. Superseded assets become
eligible after verified replacements have succeeded in applicable checks and all consumers have released their
requirements. Retire obsolete regenerable cache generations according to retention choices without deleting project
records, experiment evidence, or retained logs. Failed maintenance reports its outcome independently of the completed
checks.

Rationale: Personal registration makes discovery deliberate. Verified ownership and conservative retention allow useful
reclamation without treating missing information as permission to delete.

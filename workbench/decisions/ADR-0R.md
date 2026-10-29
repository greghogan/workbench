---
summary: Authenticated channels, package-derived development manifests, compiler variants, and working-tree builds.
---

# ADR-R: Guix development environments

Committed channel revisions, authentication information, and package-derived manifests define Guix environments under
ADR-P. Instantiate shells and checks from that history; the installed Guix bootstraps rather than selects the toolchain.
The project-root channel pin is the default; a subproject’s channel declaration replaces it completely. Each subproject
owns its package definition and manifests. Release manifests select the package and runtime dependencies.

Resolve optional compiler selections within the pinned channel. Selected compilers, runtimes, and development tools,
including debuggers, have coherent dependencies established from package and output identities rather than version
strings alone.

Guix shells and checks use Guix's own shell-container isolation. Prepared container profiles instead use their enclosing
workspace container. Both expose the working checkout; generated project files remain there so setup and subsequent
checks share them.

Rationale: Authenticated history preserves tool selection across machines; coherent variants support compiler choices
while retaining one package authority and usable working-tree builds.

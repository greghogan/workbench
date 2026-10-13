---
summary: Linux/macOS/Windows paths, precedence, CLI contracts.
---

# ADR-I: Configuration, filesystem locations, and commands

Separate configuration, durable data, restart-persistent state, disposable cache, and session files. Follow native
platform conventions: XDG on Linux, application-support/cache/log locations on macOS, and Known Folders on Windows.
Resolve platform locations without assuming profile layouts; respect sandbox containers and use native APIs for
preferences and packaged-application storage. Roaming storage and XDG on non-Linux platforms require explicit choices.
Use protected platform facilities for temporary files and IPC. Cache deletion must preserve user work; user documents
remain in user-selected locations. Document exact locations, defaults, and platform requirements in the tooling guide.

Apply ADR-1. Project settings and root registrations are project-owned; the Workbench repository's settings are not
inherited. Language definitions follow ADR-9's replacement mode. Copied starters become project-owned. Declare ownership
and override order, report selected sources, and reject unknown keys except declared extensions. Loading and editing
validate identically before activation. Never relocate existing data implicitly.

Build products and dependencies default to ignored project directories. User-global preferences may move both to cache
or an explicit external root; ignored checkout preferences override those defaults. Tracked configuration cannot select
machine storage. Isolate checkouts, language roots, toolchains/environments, and incompatible build modes. Checks and
shells share native tool controls. Cleanup preserves dependencies unless deep cleanup is selected, and always preserves
shared downloads and tools. Release artifacts and CI reports retain documented project paths.

Package-manager entry points apply storage preferences before installation and preserve the active environment's paths.
Invalid integration fails without silently switching storage. Copied starters remain usable independently.

Provide validated configuration get/set/unset commands and a table of setting scopes. Reads resolve local overrides
unless a scope is explicit; writes default to the option's owning scope. Keep automation declarations separate. Generate
shell completion from the CLI schema. Help, inspection, and completion require no initialization or external services
and do not execute work or create durable state.

Automation offers structured output, stderr diagnostics, and meaningful exit status. Asynchronous commands distinguish
submission from completion. Keep command recipes in user documentation.

Rationale: Predictable locations and command contracts make tools composable and keep configuration, user work, and
disposable files distinct.

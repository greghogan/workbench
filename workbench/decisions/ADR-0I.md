---
summary: Storage classes, native platform locations, configuration ownership and precedence, and CLI contracts.
---

# ADR-I: Configuration, filesystem locations, and commands

Storage and command principles apply to project-owned tools. Workbench-specific locations, configuration, and cleanup
behavior below govern Workbench and its integration; they do not prescribe a consuming application's implementation.

Separate configuration, durable data, restart-persistent state, disposable cache, and session files. Collection
submodule paths are tracked dependency metadata; `.workbench/` is not a globally ignored state directory. Use Git
metadata for checkout locks and staged-change review receipts, user caches for reusable downloads, and temporary
directories for disposable staging. Follow native platform conventions: XDG on Linux, application-support/cache/log
locations on macOS, and Known Folders on Windows. Resolve locations through platform facilities without assumed profile
layouts, respecting sandboxes and packaged-app storage. Roaming storage and XDG outside Linux require explicit choices.
Use protected temporary and IPC facilities; cache deletion preserves user work, and documents remain user-selected. Keep
exact locations in the tooling guide.

Project settings and root registrations are project-owned; Workbench's settings are not inherited. Declare ownership and
override order, expose selected sources, reject unknown keys except extensions, and validate reads and edits identically
before activation. Never relocate existing data implicitly.

Local CPU and concurrency budgets are user preferences, with Git-ignored checkout overrides. CI supplies its allocation
explicitly.

Build products and dependencies default to ignored project directories. User preferences may select external cache
storage, overridden by ignored checkout preferences; tracked configuration cannot select machine storage. Isolate
checkouts, roots, toolchains/environments, and incompatible build modes. Checks and shells share storage controls, and
package-manager entry points apply them before installation without changing active managed paths or silently falling
back. Copied starters remain independently usable.

Direnv integration is optional and preserves existing shell customizations.

Ordinary cleanup removes generated products, including prepared release artifacts, while preserving dependency
installations. Deep cleanup may also remove those installations. Both preserve shared downloads and tools. CI reports
retain documented project paths.

Shared-tool pruning preserves installations needed by active commands or retained cached results. Project configuration
alone does not retain installations. Uncertain ownership or active use prevents deletion.

Provide validated configuration inspection and editing with explicit scopes and precedence; keep automation declarations
separate. Generate completion from the CLI schema. Once the selected executable is acquired, help, inspection, and
completion require no project initialization or external services and do not change durable state. Automation provides
structured output, stderr diagnostics, and meaningful exit status; asynchronous commands distinguish submission from
completion. Display byte quantities using decimal SI units. Document settings and recipes in guides.

Rationale: Predictable locations, ownership, and command contracts make tools composable while separating user work from
disposable files.

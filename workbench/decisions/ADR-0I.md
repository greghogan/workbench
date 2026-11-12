---
summary: Storage classes, native platform locations, configuration ownership, and safe cleanup.
---

# ADR-I: Configuration and filesystem ownership

Separate configuration, durable data, restart-persistent state, disposable cache, and session files. Follow native
platform conventions: XDG on Linux, application-support/cache/log locations on macOS, and Known Folders on Windows.
Resolve locations through platform facilities without assumed profile layouts, respecting sandboxes and packaged-app
storage. Roaming storage and XDG outside Linux require explicit choices. Use protected temporary and IPC facilities;
cache deletion preserves durable data, restart-persistent state, and active work. Documents remain user-selected. Keep
exact locations in tooling guides.

Declare configuration ownership and override order, expose selected sources, reject unknown keys except extensions, and
validate reads and edits identically before activation. Never relocate existing data implicitly.

For development integrations, keep machine resource and storage preferences separate from tracked project policy. CI
supplies its allocation explicitly. Builds must reuse only compatible generated state and must not overwrite or remove
state needed by other builds.

Cleanup distinguishes generated products from dependency installations and shared downloads. Verify ownership and active
references immediately before deletion. Automatic cleanup preserves uncertain ownership or use. Explicit deletion of
inspected uncertain cache data requires human confirmation and preserves known active work. Retained records, evidence,
and logs follow their own retention contracts.

Rationale: Predictable locations and explicit ownership separate portable project choices, personal preferences, and
user work from disposable files.

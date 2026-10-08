---
summary: Linux/macOS/Windows paths, precedence, CLI contracts.
---

# ADR-12: Configuration, filesystem locations, and commands

Separate configuration, durable application data, restart-persistent local state, disposable cache, and session files.
Use application-specific directories under the platform's native locations:

- Linux: follow the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/):
  `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` (including logs), `XDG_CACHE_HOME`, and `XDG_RUNTIME_DIR`. Honor
  its defaults, absolute-path rules, lookup precedence, and runtime-directory protections.
- macOS: use `Library/Application Support` for file-based configuration, durable data, and local state; `Library/Caches`
  for cache and `Library/Logs` for logs. Use the preferences API for native preferences, rather than writing arbitrary
  files into `Library/Preferences`. Resolve the user's locations through platform APIs or a library that respects
  sandbox containers. See Apple's
  [Library directory guidance](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html).
- Windows: resolve [Known Folders](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid); default to
  `LocalAppData` for configuration, durable data, local state, logs, and a separate disposable cache directory. Use
  `RoamingAppData` only for settings or data deliberately designed to roam. Packaged applications use the corresponding
  application-storage APIs. Do not construct locations from a drive letter or assumed profile layout.

On macOS and Windows, use platform temporary-directory and IPC facilities with user-restricted access; temporary storage
is not a substitute for persistent state. XDG is not the default on these platforms. A project may offer it as an
explicit portable mode. Cache or temporary-file deletion must not lose user work; user documents remain in user-selected
locations, separate from application-managed storage.

Keep project-owned files in the project. Explicit user-selected roots and system-service locations are documented
separately; never relocate existing data implicitly. Declare configuration ownership and override order. Reject unknown
keys unless the schema permits extensions; load and edit use the same validation before activation.

Default build products and dependency installations to gitignored project directories. A user-global opt-in moves both
to platform cache or an explicit external root. Ignored checkout-local preferences may override global defaults; tracked
project configuration cannot specify machine storage. Separate checkouts, language roots, environments/toolchains, and
incompatible build modes. Checks and development shells use the same native tool controls. Normal cleanup preserves
dependencies; deep cleanup also removes the selected root's installations. Preserve shared download caches and tools.
Keep explicit release artifacts and CI reports at documented project paths.

Provide validated configuration get/set/unset commands and a table distinguishing global, project, and ignored local
settings. Reads resolve applicable local overrides unless an explicit scope is selected; writes target the option's
owning scope by default. Keep agent-managed automation separate. Generate shell completion from the CLI schema;
inspection and completion must not initialize projects or execute work.

Help is available without initialization or external services. Inspection does not initialize durable state. Automation
uses structured output with diagnostics on stderr and meaningful exit status; asynchronous commands distinguish
submission from completion. Keep commands and path defaults in user documentation.

Rationale: Predictable locations and command contracts make tools composable and keep configuration, user work, and
disposable files distinct.

# Share collections of decisions

[Workbench overview](../../README.md). Commands assume your project root; `workbench` denotes the executable in your
pinned distribution.

## Shared collections

Collections export independently maintained ADRs and decision maps, mirroring the Workbench hierarchy. They retain
namespaces such as `benchd:ADR-0` and `company:ADR-2`. Both installation cases use integration: applicable decisions
coexist, and conflicts require explicit scoped overrides.

| Installation   | Applies to                                       | Shared through Git |
| -------------- | ------------------------------------------------ | ------------------ |
| System         | Users of that system                             | No                 |
| User           | That user's Workbench projects                   | No                 |
| Project-local  | That checkout                                    | No                 |
| Shared project | Every contributor and CI, within declared scopes | Yes                |

### Local installations

Installation makes a collection apply automatically, without a separate activation or project pin. The installer records
the selected revision in the installation's `index.toml`. An explicit upgrade selects the new revision; previous
immutable revisions remain stored. An available export directory alone does not make a collection applicable.

```sh
workbench collection install /path/to/export --sha256 RECORDED_DIGEST # User scope by default
workbench collection install /path/to/export --sha256 RECORDED_DIGEST --scope local
workbench collection install /path/to/export --sha256 RECORDED_DIGEST --scope system
workbench collection                         # Show applicable collections and local/project provenance
workbench collection --installed             # Include older stored revisions
workbench collection context                 # Read local maps and agent instructions
workbench decision show benchd:ADR-0          # Available where its collection is installed
```

On Linux, user installations use `$XDG_DATA_HOME/workbench/collections` (default
`~/.local/share/workbench/collections`); system discovery uses `workbench/collections` below `$XDG_DATA_DIRS` (default
`/usr/local/share` and `/usr/share`). macOS uses `Library/Application Support/workbench/collections` in the user's home
and `/Library/Application Support/workbench/collections` for system sources. Windows uses
`LocalAppData/workbench/data/collections` and `ProgramData/workbench/collections`. Platform lookup follows Workbench's
location controls. These are durable installed data, independent of build/download caches.

`--scope local` installs into ignored `workbench/.local-collections/`. `--scope system` uses the first applicable system
location and never elevates privileges. For user or system installations, `--directory DIRECTORY` selects another base;
register a nonstandard base with
`workbench config set collections.directories '["/absolute/collections"]' --scope global` or `--scope local`. Machine
paths and local selection registries stay outside tracked project configuration.

Tracked `AGENTS.md` directs agents to run `workbench collection context` before acting. This reads current local maps
and instructions without rewriting shared context or maps. Local policy text is excluded from ordinary packaging and
exports, including when it is public. Local CI freezes verified local selections into ignored disposable workspace files
for container access; treat those workspaces and reports as private when they contain private standards.

Workbench includes the available benchd export under `collections/benchd/1`, but does not require it for consumers.
Installing benchd's collection makes its scheduling instructions apply locally; benchd's future application installer
can perform the same installation. Workbench's shared decisions remain usable without that optional collection.

### Shared project installations

Install with `--scope project` to copy verified contents into tracked `collections/` and record a pin in
`workbench/config.toml`:

```sh
workbench collection install /path/to/export --sha256 RECORDED_DIGEST --scope project
workbench sync
workbench validate
```

The resulting declaration has this form:

```toml
[[collections.sources]]
id = "company"
revision = "2026-10"
sha256 = "<independently recorded collection manifest SHA-256>"
visibility = "private"
scopes = ["."]
```

Scopes name registered project paths; descendants inherit the decisions. Installation defaults to the entire project;
edit `scopes` for narrower applicability. Reinstalling preserves existing scopes. Review and commit the contents, pin,
and generated shared context together. A clone contains the required policies; a host installation cannot satisfy a
missing shared project dependency. A pinned Workbench distribution may declare its own shared dependencies in
`collections/index.toml`, separately from its repository settings.

Required dependencies must also be shared, explicitly pinned, and cover their dependent's scopes. Shared ADRs cannot
reference optional local decisions. Identical local and shared selections covering the same scopes are deduplicated;
different revisions, contents, or scopes require explicit resolution. Installation and directory order grant no
precedence. Namespaces must be distinct from other collections and project IDs. Provider implementation decisions,
charters, tasks, settings, and tooling are not imported.

### Verification, updates, and exports

Inspection, search, synchronization, and validation never fetch sources. Acquire exports through authorized repository
or package tooling, verifying available signatures or attestations under the dependency policy. The installer accepts a
local directory and independently recorded manifest digest, verifies every exported file and derived map, then publishes
complete contents from private staging. It implements no downloader or alternative package manager. Missing, modified,
conflicting, or unsupported selected sources fail clearly.

Installation verifies each collection's contents, then preflights the proposed combined policy before changing the
selection. It checks dependencies, namespace conflicts, scopes, overrides, and ADR references. Rejection leaves previous
pins unchanged; verified unused contents may remain available for a corrected retry. Local registry selection is locked;
shared installation also preserves existing scopes and rejects intervening project-configuration changes.

Within a project, preflight includes its shared and local policies. Outside a project, it checks available installed
collections and Workbench policy without initializing project files. A user/system installation cannot establish
compatibility with every undiscovered project on the machine. Run `workbench validate` after changing project policy;
later edits or installations may change its combined context.

Select related dependency upgrades together when their exact pins must advance in one operation. Supply one digest per
directory in the same order; the batch targets one installation scope and selects all proposed revisions together:

```sh
workbench collection install /path/company-v2 /path/division-v2 \
  --sha256 COMPANY_DIGEST --sha256 DIVISION_DIGEST --scope project
```

Install new dependencies first or include them in the batch. Conflicting selections owned by different installation
locations require explicit resolution at those locations. No installation order grants policy precedence.

```sh
workbench collection inspect /path/to/export
workbench collection compare company /path/to/new-export --sha256 RECORDED_DIGEST
workbench collection bundle /path/to/collections # Copies shared project collections only
```

Comparison reports exact policy and dependency changes without updating files. Private comparisons require
`--include-private` and a private audience. Install a reviewed candidate at the intended scope. Shared pin changes and
their resulting instructions require human review before commit; local upgrades do not change project pins.

Providers explicitly select consumer decisions when exporting; the default audience is private:

```sh
workbench collection export /path/to/export --id company --revision 2026-10 --decision 0 --visibility private
workbench collection export /path/to/export --id company --revision 2026-10 --all --visibility public
```

The export ID matches its owning project namespace; `--project` selects a provider scope. Use a new destination. Only
selected ADRs, their derived map, and a manifest are written. Shared collection dependencies are recorded; local
installations are excluded. Public exports reject private dependencies. Use qualified dependency references; relative
links must stay within the selected records and map.

Installation does not authorize redistribution. Run `workbench collection check-export` before exporting shared policy
or context for a public audience; private exports require `--include-private`. Distribution packaging applies this
guard, copies verified shared collections, and regenerates shared context. Consumer packagers must likewise account for
their intended audience. Keep private content and credentials out of public artifacts and CI logs. Fixtures use
synthetic policies without credentials or private organizational text.

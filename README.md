# Workbench

Workbench organizes decisions, tasks, experiments, environments, citations, and releases for agentic development. This
repository develops the executable, record conventions, and reference examples together.

Consumers own their records. Adopted collections retain an upstream snapshot and an editable project version:

```text
.workbench/collections/company/   # Deinitialized source submodule; no checked-out records
workbench/
  CHARTER.md                     # Project's human-written intent
  decisions/                     # Project-originated decisions
  collections/company/           # Editable adopted decisions and their map
  decision-map.md                 # Routes readers to applicable project policies
  config.toml                    # Executable pin and collection declarations
  projects.toml                  # Record scopes and language roots
AGENTS.md                        # Committed, self-contained agent guidance
```

The executable is installed separately and runs on an installed [supported Node.js runtime](docs/installations.md). Its
release package contains prebuilt JavaScript and reference material; users do not need TypeScript or Workbench's
development dependencies. Adopted decisions state current policy directly; updates reconcile them with pinned Git
originals. Reading or editing records requires neither Workbench nor upstream access. See [adoption](docs/adoption.md),
[installation](docs/installations.md), and [collections](docs/collections.md).

| Material                                                              | Ownership and update behavior                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Adopted ADRs and supporting files                                     | Editable project-owned copies; original Git objects supply three-way reconciliation.                            |
| Project charter and other records                                     | Project-owned; provider charters and unrelated records are not adopted.                                         |
| Maps and `AGENTS.md`                                                  | Committed outputs referencing authoritative project records.                                                    |
| Skills                                                                | Personally selected, locally linked to definitions from the project's pinned executable.                        |
| Example source, environment files, Makefiles, hooks, and CI workflows | Copied starters, owned and adapted by the project.                                                              |
| Language definitions                                                  | A complete project definition replaces the executable distribution's equivalent; project additions are allowed. |
| Project settings, root registrations, and custom automation           | Project-owned; Workbench repository settings are not consumer defaults.                                         |
| Executable and shared helpers                                         | Independently pinned in configuration and acquired through npm's cache.                                         |

## Start with records

[Install the user command](docs/installations.md), then run:

```sh
workbench setup
```

A human then writes `workbench/CHARTER.md` to state the project's intent. Once the charter exists, add records and
generate the agent context:

```sh
workbench record add task "First project task"
workbench sync
```

Configure the executable pin, adopt selected collections, and review the generated context. For a records-only project,
explicitly set `checks.allow_empty = true`. Language and build-environment adoption is optional. Ordinary application
builds remain independently usable.

## Documentation

User guides live in `docs/`; project records and their maps live in `workbench/`.

| Work                                                                  | Guide                                    |
| --------------------------------------------------------------------- | ---------------------------------------- |
| Decisions, tasks, experiments, environments, citations, releases      | [Records and CLI](docs/records.md)       |
| Shared company standards and installed tool instructions              | [Collections](docs/collections.md)       |
| Local checks, coverage changes, commit gates, and review receipts     | [Checks and review](docs/checks.md)      |
| Shared definitions, complete local replacements, and starter examples | [Languages](docs/languages.md)           |
| Native tools, cache locations, and cleanup                            | [Tooling and storage](docs/tooling.md)   |
| Development profiles, containers, release preparation, completion     | [Profiles](docs/profiles.md)             |
| Changed-root selection, hosted matrices, and Linux rehearsal          | [CI](docs/ci.md)                         |
| CPU allocation and concurrency                                        | [Execution resources](docs/execution.md) |
| Building Workbench and optional harness evaluations                   | [Contributing](docs/contributing.md)     |

The [decision map](workbench/decision-map.md) routes policy reading. Draft decisions still require human review; local
verification does not establish hosted publication or platform support. Open implementation and verification work is
tracked in the [task map](workbench/task-map.md).

## Executable documentation

`workbench docs README.md` executes `console` fences containing one `$ command` followed by its expected stdout. Use
these for stable public workflows; failed commands, stderr, and output drift fail the check. Version pins and quality
limits remain in their executable configuration; prose links to those authorities. For example:

```console
$ node bin/workbench.mjs docs --help
Usage: workbench docs [options] <file>

Verify executable console examples

Options:
  --plain     Use stable plain text and line-oriented prompts
  --no-plain  Override a saved or inherited plain presentation preference
  -h, --help  display help for command
```

# Workbench

Workbench keeps agentic-development records in ordinary versioned files and provides deterministic setup, routing, and
change gates. This repository develops Workbench. A consuming repository pins it at `.workbench/` and owns separate
records in `workbench/`. The checked-in JavaScript bundle needs Node.js 22.23.3 or newer; setup does not build or
download an executable.

## Shared definitions and project-owned files

This repository develops Workbench itself. Its `workbench/` directory contains Workbench's own records and
configuration; `examples/languages/` contains the executable language references. A consuming project has this layout:

```text
my-project/
  .workbench/                # Pinned Workbench distribution, normally a Git submodule
  workbench/                # Consuming project's records and configuration
    CHARTER.md
    decisions/
    config.toml
    projects.toml
    automation.toml
  AGENTS.md                 # Generated context referencing shared and project decisions
  ...                       # Project source and conventional tool configuration
```

Consuming-project adoption is defined in [ADR-2](workbench/decisions/ADR-02.md). [ADR-1](workbench/decisions/ADR-01.md)
defines two inheritance modes: **integration**, where shared and local material remain applicable together, and
**replacement**, where a complete local definition hides the corresponding shared definition. Each material's defining
ADR selects its mode or states that it is not inherited. Copying a starter is a separate ownership mechanism.

| Material                                                                                        | Ownership and inheritance                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared Workbench ADRs                                                                           | Integration: read shared decisions alongside local ADRs; explicit scoped overrides replace affected rules.                                                      |
| Project charter and records                                                                     | Project-owned. Workbench's charter, tasks, experiments, environment records, citations, and release records do not become project records.                      |
| Maps and `AGENTS.md`                                                                            | Generated from applicable sources, preserving links to shared and local records.                                                                                |
| Skills                                                                                          | Discovery links reference the pinned Workbench sources; separately owned project skills are preserved.                                                          |
| Language configuration                                                                          | Replacement: select a complete local definition and ignore the shared equivalent, or use the pinned shared definition; local definitions can add new languages. |
| Project settings, root registrations, and custom automation                                     | Project-owned; Workbench's own repository settings are not inherited.                                                                                           |
| Example source, native tool configuration, environment definitions, Makefiles, and CI workflows | Copied and adapted when used as starters. Copies become project-owned; updates do not implicitly replace them. They can invoke shared scripts.                  |
| Runnable tools and shared adapters                                                              | Executed from the pinned distribution and updated with its revision.                                                                                            |

## Start with records

Initialize a pinned Workbench checkout in `.workbench/`, then run:

```sh
./.workbench/bin/workbench setup
./.workbench/bin/workbench task add "First project task"
./.workbench/bin/workbench sync
```

A human supplies `workbench/CHARTER.md`. Inspect generated context and configured checks before committing. For a
records-only project, explicitly set `checks.allow_empty = true`; adding a language or build environment is optional.
Setup preserves existing source and configuration. See [adoption and updates](workbench/guides/adoption.md) for scope
registration, skills, hooks, and migration. The short `workbench` commands in the guides refer to the pinned executable
above.

## Guides

| Work                                                                  | Guide                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| Decisions, tasks, experiments, environments, citations, releases      | [Records and CLI](workbench/guides/records.md)       |
| Shared company standards and installed tool instructions              | [Collections](workbench/guides/collections.md)       |
| Local checks, coverage changes, commit gates, and review receipts     | [Checks and review](workbench/guides/checks.md)      |
| Shared definitions, complete local replacements, and starter examples | [Languages](workbench/guides/languages.md)           |
| Native tools, cache locations, and cleanup                            | [Tooling and storage](workbench/guides/tooling.md)   |
| Development profiles, containers, release preparation, completion     | [Profiles](workbench/guides/profiles.md)             |
| Changed-root selection, hosted matrices, and Linux rehearsal          | [CI](workbench/guides/ci.md)                         |
| CPU allocation and concurrency                                        | [Execution resources](workbench/guides/execution.md) |
| Building Workbench and optional harness evaluations                   | [Contributing](workbench/guides/contributing.md)     |

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
  -h, --help  display help for command
```

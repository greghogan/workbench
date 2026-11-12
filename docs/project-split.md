# Collection and application scope split

The root `workbench` scope owns the reusable collection: record conventions and engineering outcomes which consuming
projects may adopt. The `workbench-app` subproject, displayed as **app**, owns the CLI, browser interface, and shared
TypeScript services. Its source is in `app/src/`, its tests in `app/test/`, and its records in `app/workbench/`.

One application package, build, test suite, and installed release serve both interfaces. Repository-level scripts,
examples, package configuration, lint/type/test orchestration, and CI remain shared infrastructure. Language check roots
remain independent of record scopes; the examples have not been registered as subprojects by this change.

```text
app/
  src/
    core/        Shared services, grouped by domain
    cli/         Commands, terminal interaction, and executable entry
    server/      HTTP, browser UI, snapshots, and background workers
  test/
    core/        Tests grouped with their service domains
    cli/         Command and terminal behavior
    server/      Browser, HTTP, and worker behavior
    integration/ Repository tooling and consuming-project rehearsals
    fixtures/    Shared isolated-project and process fixtures
  resources/     Shipped verification resources
  workbench/     Human charter and application decisions
workbench/       Reusable collection and repository registrations
scripts/         Build/check entry points and repository automation
```

Core services do not import the CLI or server. The server calls core services without importing the CLI. CLI startup
composes the interfaces; server workers dispatch without constructing the command parser. Formatting and safe diagnostic
presentation are shared utilities, while prompts and interactive selection belong to the CLI. Linting enforces the
interface dependency boundaries.

Runtime bundle names remain stable. The build maps those names to their owning source modules; source directories do not
determine the installed command interface. Source and tests share domain groupings, with `test/` matching the TypeScript
example's convention. These are internal modules within one package, not separately versioned packages.

## Decision correspondence

Existing shared ADR identities and paths are preserved. Extracted product requirements receive application-owned
identities; no accepted record is deleted or renumbered. The correspondence below records the change in policy
ownership.

| Original requirement                                                                     | Shared decision after the split                                                                                          | Product decision                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Adoption autonomy, initial collection adoption, executable selection and runtime support | workbench:ADR-3 retains independent adoption and consumer ownership                                                      | workbench-app:ADR-0 retains application distribution, startup support and update contracts                               |
| Personal registration and verified removal                                               | workbench:ADR-3 retains policy ownership                                                                                 | workbench-app:ADR-2 owns project registration                                                                            |
| Skill workflow ownership, evaluation, selection and discovery                            | workbench:ADR-6 owns workflow boundaries, invocation consistency, authored-skill preservation and evaluation             | workbench-app:ADR-4 owns release definitions, personal selection, applicability and updates                              |
| Dependency-maintenance workflows                                                         | workbench:ADR-A and workbench:ADR-P retain toolchain and environment authority                                           | docs/adoption.md describes the current catalog without requiring a separate skill per language                           |
| Configuration ownership, storage, cleanup and command contracts                          | workbench:ADR-I retains generally applicable ownership and storage principles                                            | workbench-app:ADR-2 and workbench-app:ADR-1 own Workbench's registration, retention, configuration and command contracts |
| User and system installation                                                             | workbench:ADR-I and workbench:ADR-J retain storage and trust boundaries                                                  | workbench-app:ADR-0 retains installation scope and command availability                                                  |
| Workbench environment selection precedence                                               | workbench:ADR-P retains shared environment principles                                                                    | workbench-app:ADR-1 retains selection precedence                                                                         |
| Native installation continuity, terminal presentation and release records                | workbench:ADR-N, workbench:ADR-W and workbench:ADR-X retain their contracts with product-specific wording removed        | No additional product rule is introduced                                                                                 |
| Existing browser presentation and document review choices                                | workbench:ADR-1, workbench:ADR-18 and workbench:ADR-19 retain shared authority, accessibility and navigation constraints | workbench-app:ADR-5 and workbench-app:ADR-6 record the existing interface choices                                        |
| Check execution and reusable detailed results                                            | workbench:ADR-U retains complete verification and evidence requirements                                                  | workbench-app:ADR-3 owns proposed-tree execution, result reuse, gate coordination, and cancellation                      |
| Task approval and local execution coordination                                           | workbench:ADR-7 retains task meaning, authority, and relationships                                                       | workbench-app:ADR-7 owns local queues, shared human decisions, and recoverable transitions                               |

The scoped browser decisions describe current behavior, including complete workspace views, escaped server rendering,
project-owned CSS, exact presented-version review and preservation of concurrent edits.

## Boundaries

This split changes source and policy ownership while preserving runtime behavior. It does not implement the artifact
workflow, a jobserver, new daemon installation, a TUI, or the server-side directory browser. Those features require
their own approved plans.

A source relocation does not create a backward-compatibility alias. Imports, build inputs, source maps, coverage,
packaging and repository-owned callers use the application locations directly. Generic consuming projects remain free to
use their own source-directory layout.

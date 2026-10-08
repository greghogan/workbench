# Workbench

Workbench keeps agentic-development records in ordinary versioned files and provides deterministic setup, routing, and
change gates. This repository develops Workbench. A consuming repository pins it at `.workbench/` and owns separate
records in `workbench/`. The checked-in JavaScript bundle needs Node.js 22.23.3 or newer; setup does not build or download
an executable.

## Initialize a project

Run one setup command from the repository root:

```sh
# This source repository
./bin/workbench setup

# A consuming repository with its Workbench dependency initialized
./.workbench/bin/workbench setup
```

Setup asks for a new project ID when needed, writes project configuration, and configures Git change gates. It leaves
existing records intact. The pinned `.workbench/` source contains the runnable bundle.

`workbench setup --id NAME` chooses an explicit root project ID; subsequent setup preserves it. `workbench project`
lists registered scopes (`--json` provides structured output). Project setup creates `workbench/config.toml`,
`workbench/projects.toml`, and all record maps. It never writes a charter or placeholder `AGENTS.md`. Checks cannot pass
until each registered project has a human-written `workbench/CHARTER.md`. Afterward, `workbench sync` derives the root
`AGENTS.md` from project charters and selected ADR instructions, including drafts. Existing hand-written agent guidance
is preserved and must be moved before sync can take ownership.

Setup configures Workbench's tracked Git hooks when doing so will not overwrite another hook path. These are ordinary
Workbench-owned `pre-commit` and `commit-msg` hooks; the project does not use the third-party `pre-commit` framework.
The Git adapter also adds the local citation-library pattern to `.git/info/exclude` without changing `.gitignore`.

## Update a consuming project

Use a clean, committed checkout with an initialized `.workbench` Git submodule:

```sh
workbench update main          # Adopt a branch, tag, or commit from the dependency's origin
workbench update               # Use update.revision from the root configuration
```

An optional configuration supplies the default target and remote:

```toml
[update]
remote = "origin"
revision = "main"
```

The command fetches an exact commit, prepares a temporary checkout, and runs the new revision's preparation and
validation. Preparation includes every registered scope and all retained records, canonical formatting, maps, agent
context, and skill links. The root `workbench/config.toml` records one workspace `schema_version`; individual records,
the project registry, and record counters do not carry separate versions. Normal commands require the current schema.
Future schema changes require explicit migrations; this unreleased version has no legacy formats to migrate. Existing
check commands are preserved; splitting a combined test/coverage command requires an explicit project change.

Only a successfully validated result is applied. Preparation failures leave checked-out files unchanged; Git's fetch
metadata may advance. Application failures attempt rollback and retain the preparation directory and patch if recovery
needs attention. A lock in the repository's Git directory prevents overlapping updates; after an interrupted process,
inspect its `recovery` file before removing the lock. Commit or remove untracked files before updating. Preparation uses
committed files rather than ignored caches, and requires initialized submodules and symlinks contained within their
checkout.

The result is an unstaged working-tree diff containing the dependency pin and migrated project files. Review them
together; changed ADRs and experiments require human review before commit. The report shows changed agent context,
including inherited instructions. The command does not run configured builds or tests; run `workbench checks run` before
committing. It updates consuming submodules; vendored distributions and Workbench's own source checkout use their normal
source-management workflow.

## Projects and agent context

Register a subproject interactively with `workbench project add`, or noninteractively with:

```sh
workbench project add PROJECT_ID RELATIVE_PATH
```

The command creates its `workbench/` directory and maps but no charter or recursive `AGENTS.md`. One root `AGENTS.md`
embeds every registered project's charter and groups extracted ADR instructions by their applicable directory. The root
and subprojects use the same layout, each with a decision-map link. Shared Workbench instructions apply throughout the
repository; subproject instructions apply only within that directory and its descendants. Instructions stay inline and
link to their source ADRs. Agents read shared and root maps, then narrower maps relevant to their work.

`[[language_root]]` entries in `workbench/projects.toml` select a language and its relative check root independently of
record scopes. Select a workspace root when its build tool covers members; select independent roots when it does not.
Setup detects conventional manifests such as `tsconfig.json`, `Cargo.toml`, and `pyproject.toml`.
`workbench language roots` reports configured roots and detected manifests. For an empty TypeScript root,
`workbench language init typescript [PATH]` seeds the locked starter without overwriting existing files; projects may
then adapt it. Checks run project-configured commands, not a permanent comparison with starter defaults.

`workbench language` shows supported languages and their executable reference projects under `examples/languages/`;
`workbench language check --all` verifies them. References carry the language's conventional configuration and checks
without pretending to be complete application templates. Their optional Guix and Nix files independently pin the tools
provided by each package set. Guix uses `channels.scm` with `manifest.scm`; Nix uses `flake.nix` with `flake.lock`.
Workbench never enters either environment automatically.

The environment decisions read in order from the [shared policy](workbench/decisions/ADR-0R.md) to
[Nix](workbench/decisions/ADR-0S.md) and [Guix](workbench/decisions/ADR-0T.md). Read the shared policy and the decision
for the environment being used.

`workbench sync` exposes shared workflow skills and the union needed by registered language roots at the repository
root. Guix and Nix update skills appear when local checks or CI coverage select that environment. Each skill checks its
requested scope. Discovery links point to canonical sources in the pinned Workbench module; sync removes obsolete
Workbench links and preserves user-owned skills. Namespaced workflow names avoid collisions with personal skills. No
global installation or agent-executable detection is required. Update skills do not change environment pins without a
human request.

Commit the generated discovery links with the other derived files. If a global Git ignore rule hides an agent directory,
explicitly force-add the Workbench-owned links there; leave unrelated personal agent configuration out of the commit.

| Harness     | Project instructions                        | Skill discovery        |
| ----------- | ------------------------------------------- | ---------------------- |
| Codex       | Root `AGENTS.md`                            | Root `.agents/skills/` |
| Claude Code | Root `AGENTS.md` through its native support | Root `.claude/skills/` |

These are the supported adapters. Use recent harnesses with native instruction discovery enabled. Workbench does not
create `CLAUDE.md` or change user settings. Claude's instruction settings or existing Claude instruction files can
affect native `AGENTS.md` loading; see its [memory documentation](https://code.claude.com/docs/en/memory). Other
harnesses may recognize the shared format or directories, but that alone does not establish tested support.

| Skill                                                                                                                                                              | Selection                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `workbench-review`                                                                                                                                                 | After implementation or when reviewing pending changes; fixes in-scope issues       |
| `workbench-refactors`                                                                                                                                              | Requested advice or a second look; advisory unless implementation is also requested |
| `workbench-bug-hunt`                                                                                                                                               | Requested defect investigation within the selected scope                            |
| `workbench-audit`                                                                                                                                                  | Explicit invocation only; whole-project audit with task-based continuity            |
| `workbench-experiment`                                                                                                                                             | Requested recorded comparisons; mandatory human review of EXP records               |
| `workbench-adopt`                                                                                                                                                  | Requested adoption or migration of an existing project's Workbench integration      |
| `workbench-ci`                                                                                                                                                     | Requested diagnosis and repair of failing CI checks in their actual environment     |
| `rust-dependency-refresh`, `python-dependency-refresh`, `typescript-dependency-refresh`, `c-dependency-refresh`, `cpp-dependency-refresh`, `go-dependency-refresh` | Requested updates or inspection in matching language roots                          |
| `nix-update`, `guix-update`                                                                                                                                        | Explicitly requested environment updates when that environment is configured        |

Normal skills permit implicit selection when their description matches; this is not a scheduled hook. Required review
comes from ADR-E. A skill's availability does not itself authorize edits or commits. Full audits disable implicit
invocation with Claude's `disable-model-invocation` frontmatter and Codex's `agents/openai.yaml` policy; validation
checks agreement. Invoke `workbench-audit` by name with the harness's skill syntax. Advisory refactor review can reveal
both missed cleanup and broader opportunities after changeset review; it should explain which it found.

Backward compatibility is deliberately opt-in during initial development. Setup writes `compatibility.required = false`
to `workbench/config.toml`; only a human changes that Boolean to require compatibility. When enabled, the compatibility
ADR governs externally observable interfaces, persisted formats, protocols, and user workflows.

Architecture topics such as terminal interfaces, cloud adapters, and live services remain discoverable decisions. They
do not need selectors merely to suppress a short agent instruction. An ADR receives `agent_instruction` frontmatter when
its rule must guide an agent before topic-specific reading. The maps ADR supplies the routing instruction; generated
links supply its paths. Map entries pair each ADR's title with concise topic cues from its `summary`. Generated files
introduce no independent policy.

The engineering decisions read in order from the [shared baseline](workbench/decisions/ADR-0B.md) through
[testing](workbench/decisions/ADR-0C.md), [quality gates](workbench/decisions/ADR-0D.md), and
[review](workbench/decisions/ADR-0E.md), followed by the grouped language decisions. Read the map first and open the
decisions relevant to the work. Common requirements live in the baseline; language decisions specialize them.

A replacement ADR names its targets in the YAML `overrides` array, such as `overrides: [app:ADR-0]`. Its body states the
replacement rule. Replacements apply only within their owning scope, and root context displays that scope and the
affected records. Missing targets, sibling-scope overrides, duplicate replacements, and cycles are errors. Current draft
instructions and replacements affect the workspace immediately; only a human-reviewed commit accepts them.

## Records and maps

`workbench` prints command help. Add `--help` to any command, use `workbench help task add` for a command path, or
`workbench help --all` (also `--help-all`) for the full public command tree.

Each record type has a direct command: `task` (`TSK`), `decision` (`ADR`), `experiment` (`EXP`), `environment` (`ENV`),
`citation` (`CIT`), and `release` (`REL`). Environment records describe hardware; check environments are configured
separately in `workbench/config.toml`.

```sh
workbench task                               # List open tasks across all scopes
workbench task parser                        # Search tasks for the literal text "parser"
workbench task parser --all                   # Include completed and canceled tasks
workbench task --status blocked               # Select one task status
workbench task show 0                         # Read TSK-0 in the current scope
workbench task add "Implement parser"         # Create a task in the current scope
workbench decision retry --project api        # Search one scope's decisions
workbench search parser --all                 # Search every record type, including task history
workbench sync                               # Refresh generated files after manual edits
```

Bare record commands list records; following text searches their full contents without regard to case. Multiple words
form one literal phrase. Use `task -- add` to search for an action name, or `task -- --flag` for text beginning with a
dash. Everything after `--` is literal search text; place options before it, as in `task --all -- add`. The same pattern
works for every record type. Only task browsing hides finished records by default: `--all` includes them and
`--status done` selects a specific status. Experiments also accept `--status`.

Browsing covers all registered scopes unless `--project ID` is given. Creation and short IDs select the deepest
registered scope containing the current directory, falling back to the root scope outside the project. Override that
choice with `--project ID`, or pass a scoped reference to `show`, such as `workbench task show api:TSK-0`. `show` also
accepts a type-prefixed ID such as `TSK-0`. Scoped references must agree with an explicit `--project`.

Lists, searches, and `show` support `--json`. Search results normally occupy one line per record; `--matches` includes
matching lines. Global `search` also accepts `--type task` or a record code such as `TSK`. Record files remain in the
checkout after completion or obsolescence, so references and searches work without accessing version-control history.

Use `task add`, `decision add`, or `environment add` with a quoted title. Task creation accepts a scoped `--parent`
reference and repeatable scoped `--depends-on` references. `citation draft TITLE` starts a manual bibliography entry;
prefer `citation add` when an arXiv ID or DOI is available. `experiment add TITLE --protocol PATH` creates a record from
a complete protocol; it does not execute the experiment. `release add PATH` creates a release from a specification, as
shown below.

Creation writes canonically formatted records and refreshes their maps. Supply a task body from a Markdown file or stdin
when the content is already available:

```sh
workbench task add "Improve parser" --from draft.md
cat draft.md | workbench task add "Improve parser" --from - --project api
```

The input is the body below the task title, without frontmatter. Task metadata comes from the command's options.
Omitting `--from` creates the section scaffold. Directly editing a record is equally supported; format it and
synchronize maps before validation.

### Record metadata

ADR, TSK, EXP, and ENV files begin with a YAML mapping followed by the Markdown title and body. For example:

```markdown
---
status: Planned
parent: null
depends_on: []
---

# TSK-0: Improve parser

## Context

Describe the intended outcome.
```

Prose records use the workspace schema version. Their fields are:

| Type | Required metadata                                                              | Optional metadata                                      |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| ADR  | `summary`                                                                      | `agent_instruction`, `overrides` (ADR reference array) |
| TSK  | `status`, `parent` (TSK reference or null), `depends_on` (TSK reference array) |                                                        |
| EXP  | `status`, `environment` (ENV reference or null)                                |                                                        |
| ENV  |                                                                                |                                                        |

Every prose type also permits an `extensions` mapping for project-specific metadata. Unknown top-level fields and
duplicate keys are errors. Empty relationships use `null` or `[]`; references remain scoped, such as `api:TSK-4`. Task
statuses are `Planned`, `Active`, `Blocked`, `Done`, and `Canceled`; experiment statuses are `Running`, `Accepted`,
`Rejected`, and `Inconclusive`. Summaries and agent instructions contain one logical line of text; YAML folding may wrap
their source representation across physical lines.

Experiment protocols also use frontmatter with `environment`. Creation supplies `status: Running` and the record title,
checks the six protocol sections, and adds empty evidence sections. Citation and release files retain their YAML schemas
described below.

Commit accepted experiments with their exact tested implementation; that commit identifies the candidate. For a
candidate not retained in source, link its applicable patch and baseline in the record. Do not add a self-referential
commit hash or duplicate a patch when the record's commit contains the tested candidate.

The task map includes unfinished tasks; other maps retain every record. Humans review new or changed ADRs before commit;
the commit accepts the reviewed text. Experiment review follows the experiment ADR. Staging selects files for a commit;
it neither establishes nor proves human approval. Agents may implement and test drafts during review. Generated
`AGENTS.md` needs no separate approval.

Reference scoped task IDs in relevant commit messages, for example `Task: app:TSK-4` in the body. A task's evidence may
cite existing commit hashes; no task must reference the hash of the commit that completes it.

Record filenames pad base-36 IDs to an even number of digits. Larger IDs use all preceding digit pairs as directories:
`app:ADR-0` resolves to `workbench/decisions/ADR-00.md`, and `app:ADR-100` to `workbench/decisions/01/ADR-0100.md`
within that scope. Titles retain the unpadded ID. `workbench/record-sequences.toml` reserves future IDs and must be
committed with records. Sync advances it for manually authored records; IDs are never recycled. A failed allocation may
leave a gap. An allocation lock prevents simultaneous writers; after a crashed process, remove its empty
`workbench/.record-allocation.lock` directory only after confirming no allocator is running. The Git gate rejects
deletion or relocation of committed record files; change their status or supersede them instead.

After publishing immutable artifacts, `workbench release add SPECIFICATION_PATH` computes their sizes and SHA-256
digests and creates a `REL` record. `workbench sync` derives `workbench/release-index.tsv`; setup does not use that
index to acquire the Workbench app.

The specification names local artifacts and their final published URLs; Workbench derives filenames, sizes, digests, and
the record ID:

```yaml
version: 0.1.0
revision: 0123456789abcdef0123456789abcdef01234567
tag: v0.1.0
released: 2026-09-20
notes:
  summary: First portable release.
  changes:
    - Add the checked-in Node bundle.
artifacts:
  - target: node22
    path: bundle/main.cjs
    url: https://example.org/releases/0.1.0/main.cjs
```

`workbench feedback` lists unresolved feedback, and `workbench feedback TEXT` searches it. Use `--all` to include
resolved feedback, `--json` for structured results, and `feedback show ID` to read a draft.
`workbench feedback add TITLE` creates a local uncommitted feedback draft in the user's data directory. Resolve it with
`workbench feedback resolve ID accepted|rejected EXPLANATION [--record REF]`; accepted feedback can link to a project
record when it becomes actionable.

The shared [filesystem policy](workbench/decisions/ADR-12.md) selects native locations for Linux, macOS, and Windows.
Linux uses XDG; macOS uses application-specific Library directories; Windows uses Known Folders, with local storage by
default and roaming storage only by deliberate choice. Feedback defaults to `$XDG_DATA_HOME/workbench/feedback` on
Linux, falling back to `~/.local/share/workbench/feedback` for unset, empty, or relative XDG values. On macOS it uses
`~/Library/Application Support/workbench/feedback`; on Windows it uses `%LOCALAPPDATA%/workbench/data/feedback`.
`WORKBENCH_DATA_HOME` explicitly overrides the Workbench data directory on every platform and must be absolute; feedback
then lives in its `feedback` subdirectory. Existing data is never moved automatically.

Project records stay under `workbench/`, and acquired PDFs stay in the configured project library. User tool
installations and caches follow the platform locations documented below; records remain project-owned. Only Linux
execution has been verified locally; macOS and Windows coverage is configured in CI and awaits hosted results.

Citation records are one-item CSL YAML bibliographies. Their main purpose is to retain enough metadata and source URLs
for a user to acquire papers that the project does not redistribute. Import metadata from an arXiv ID or DOI, fetch an
explicit direct source, or import a PDF obtained through a human browser flow:

```sh
workbench citation add 1706.03762
workbench citation fetch workbench:CIT-0
workbench citation fetch --all
workbench citation import workbench:CIT-1 ~/Downloads/paper.pdf --source published
```

The first command performs network access for metadata. Fetch never bypasses authentication or CAPTCHA challenges.
Downloaded PDFs use source-specific deterministic names under the ignored `library/citations/` directory. A citation may
retain both published and arXiv sources. Each source has `status: pending`, `acquired`, or `unavailable`; an acquired
source also has its SHA-256, computed on fetch or import. Mark a confirmed unavailable source explicitly; a failed
automatic download does not establish unavailability. Explicit import or fetch can acquire a previously unavailable
source. `workbench update` migrates older records, including the former all-zero digest marker. The generated citation
map indexes bibliographic records rather than local files.

## Change gates

`workbench validate` checks the registry, record schemas and relationships, canonical record formatting, generated-file
freshness, documentation links, and source coverage. It does not rewrite files. Formatting and semantic checks are
separate: an incomplete draft can be formatted even when it is not ready to pass validation.

```sh
workbench format workbench/tasks/TSK-00.md          # Print formatted Markdown
workbench format workbench/citations/CIT-00.yaml --write
workbench format --all --write                     # Format registered records
workbench format --all --project api --check       # Check one scope without writing
workbench sync                                    # Refresh derived files after edits
```

Explicit paths accept Markdown or YAML. `--all` requires `--write` or `--check` and covers only records in registered
scopes; it excludes dependency records, charters, generated files, and ordinary documentation. Batch formatting parses
all selected files before writing, so syntax errors leave the batch unchanged. Individual writes are atomic.

The formatter is bundled with Workbench and uses its pinned Markdown/YAML plugins. It normalizes layout and reflows
prose toward `[markdown].wrap_width` in `workbench/config.toml` (120 by default). The width is a target, not a hard
maximum for URLs, tables, or code. YAML values, sequence order, comments, and deliberate Markdown hard breaks are
preserved. Embedded code formatting is disabled so record evidence is not reformatted as source code. Canonical
formatting means that another pass produces identical output. Format before submitting ADRs or experiments for human
review.

`workbench sync` refreshes maps, agent context, record sequences, release indexes, and skill discovery. Generated files
are verified against their renderers, which preserve embedded human-written charters.

`workbench/config.toml` contains project choices: environment and CI selection, formatting, compatibility, commit style,
citation storage, and distribution license policy. `workbench/automation.toml` contains agent-maintained commands,
documentation wiring, and additional review protection. `workbench/projects.toml` registers document scopes and language
roots. Unknown keys are rejected; custom metadata belongs under `extensions`. Automation settings may be kept inline in
small projects, but the same section cannot be defined in both files.

Language references use compact suites in automation configuration:

```toml
[[check_suite]]
language = "rust"
path = "examples/languages/rust"
```

A suite uses the selected language's commands from the pinned Workbench distribution. `workbench checks` displays the
expanded plan. Use explicit checks when a project needs different commands; do not select both forms for the same suite.
Names describe operations and do not determine execution order. The examples are independent language roots sharing
Workbench's charter and decisions; separate document scopes are needed only for distinct intent or records.

Automation configuration binds portable roles such as `format`, `lint`, `test`, and `docs` to project-owned commands:

```toml
[[check]]
name = "web tests"
role = "test"
project = "web"
command = ["{packageManager}", "run", "test"]
stages = ["commit", "ci"]
heavy = true

[check.coverage]
command = ["{packageManager}", "run", "coverage"]
stages = ["ci"]
operating_systems = ["linux"]
environments = ["native"]
```

Omitted `stages` selects both commit and CI; `stages = []` makes an operation manual-only. A test check's optional
`coverage` table supplies an alternative command for the same suite. On matching stages, operating systems, and
environments, it replaces the ordinary command. Its defaults are CI, all supported operating systems, and native tools.
The references select Linux/native explicitly; other CI targets run ordinary tests. `coverage.stages = []` permits only
explicit coverage runs. Coverage enforces the same behavioral tests plus the existing floors, without a suite timing
cap. Configured CI coverage must match at least one matrix target. Narrowing required stages or targets requires human
review.

`workbench checks --stage ci` displays the selected plan; add `--role`, `--project`, `--path`, or `--environment` to
inspect a narrower selection. Explicit `workbench checks run --role coverage` runs coverage regardless of its automatic
schedule. Other explicit roles work likewise; supplying `--stage` additionally restricts selection. Unknown stages and
unintended empty gates fail. `{workbench}/...` in command arguments resolves relative to the selected root, including
inside disposable environments; it locates shared scripts without repeating relative paths.

`[checks].environment` in `workbench/config.toml` supplies the shared default, normally `native`. Each `[[check]]` may
set its own default. For this checkout's local builds and tests, create `workbench/local.toml`:

```toml
[checks]
environment = "nix" # native, nix, guix, or devcontainer
```

Setup and updates maintain `workbench/.gitignore` so this preference stays local. Change the value to switch tools;
remove the file to return to shared defaults. This file accepts `[checks].environment` and `[storage].external`/`root`.
Environment selection precedence is: explicit `--environment`, active Workbench shell, local override, individual check
default, shared default. A local selection applies across check roots; Guix/Nix definitions belong to each root; Dev
Containers use the workspace descriptor. Missing definitions fail. `workbench checks` shows the effective selection.

Local preferences do not change CI matrices, project commands, or generated shared context and skill links. Git's
staged-tree gate uses the working checkout's local preference with the staged commands and environment definitions.
`workbench update` preserves ignored local preferences.

Use the same selection for an interactive Bash session or a single build command:

```sh
workbench shell --path examples/languages/rust
workbench shell --path examples/languages/rust -- cargo build --locked
workbench checks run --path examples/languages/rust
workbench checks run --path examples/languages/rust --environment native
```

The shell works in the checkout and exposes `workbench`. Inside Guix/Nix shells, checks require the same root and
environment; exit before switching. A Dev Container shell supports every registered root in its workspace, selecting
each root's native pins. Shells use Bash without personal startup files to retain the selected tools. A project
environment must provide Bash and Node to run Workbench; the supplied references include these and Git. Direct language
commands outside Workbench use the current shell's tools. Opening a Workbench shell never changes the parent shell or
`.envrc`.

Environment preparation and noninteractive shell commands use benchd when installed; idle interactive sessions do not
hold a reservation. If a managed shell does not expose an installed `benchctl`, run heavy Workbench checks from the host
so the scheduler can wrap them before entering the environment.

Guix needs `channels.scm` and `manifest.scm` in the check root. Both Nix modes need `flake.nix` and `flake.lock`: `nix`
uses the host CLI, while `nix-docker` uses Docker and the pinned `checks.nix_docker_image`. The latter is an explicit
check/CI mode, rather than an interactive development selection. Docker checks use an ephemeral project copy; checks
with the same root and environment share one session, preserving setup results. Copies omit dependency and build caches;
the Nix store is cached in a Docker volume keyed by the image digest. Each root's owned build cache is mounted
separately, with host ownership restored after execution. Temporary Git snapshot checks discard their build caches on
completion. Each root's `coverage/` reports are exported back to the checkout, including on check failure. Explicit
build, release, and formatting runs therefore require native, Guix, direct Nix, or a Dev Container. Environment pin
updates remain human-initiated.

Host checks verify exact versions from `.node-version`, `rust-toolchain.toml`, `.python-version`, `.go-version`,
`.llvm-version`, and `.tool-versions` when present in the check root. Each `.tool-versions` line names a standalone tool
and its exact version; checks inspect its `--version` output. A mismatch fails before the command runs. The
`{packageManager}` command prefix reads the exact package-manager selection from `package.json`, so check definitions do
not repeat its version.

Guix and Nix use their own pinned toolchains as explicit compatibility targets. They may differ from host pins; all
environments share language dependency lockfiles. Checks report actual tool versions inside the selected environment.
Python checks explicitly use its selected interpreter and disable automatic interpreter downloads. Versions supplied by
one environment are not silently replaced with another environment's tools.

Setup detects languages and reports recommended roles, but does not guess an existing project's commands. Add
`[[check]]` entries before treating setup as complete. A project that needs only structural validation explicitly sets
`allow_empty = true` under `[checks]`; otherwise a full run with no configured commands fails.

A command may invoke plain language tools, an xtask, or another project runner. Workbench orchestrates the command but
does not reproduce its implementation. `workbench checks` shows configured roles and language recommendations;
`workbench checks run` first validates Workbench structure, then runs the commit stage. CI passes `--stage ci`.
`workbench checks run --role ROLE` runs that role with its root's setup; use it for focused checks, not a complete gate.
Setup precedes dependent commands once per root and environment session; automatic gates reject setup excluded by their
stage. `--project ID` selects a registered scope and its descendant roots; it cannot be combined with `--path`.
`workbench checks run --path PATH` selects a registered language root; add `--environment native|guix|nix|nix-docker` to
override the local selection. Without `--path`, an explicit environment applies to every configured check root. When
benchd is installed, a heavy command uses `benchctl hold` and Workbench waits for its result.

The Git adapter materializes the complete staged index as a temporary tree, including unchanged tracked files and
excluding unstaged edits and untracked files. Every commit runs all commit-stage checks against this tree using its
staged launcher. There are no changed-file or extension filters: edits to `Cargo.toml`, `Cargo.lock`, toolchain
configuration, or documentation receive the same checks as source edits. Tools may use their own incremental caches.
When `.workbench` is a submodule, the hook verifies that its checkout matches the staged revision and has no uncommitted
files before making that dependency available to the tree; a mismatch fails the gate. Vendored Workbench files are
copied from the index with the project. The adapter also validates the proposed commit message. The reusable operations
accept a supplied project tree rather than depending on Git, allowing another version-control adapter later. Git's
whitespace and merge-marker checks remain in the Git adapter. Credential checks report only locations, covering private
keys and recognized GitHub, npm, Stripe, and Slack token formats. This is a deliberate high-confidence baseline;
projects can configure additional scanners for their credential providers.

Change messages use Conventional Commit form by default. Conventional Commits does not prescribe widths; Workbench uses
the common 50-character subject and 72-character body convention, both configurable. A project may configure
`unrestricted` message style when another system owns that policy.

The review gate automatically protects charters, ADRs, experiments, workspace settings and automation, workflow/hook
files, conventional language quality configuration, and the language check catalog. Additional files or directory
prefixes belong in agent-maintained `[review].paths` in `automation.toml`. Humans approve exact staged changes with
`workbench review`; they do not maintain an exhaustive path list. Removing a custom protection still protects its
previously selected paths during that change.

Advisory roles run in CI and can be requested with `workbench checks run --role advisory`. They query OSV using exact
npm, Cargo, uv, and Go lock identities; C/C++ checks inspect built vcpkg source SBOMs and resolve upstream Git tags.
Network failures or incomplete responses fail the check. Findings identify locked inputs, not proven exploitability; fix
or review them without weakening the check. Distribution bundling requires each included package's declared SPDX
expression in `[licenses].allow` and retains its license notice. This policy covers dependencies included in Workbench's
distributed executable; it is not a license audit of system packages or every development dependency.

## Develop Workbench

Run the optional harness integration tests when Codex or Claude Code is installed:

```sh
benchctl hold -- node scripts/check-harnesses.mjs codex claude
```

Select either harness by passing only its name. Without benchd installed, run the Node command directly. These tests are
separate from the normal gate and need no credentials or inference service: actual CLIs communicate with a local model
stub. Temporary Git repositories and isolated application homes exercise root and nested sessions, automatic `AGENTS.md`
loading, skill discovery and invocation, explicit-only visibility, and disabled session persistence. No instruction file
is injected through the prompt and no `CLAUDE.md` is created. User settings, skills, credentials, and conversation
history are not copied. Fixtures and application state are deleted on exit. Output reports the tested version without
imposing a version gate. These tests verify harness integration, not a model's workflow judgment.

Evaluate skill behavior separately with real inference:

```sh
benchctl hold -- node scripts/evaluate-skills.mjs codex --output /tmp/workbench-skill-results
# Select cases or a model explicitly; Claude accepts the same case names.
benchctl hold -- node scripts/evaluate-skills.mjs claude review refactors --output /tmp/workbench-claude-results
```

The output directory must be new. Cases cover immediate changeset repair, advisory refactoring without edits, a targeted
dependency upgrade, and audit continuation from a task. The runner checks observable behavior and preserved scope, then
retains final replies, diffs, new files, and a result report for qualitative review. Passing mechanical checks alone
does not establish useful advice or complete review. Reports identify the model, harness, and skill-content digest;
compare repeated runs when assessing a workflow change. Use `--model NAME` to select a model explicitly.

These optional evaluations use paid or subscription inference and, for dependencies, the public package registry. Codex
uses `OPENAI_API_KEY` or a temporary copy of its authentication file; Claude requires `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`. Only credentials are passed into disposable application homes; user settings, personal
skills, and conversation history are not copied. Each model invocation has a five-minute limit. Temporary repositories
and application state are removed on exit; intentional evaluation evidence stays in the selected output directory. Run
on a trusted development host: disposable directories and disabled history are not a general security sandbox.

Install the declared native tools without Guix, Nix, or a universal version manager:

```sh
./bin/workbench tools                        # Pins and installation locations
./bin/workbench tools install                # All registered roots
./bin/workbench tools install --path examples/languages/rust
make build
```

Bootstrap with a Node version satisfying `package.json`'s `engines.node`, Git, Bash, and the system archive tools
(`tar`, `xz`, `unzip`/`zipinfo` on POSIX; Windows includes `tar.exe` and needs Git Bash). Workbench downloads verified
upstream artifacts for Node, Go, LLVM, and standalone tools; Rust uses rustup and Python uses pinned uv. Selected GCC
versions build from verified GNU source archives on Linux, with prerequisites verified by GCC's pinned download script.
GCC source installation additionally needs a working C/C++ bootstrap compiler, Make, and curl or wget. It installs
rustup when absent and each Rust root's declared components, including rust-analyzer. Rust roots may also declare
`rust-toolchain-miri.toml` for a separately pinned Miri nightly; see the Rust reference for its explicit check role.
Installations do not replace system packages or change the parent shell's `PATH`. Checks and `workbench shell` select
the installed pins; ordinary checks never install or repair compiler versions. Package setup still uses the configured
dependency locks.

Bundled artifact metadata covers Linux x64/arm64, Windows x64, and macOS arm64 for the declared native tooling. Windows
ARM64 is unsupported. Compilers, runtimes, and installed helpers use native architecture artifacts. GCC installation and
compatibility coverage support Linux x64 and arm64 only; Clang supports every declared native platform. This policy is
documented in ADR-I and inherited by ADR-J for C++. Unlisted pins require reviewed additions to
`scripts/native-assets.json` (LLVM uses `scripts/llvm-assets.json`) or matching tools supplied on `PATH`. Pins remain
authoritative in each root; artifact metadata records acquisition URLs and SHA-256 digests.

Workbench installations live below the platform user-data directory: `$XDG_DATA_HOME/workbench` (default
`~/.local/share/workbench`), `~/Library/Application Support/workbench`, or `%LOCALAPPDATA%/workbench/data`. Downloads
use the corresponding cache directory: `$XDG_CACHE_HOME/workbench` (default `~/.cache/workbench`),
`~/Library/Caches/workbench`, or `%LOCALAPPDATA%/workbench/cache`. Absolute `WORKBENCH_DATA_HOME` and
`WORKBENCH_CACHE_HOME` override these locations. Rustup and uv retain their own documented storage locations and
configuration; `rustup show home` and `uv python dir` report them. Project cleanup preserves shared installations.

LLVM supplies the compiler and its tools, not a platform SDK. Linux needs system libc/C++ development headers and
libraries (for example, `gcc-c++` and `glibc-devel` on Amazon Linux); macOS needs Xcode Command Line Tools; Windows
needs Visual Studio C++ Build Tools and the Windows SDK, with a developer environment initialized. Native selection
removes inherited Guix/Nix header paths when using installed LLVM. Select Guix/Nix explicitly when their SDK is
intended.

The C/C++ references use vcpkg manifest mode. `.vcpkg-version` pins the tool checkout; `vcpkg-configuration.json` pins
the Git registry baseline independently of the tooling version. `vcpkg.json` declares dependencies. The C CLI uses
yyjson and C++ uses fmt. vcpkg additionally needs curl, zip, pkg-config, and the usual POSIX text utilities. Builds
acquire the pinned tool in user-data storage and use the selected compiler through a generated CMake triplet. Sources
use the Workbench download cache (or `VCPKG_DOWNLOADS`); build trees and installed libraries use the root's selected
build cache. vcpkg's standard binary cache is shared, keyed by compiler, triplet, recipes, and declared ABI-relevant
environment. `VCPKG_BINARY_SOURCES` can configure a remote cache. Baselines set version floors; use explicit overrides
when a dependency needs an exact exception. The C/C++ dependency-refresh skills cover both declarations.

### Language targets and C/C++ compiler selection

Projects configure supported runtime releases in native declarations, separately from exact development pins. Python's
`requires-python` and Ruff/mypy targets, Node's `engines.node`, TypeScript output/libraries and `@types/node`, Go's
`go.mod` directive, and Rust's `rust-version` describe their respective baselines. Select a higher baseline by changing
these declarations together; the registry's `ci_versions` chooses the exact runtime versions exercised by CI.

C/C++ roots configure language standards and compiler support in `workbench/projects.toml`:

```toml
[[language_root]]
language = "cpp"
path = "native"
standard = "20"
compiler = "clang"
compilers.clang = { minimum = "21.1.8", ci_versions = ["21.1.8", "23.1.2"] }
compilers.gcc = { minimum = "14.4.0", ci_versions = ["14.4.0", "15.3.0", "16.2.0"], ci_architectures = ["x64", "arm64"] }
```

`compiler` selects development builds; `compilers` declares supported families, minimum versions, and CI versions.
Declare either family or both. Compiler compatibility jobs select Linux `x64` by default; `ci_architectures` can select
`x64`, `arm64`, or both per family. `standard` selects C or C++ syntax independently of the compiler version; the shared
adapter passes it to the reference CMake configuration. `.llvm-version` is always required for clang-format, clang-tidy,
and LLVM coverage, and also selects Clang development builds. `.gcc-version` selects GCC development when
`compiler = "gcc"`; its presence alone never installs or requires GCC. LLVM remains required when selecting GCC. Native
GCC installation and compiler compatibility coverage support Linux x64 and arm64 only. Managed GCC development needs GCC
added to the selected Guix/Nix environment alongside LLVM; its environment pin owns that compiler version.

Languages sharing a check root must agree on compiler selection and support policy; C and C++ retain separate `standard`
values. The adapter exposes `WORKBENCH_C_STANDARD` and `WORKBENCH_CXX_STANDARD` for both declarations.

Use an explicit selection for compatibility checks without changing development pins:

```sh
./bin/workbench tools install --path examples/languages/cpp --compiler gcc --compiler-version 16.2.0
./bin/workbench checks run --path examples/languages/cpp --environment native --compiler gcc --compiler-version 16.2.0
```

Project code and vcpkg dependencies use the selected compiler. Compiler family, version, standard, and environment
separate build caches, including local storage. GCC linting uses a separate Clang compilation database and dependency
build; LLVM coverage also uses Clang and retains ordinary tests on the selected compiler.

Dev Containers are optional. Install Docker, then the locked host CLI with `workbench tools install --devcontainer`. Use
`workbench shell --environment devcontainer`, `make build ENVIRONMENT=devcontainer`, or select it in
`workbench/local.toml`. The checked-in `.devcontainer/` definition builds from a digest-pinned Linux x64 image, adds the
declared OS prerequisites, and installs the same native tool pins on creation; it works with the standard Dev Container
CLI and compatible editors. A consuming project can copy the `.devcontainer/` directory to its root and adapt it; normal
setup does not introduce containers. Initial support targets Linux x64 containers on POSIX hosts, including Docker
Desktop on macOS with that platform enabled. For Workbench container commands on Windows, use WSL; native Windows checks
remain supported.

The workspace is bind-mounted, so outputs and edits remain in the checkout; the container persists between commands.
Rebuilding it discards tools installed inside it, which setup reinstalls. Workbench mounts this checkout's build cache;
an existing container without that mount must be rebuilt after active work finishes. After changing tool pins, run
`workbench tools install --environment devcontainer` to refresh them in the existing container. Local environment
selection and CI coverage remain independent. Container checks can run from the host through benchd; an editor or
interactive container without benchctl does not provide host scheduling automatically.

The [GitHub workflow](.github/workflows/checks.yml) reads `workbench checks matrix` to build its matrix from
configuration:

```toml
# workbench/config.toml
[checks]
environment = "native"
# nix_docker_image = "nixos/nix@sha256:..."  # Use a real, reviewed digest for nix-docker.

[ci]
operating_systems = ["linux", "macos", "windows"]
architectures = {linux = ["x64", "arm64"], macos = ["arm64"], windows = ["x64"]}
environments = ["guix", "nix-docker", "devcontainer"]
```

CI supplies an explicit environment to each job, independently of local defaults and preferences. Both Guix and Nix can
be selected together; `environments = []` selects native jobs only. Omit `[ci]` when the project does not use the matrix
generator. CI needs at least one operating system and registered language root. There is no separate CI language list:

```toml
# workbench/projects.toml
[[language_root]]
language = "typescript"
path = "web"

[[language_root]]
language = "python"
path = "worker"
ci_environments = []
ci_versions = ["3.11.17", "3.12.15", "3.13.16", "3.14.8"]
```

Every root gets native jobs on the selected operating systems and architectures. `ci.architectures` selects native
architectures per OS; when omitted, Linux/Windows use x64 and macOS uses arm64. Managed environments remain independent
Linux targets. Roots inherit the CI environment list; optional `ci_environments` narrows it, with `[]` disabling managed
jobs for that root. Languages sharing a root must agree on this selection and produce one job per target. Each root's
`[[check]]` commands and authoritative native tool pins supply its checks and installations. Guix requires channels and
a manifest; Nix requires a flake and lock. Dev Containers require the root descriptor. Missing configuration fails
planning. Managed jobs use Linux regardless of the native OS list. `nix-docker` needs Docker and the configured image
digest; direct `nix` requires an installed Nix bootstrap on the runner. The supplied workflow bootstraps Guix and uses
the Docker already provided by GitHub for Nix.

Workbench selects Linux on x64 and arm64, Windows on x64, and macOS on arm64. It registers its own TypeScript root and
all six language references, and selects Guix, Nix, and Dev Containers for the references. The CLI root selects native
and Dev Container jobs. The Dev Container job provisions one workspace and runs only the roots selecting that
environment. The workflow also tests Node, Python, Rust, and Go minima derived from their native manifests,
independently of development pins. TypeScript, Python, and Go roots can add exact runtime pins with `ci_versions` in
`workbench/projects.toml`. Compatibility jobs run on Linux; the matrix removes targets already covered by native jobs or
an identical minimum. Python selections must cover every minor line from the minimum through the newest selected or
development interpreter. The Python reference covers 3.11 through 3.14 while retaining the exact 3.11.17 floor.
Compatibility jobs use pnpm, uv/pytest, Cargo, and Go tests; consuming projects adapt these commands to their own test
runners.

Native CI jobs also prepare each root's configured release artifacts, exercise them outside the source checkout, and
retain them as workflow artifacts. Their tar archives preserve executable permissions, hidden files, and skill links.
This verifies local release packaging; release publication remains a separate operation.

Release-line coverage follows each language's maintenance model: Python's maintained minor lines, Node's maintained LTS
lines and supported Current line, and Go's two maintained lines. Rust tests current stable and its declared minimum.
C/C++ retain their selected language standards while testing declared compiler families and maintained release lines;
the references use Clang for development and cover Clang's declared minimum and GCC's maintained lines on Linux. GCC
compatibility jobs run on both x64 and arm64 runners, using the same version selections and test commands. Compiler
compatibility jobs install LLVM plus the selected compiler, then execute ordinary and sanitizer tests.

Windows checks require Git Bash and enabled directory symlinks. Use `node bin/workbench.mjs` or the `workbench.cmd`
launcher from a native Windows terminal. GNU Make helpers are optional POSIX conveniences; their tests run on Linux and
macOS. Managed environment jobs run on Linux. The CLI integration suite runs on every selected native OS.

Jobs have no path filters and keep running after sibling failures. Failures appear as GitHub checks and through the
repository's configured GitHub notifications. These workflows have not yet run on hosted macOS or Windows runners; a
local Linux pass does not establish their results. Branch protection and notification preferences are repository
settings.

To reproduce an environment job locally when that environment is installed:

```sh
workbench checks run --path examples/languages/python --environment guix
workbench checks run --path examples/languages/rust --environment nix
workbench checks run --path examples/languages/typescript --environment nix-docker
```

`workbench language check --all` verifies bundled references using the local selection; `--environment native`
explicitly uses native pins. Host, Guix, and Nix selections are independent; updating one does not update the others.
See [ADR-Z](workbench/decisions/ADR-0Z.md) for CI policy.

`examples/languages/index.toml` defines each language's reusable commands under `[[language.command]]`, including gate
checks and manual build, release, formatting, and cleanup operations. `[[check_suite]]` selects these definitions for a
registered language root; command roles and stages control when they run.

`manifest.scm` lists the development tools. Select it explicitly for local development; Workbench and `.envrc` do not
load Guix automatically. The tracked `.envrc` loads ignored machine-local `.envrc.local` settings and adds `bin/` to
`PATH`.

The optional static top-level Makefile delegates to Workbench configuration. `make` or `make build` builds all
configured roots; `make check` runs the commit gate; `make test` runs ordinary tests; `make coverage` runs instrumented
tests and enforces floors. `make release` prepares local release artifacts without tagging or publishing. `make fmt`
writes formatting changes, `make lint` runs lint checks, and `make help` lists targets. Release, formatting writes, and
cleanup are manual-only operations. Setup adds this Makefile only when one is absent; it preserves existing consumer
files.

Select a project and descendants with `make build/service` or `make build PROJECT=service`; the same patterns support
check, test, coverage, release, fmt, lint, clean, and distclean. Select exactly one language root with
`make build ROOT=examples/languages/rust`. Adding projects or roots requires no Makefile edits.
`ENVIRONMENT=native|guix|nix|devcontainer` overrides the local environment. Multiple requested Make targets run
sequentially. The direct Workbench CLI remains available without Make; the reference-directory Makefiles are static
wrappers selecting their own root.

Each reference Makefile contains its recipes directly, without including the repository Makefile. After copying a
reference outside this repository, its language manifests still support native builds. Running its Workbench Make
targets also requires a pinned Workbench distribution, project configuration registering the copied directory as a
language root, and a selected language command suite. `WORKBENCH` overrides the executable location; a local
`.workbench/bin/workbench` is selected when present. Shared check adapters come from that distribution. Repository-relative
documentation links and CI declarations must be adapted for the consuming project; the examples do not supply a
human-written project charter.

This repository configures pnpm, Prettier, type-aware ESLint, TypeScript 7 type checking, Vitest, bundle parity, and
shell checks. Rust tools in the root development manifest support the Rust reference checks; the Workbench CLI itself
runs on Node.js. The reference's `rust-toolchain.toml` selects its compiler when using rustup, while its `Cargo.toml`
declares its minimum Rust version. `pnpm run build` rebuilds the bundle; `pnpm run bundle:check` verifies the checked-in
bundle without modifying it. Shipped bundles contain compressed, minified JavaScript without source maps. Small CommonJS
launchers decompress them in memory using Node, with no dependency installation or expanded files on disk.
`bundle.compression` is a project build setting in `workbench/config.toml`: `brotli` (default), `zlib` (gzip), or `zstd`.
Set it with `workbench config set bundle.compression zstd`, then rebuild the distribution. Consuming projects use their
pinned artifact's format; changing their configuration does not recompress an existing dependency. All three formats
use Node's built-in decompression; Zstandard needs a runtime with built-in Zstandard support, available in every selected
Node CI version. Coverage builds unminified bundles with inline source maps in a temporary
workspace, reuses installed development dependencies, and removes that workspace afterward. Coverage reports refer to
the original source paths. Rust, Python, TypeScript, C, C++, and Go have executable language references. The first
decision set remains draft pending human review; temporary CI commits do not accept those decisions.

`make clean` removes build outputs and test/tool caches from Workbench and all language references. `make distclean`
also removes dependency installations. Each reference supports the same targets from its own directory. Cleanup removes
this checkout/root's marked build directories across environments and toolchain revisions. Both preserve the checked-in
bundle, source files, lockfiles, dependency download caches, installed toolchains, unrelated Cargo targets, and Nix/Guix
stores. Concurrent Workbench check sessions and cleanup of the same root are rejected.

Cleanup executes configured commands on the working checkout, without toolchain probes, dependency setup, or managed
containers. `make release ROOT=.` prepares `dist/workbench`, a runnable copy excluding local settings, dependencies, and
generated caches. All six language references publish local release artifacts into `dist/`; ordinary builds and
intermediate files follow the selected storage mode. Rust selects executable artifacts from Cargo's build report.

Build outputs and dependency installations stay in gitignored project directories by default: Cargo `target/`,
TypeScript `build/`, C/C++ and Go `build/`, Node `node_modules`, and Python `.venv`. Package-manager download caches
retain their native locations in local storage mode. Release artifacts remain in `dist/` and CI reports in `coverage/`
in either mode. Coverage intermediates use the selected build storage. Workbench removes its raw V8 dumps and merge
inputs after processing, including on failure; `coverage/` retains the test results and final reports.

For network checkouts or a separate build disk, opt in once in **global user configuration**:

```sh
workbench config
workbench config set storage.external true
workbench config get storage.external
# Optional: choose a different external storage root.
workbench config set storage.root /mnt/fast/workbench
workbench config unset storage.root
```

`workbench config` shows global defaults/preferences, human-managed project options, and ignored local overrides in a
`SCOPE | SECTION | KEY | VALUE` table, with their file paths. Agent-managed `automation.toml` is separate. `<unset>`
means that scope makes no declaration. `get` prints the configured value, including an applicable local override;
`--scope global`, `--scope project`, or `--scope local` inspects that file alone. Outside a project, inspection shows
global options without initializing a project.

`set` infers global scope for storage settings and project scope for project options; use `--scope local` to override
storage preferences or `checks.environment` in ignored `workbench/local.toml`. Local storage settings override global
preferences; tracked project configuration cannot specify machine storage. `unset` removes an optional declaration;
required project fields must be set explicitly. Values are validated before saving. Arrays use TOML syntax, for example
`workbench config set ci.operating_systems '["linux", "macos"]'`. Inspection creates no files. Unknown options, invalid
values, and options in the wrong scope are errors. The global `config.toml` is located at:

| Platform | Global configuration                                                                      |
| -------- | ----------------------------------------------------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/workbench/config.toml`, defaulting to `~/.config/workbench/config.toml` |
| macOS    | `~/Library/Application Support/workbench/config.toml`                                     |
| Windows  | `%LOCALAPPDATA%/workbench/config.toml`                                                    |

`WORKBENCH_CONFIG_HOME` overrides the Workbench configuration directory and must be absolute. The opt-in file contains:

```toml
[storage]
external = true
# root = "/mnt/fast/workbench"
```

External storage defaults to `$XDG_CACHE_HOME/workbench` (or `~/.cache/workbench`) on Linux,
`~/Library/Caches/workbench` on macOS, and `%LOCALAPPDATA%/workbench/cache` on Windows. `storage.root` overrides that
location for builds, dependency installations, and the shared pnpm package store; tool installations and other download
caches are separate. The root must be outside the checkout. Ignored local storage overrides take precedence over global
settings. Separate namespaces identify canonical checkouts (including worktrees), language roots, environments,
toolchain/lock inputs, and build modes.

`workbench paths --path examples/languages/rust` prints the selected locations without creating them. Checks and
`workbench shell` prepare and export the same native controls. For direnv, add
`eval "$(workbench paths --path examples/languages/rust --shell)"` to `.envrc.local`, after any older Cargo target
override. This exports paths only; it does not select or install tools. Use the matching Workbench shell for managed
environments. An active shell retains its storage selection; reopen it after changing global settings. Plain commands
outside a configured shell retain their native defaults.

| Language   | External storage control                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust       | `CARGO_TARGET_DIR`; ordinary `cargo clean` removes the selected target.                                                                                                         |
| C/C++      | CMake build directories for each mode, including vcpkg output.                                                                                                                  |
| Go         | Explicit `go build -o`; Go's shared compilation and module caches retain native defaults.                                                                                       |
| TypeScript | Staged compiler output preserves package metadata and Node resolution. pnpm's per-root virtual store is external; local `node_modules` contains links and small metadata files. |
| Python     | `UV_PROJECT_ENVIRONMENT` selects an external environment; setup maintains a `.venv` link for editors. Bytecode, check caches, and package-build intermediates are external too. |

In external storage mode, pnpm's shared package store lives at `<storage.root>/downloads/pnpm`; with the default Linux
location, this is `~/.cache/workbench/downloads/pnpm`. `PNPM_CONFIG_STORE_DIR` selects it for Workbench commands and
shells. Nix, Guix, and Dev Container execution expose the same cache where external storage is enabled. Project virtual
stores remain separate under `<storage.root>/dependencies`. Keeping both on the same filesystem allows pnpm to share
package files using hard links instead of copying between filesystems. `clean` and `distclean` preserve the shared store;
use `pnpm store prune` from the configured shell for explicit cache maintenance. Existing stores remain untouched when
changing storage preferences, preserving caches used by other projects.

Setup installs from existing locks at the new locations before replacing the local Python environment or removing the
former local pnpm virtual store. Python environments are recreated at their final paths because scripts embed absolute
paths. Turning the setting off and rerunning setup restores local installations. External Node dependencies require
pnpm's isolated linker; Python uses uv. Editable Python metadata may remain beside source.

`make clean` removes owned build products and reports while preserving dependencies. `make distclean` also removes the
selected root's dependency installations across environments. Shared download caches and installed tools are preserved.
Native tools retain their own locking; avoid cleanup during direct tool commands. Previous custom storage roots remain
untouched until selected again for cleanup.

Shell completion is generated from the command definitions, including command names, flags, scoped configuration keys,
and allowed values. It does not initialize projects or execute check commands. Enable it in your shell:

```sh
# Bash; add to ~/.bashrc
source <(workbench completion bash)
# Zsh, after compinit
source <(workbench completion zsh)
# Fish
workbench completion fish | source
```

For PowerShell 7, add `workbench completion powershell | Out-String | Invoke-Expression` to your profile. Completion
scripts are printed for review; Workbench does not edit shell startup files.

Review protected staged changes with `workbench review`. It prints the exact diff and a SHA-256 digest. After explicit
human approval, run `workbench review approve --digest DIGEST`; changed charters additionally require
`--human-written-charters`. The receipt is JSON at `git rev-parse --git-path workbench/review.json`, separate for linked
worktrees. It records the protected paths, old/new Git content identities, review digest, acknowledgment time, and
charter authorship attestation. The hook checks the proposed index, including protected paths from both old and new
configuration. Changing protected content invalidates the receipt; ordinary code edits do not. Local receipts are
cooperative guards, not signatures or proof of authorship. Agents must not acknowledge their own unapproved changes.

`[[check]].warn_seconds` enables advisory elapsed-time reporting after scheduler admission. It includes everything in
that command, including build/setup. Exceeding it never kills the command or changes a successful result. Interpret
warnings using host resources and build context. Coverage variants omit this advisory cap; floors remain enforced by
each language's configured tool. Agents maintain additional protected files or directory prefixes in `automation.toml`
under `[review].paths`; conventional quality declarations are protected automatically.

Workbench's coverage runner and the Rust, C/C++, and Go check adapters read `workbench/quality.json` relative to their
language root. It owns coverage floors; C/C++ and Go also use its advisory `slow_test_seconds`. Python and the
TypeScript reference keep these settings in `pyproject.toml` and `vitest.config.mjs`; Rust's slow-test settings live in
`.config/nextest.toml`. Each value has one authoritative source.

The root coverage runner retains test outcomes, failure diagnostics, and timings in ignored `coverage/tests.json`.
Detailed merged unit and CLI coverage lives in ignored `coverage/coverage-final.json`; the test report omits its duplicate
map. Each root's normalized `coverage/coverage-summary.json` is the only coverage report retained in Git. It uses relative
source paths and stable formatting. `workbench/quality.json` remains committed check policy.

`make coverage` presents totals and per-file changes against the summary committed at `HEAD`, including covered/total
counts and percentage-point differences. Native CI coverage checks use the pull request base revision, or the previous
revision for a push, and append the comparison to the GitHub job summary. The checkout fetches history for these
comparisons. `WORKBENCH_COVERAGE_BASE` selects another baseline revision explicitly. A missing summary or unavailable
revision is reported as an unavailable comparison; it never implies zero coverage or a successful comparison. The first
run establishes a summary to review and commit. Floors are still enforced independently of the comparison. Other
configured coverage commands need a supported report format to participate; built-in references cover Vitest, coverage.py,
LLVM coverage, and Go profiles. Comparison data and detailed reports are excluded from runnable release packaging.

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

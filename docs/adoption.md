# Adopt and update Workbench

[Workbench overview](../README.md). Commands assume your project root and an installed Workbench command.

## Initialize a project

Create a project with one entry point. Preview with `--plan` before applying the same command without it:

```sh
workbench init my-tool --language typescript --plan
workbench init my-tool --language typescript

# Records without application automation
workbench init my-notes --records-only

# Retain an existing Python application and run its existing checks
workbench init --adopt --language python --check "uv run pytest"
```

All ten bundled languages have starters: TypeScript, JavaScript, Java, Rust, Python, C, C++, Go, Ruby, and PHP. C and
C++ are distinct choices. Use `--root RELATIVE_PATH` for an independent language root, and rerun initialization for
another root. The command creates a local Git repository for a new project, without configuring a remote or creating a
commit. `--adopt` requires the existing repository's root; it preserves application files and registers existing
language roots without replacing manifests or adopting the reference command suite. Repeat `--check COMMAND` to connect
more checks. These commands run through the platform's POSIX shell (Git Bash on Windows); they are not executed during
initialization. Existing automation remains project-owned. Inspect the result with `workbench check --list`.

`--id NAME` selects the project namespace. Existing namespaces are preserved. Project setup writes
`workbench/config.toml`, `workbench/projects.toml`, and record maps. Starters carry native pins, dependency locks,
source, and language checks, including complete C/C++ compiler settings. Existing README and license files are retained;
the example license uses `LICENSE.workbench-example` when necessary. Starter ignore rules compose with existing rules.
Other conflicting starter files are reported before Git or project files are created. A preview reports file changes,
hook selection, and commit conventions. No tool installation, project command execution, policy adoption, staging, or
commit happens implicitly.

Charters must be human-written. Initialization never supplies a charter or invents project intent. Write
`workbench/CHARTER.md`, or run `workbench serve` and use **Create charter**. Then run `workbench sync` to derive agent
context and `workbench validate`. Existing hand-written `AGENTS.md` is retained outside a marked Workbench section;
subsequent synchronization updates only that section. Relative links in embedded charters and instructions retain their
original targets. Context is generated from selected project-owned records, including drafts.

For an existing Git repository, `workbench setup` provides records adoption; `workbench init --adopt` additionally
supports connecting language checks. Hooks are opt-in with `--hooks`. Initialization otherwise retains existing hook
selection. Custom hooks are never replaced: compose the distributed `.githooks/pre-commit` and `.githooks/pre-push`
scripts in existing hook chains when desired. Invoke these scripts from the repository root, with the installed
`workbench` command on `PATH`; propagate a failure before continuing the chain. Workbench uses ordinary Git hooks,
without the third-party pre-commit framework.

Commit messages remain unrestricted unless the project selects rules explicitly with `--commit-style conventional`,
`plain`, `area`, or `unrestricted`. Existing configured rules remain selected. For this repository's own integration,
`./bin/workbench setup --hooks` retains its declared Conventional Commit policy.

Setup and synchronization add configured citation-library paths to tracked ignore rules. Personal skill links use local
`.git/info/exclude` rules, so their activation does not modify shared project policy. The executable is independently
pinned; adopting records does not adopt Workbench's repository settings or development environments.

### Optional direnv integration

```sh
workbench setup --direnv
```

This opt-in adds a `.envrc` to the repository root and each distinct registered language/build root. Multiple languages
sharing one root share one hook. Missing `.envrc.local` files receive a comment-only personal starter; existing personal
files remain untouched. Setup adds `.envrc.local` and `.direnv/` to the repository's ignore rules.

The marked Workbench block obtains that root's storage exports and watches configuration and tool inputs. Each new hook
is independent: it loads its own `.envrc.local` after generated exports and does not source a parent `.envrc`. Direnv
restores the previous environment when switching roots. Only languages registered at the selected root receive
language-specific exports. Paths come from the user's settings rather than being copied into shell files.

This checkout's hooks add its launcher directory to `PATH` directly; consuming projects normally use the installed
Workbench command. Existing explicit sharing of shell settings is preserved, but setup does not add parent loading or
create a shared helper file.

Existing shell code outside the marked block is preserved. Setup places the block before a conventional standalone
local-source line; custom inline local loading or incomplete/duplicate markers require explicit correction. It checks
all hooks before writing any of them. Rerun `setup --direnv` after registering another root; plain `setup` leaves direnv
integration alone.

Direnv must be installed and hooked into the user's shell. Review each `.envrc`, then run `direnv allow` in that root.
Workbench does not approve or activate the hooks. Entering another configured root switches its storage exports; source
subdirectories inherit the enclosing root's hook. The hooks export paths only and do not install tools or enter Nix,
Guix, or containers. Use [explicit environments](checks.md#change-gates) for those operations.

Direnv evaluates `.envrc` with Bash internally, then applies exported environment changes through its hook for the
interactive shell, including PowerShell and zsh. This does not require selecting Bash as the interactive shell. Linux
and macOS exercise real direnv integration when direnv is installed; native Windows currently tests hook generation and
path output, but skips real direnv execution. Windows users need Bash to evaluate `.envrc` even when their interactive
shell is PowerShell. Workbench runners do not require direnv.

Noninteractive subprocesses do not trigger direnv's prompt hook, even after approval. See
[agent command execution](checks.md#agent-command-execution) for inherited environments and explicit loading options.

## Update a consuming project

[Executable installation and updates](installations.md) use npm-backed exact tool pins.
[Collection updates](collections.md) reconcile original Git objects against edited project policies. These operations
are independent and neither stages nor commits changes. Review changed ADRs before accepting them.

## Projects and subprojects

`workbench project` lists consuming checkouts in your personal index. Register an existing checkout with
`workbench project add PATH`; setup and initialization register their resulting project. Registration does not modify
the checkout. Interactive project commands ask once when a checkout is unfamiliar; automation must register explicitly.
Declining blocks project commands and gives a reminder of the manual add command. Help and personal project/cache
management remain available. Separate Git worktrees register separately.

`workbench project remove PATH --json` prepares the combined cache cleanup and removal plan. After reviewing its
SHA-256, use `workbench project remove PATH --apply --digest SHA256`. An interactive removal also offers confirmation.
Removal rechecks ownership and the reviewed state, preserves source files and protected shared tools, and only removes
registration after eligible private caches are gone. Failures preserve registration. A removed project remains declined
until explicitly added again. The [browser dashboard](web.md) offers the same reviewed workflow.

The personal index is distinct from `workbench/projects.toml`, which declares record scopes and language roots inside
one checkout. Those narrower record scopes are **subprojects**:

Register a subproject interactively with `workbench subproject add`, or noninteractively with:

```sh
workbench subproject add PROJECT_ID RELATIVE_PATH --name "Display Name"
```

The optional display name preserves capitalization and may contain spaces. IDs remain stable lowercase namespaces for
record references and command arguments. Use `workbench init --id graphai --name GraphAI --records-only` when creating a
named project. Existing project and subproject names can be edited in `workbench/projects.toml`:

```toml
[[project]]
id = "graphai"
name = "GraphAI"
path = "."

[[project]]
id = "graphmp"
name = "GraphMP"
path = "packages/compute"
```

Names default to IDs when omitted. Subprojects may nest under other subprojects. The CLI's subproject listing and the
browser's breadcrumbs use registered names along that hierarchy, such as `GraphAI/GraphMP`. Directory segments that are
not registered scopes add no breadcrumb entries. Selecting a name in the browser tree shows that scope's records; header
search includes all project scopes; selecting a collection searches that collection separately.

The command creates its `workbench/` directory and maps but no charter or recursive `AGENTS.md`. One root `AGENTS.md`
embeds every registered project's charter and groups extracted ADR instructions by their applicable directory. The root
and subprojects use the same layout, each with a decision-map link. Adopted collection instructions apply to their
declared scopes; subproject instructions apply only within that directory and its descendants. Instructions stay inline
and link to their source ADRs. Agents read root and adopted collection maps, then narrower maps relevant to their work.

`[[language_root]]` entries in `workbench/projects.toml` select a language and its relative check root independently of
record scopes. Select a workspace root when its build tool covers members; select independent roots when it does not.
Setup detects conventional manifests such as `tsconfig.json`, `Cargo.toml`, and `pyproject.toml`.
`workbench language roots` reports configured roots and detected manifests. For any bundled language in an empty root,
`workbench language init LANGUAGE [PATH]` seeds the declared locked starter without overwriting existing files; projects
may then adapt it. Checks run project-configured commands, not a permanent comparison with starter defaults.

`workbench language` shows supported languages and reference projects under `examples/languages/` in the executable
distribution. Inspect and adapt these examples, then use `workbench check` to verify configured project roots.
References carry the language's conventional configuration and checks without pretending to be complete application
templates. Their optional Guix and Nix definitions select tools independently of native pins. Guix defaults to the
configured project’s root `channels.scm`, with a complete subproject channel replacement when present and a
`manifest.scm` in each language root; Nix uses `flake.nix` with `flake.lock`. The examples are language roots sharing
this repository's record scope. When copying one, adapt its paths and destination-project configuration, including the
destination’s Guix channel pin. Workbench never enters either environment automatically.

The environment decisions read in order from the [shared policy](../workbench/decisions/ADR-0P.md) to
[Nix](../workbench/decisions/ADR-0Q.md) and [Guix](../workbench/decisions/ADR-0R.md). Read the shared policy and the
decision for the environment being used.

## Personal skills

Shared skills stay in the project's pinned Workbench distribution. Users enable or disable skills once in user
configuration, without project overrides. New skills start disabled. Project configuration limits applicability:
language skills require matching registered roots, and Nix/Guix update skills require configured checks using that
environment. Skills still verify their target root.

```sh
workbench skills                         # Interactive checklist; a status table without a terminal
workbench skills --json                  # Inspect names, sources, selection, and applicability
workbench skills enable review-changes
workbench skills disable review-changes
workbench sync                           # Refresh project maps, context, and local skill links
```

The checklist includes Select all and Select none, followed by a checkbox for each skill. Arrows move, Space changes
selection, Enter saves, and Esc cancels. Selecting an inapplicable skill preserves that preference for other projects;
it does not activate discovery in this project. Canceling makes no changes. A checklist save rejects concurrent
preference changes; reopen the checklist to review the latest selection.

`skills.enabled` lives only in user configuration. Enable/disable updates the current checkout immediately; other
checkouts refresh on their next synchronization. There is no separate skill synchronization command. If link refresh
fails after saving preferences, the command reports that partial success and directs you to `workbench sync`.

Applicability follows the skill's location in the distribution:

| Location                                    | Required project configuration                                             |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `skills/workflows/<skill>/`                 | Any configured Workbench project                                           |
| `skills/languages/<language>/<skill>/`      | A matching `language_root` registration                                    |
| `skills/nix-update/`, `skills/guix-update/` | Checks using that environment locally or in CI; `nix-docker` counts as Nix |

Language names match the registered identifiers exactly; applicability is not inferred from source filenames. A mixed
language project exposes selected skills for all its registered languages. Workbench creates no user-level agent
discovery links; independently installed global skills are outside its selection and filtering.

Discovery links are local and ignored, pointing into the pinned distribution; no upstream skill copies are committed.
Setup requires that distribution locally, and cleared caches may require reacquisition and synchronization before
opening the agent. Synchronization preserves unrelated skills and rejects ownership collisions. Independently authored
project skills may still be committed. Shared validation and CI do not require anyone's personal discovery links.

Executable updates report added, removed, and changed skills, including supporting files, and refresh local links using
the new pin. Personal choices survive updates; added skills remain disabled. User preferences select names across
projects; each project's pin supplies its versions. Updating the user launcher's default changes the available catalog
outside pinned projects, without changing their pins. Skill selection does not waive applicable ADR requirements.

| Harness     | Project instructions                        | Skill discovery        |
| ----------- | ------------------------------------------- | ---------------------- |
| Codex       | Root `AGENTS.md`                            | Root `.agents/skills/` |
| Claude Code | Root `AGENTS.md` through its native support | Root `.claude/skills/` |

These are the supported adapters. Use recent harnesses with native instruction discovery enabled. Workbench does not
create `CLAUDE.md` or change user settings. Claude's instruction settings or existing Claude instruction files can
affect native `AGENTS.md` loading; see its [memory documentation](https://code.claude.com/docs/en/memory). Other
harnesses may recognize the shared format or directories, but that alone does not establish tested support.

| Skill                                       | Selection                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `fetch-and-rebase-onto`                     | Requested rebase onto a remote branch; requires a clean checkout and resolves conflicts         |
| `plan-work`                                 | Requested iterative planning, including material questions, answers, and newly discovered work  |
| `review-plan`                               | Requested plan review against requirements, project constraints, and relevant source            |
| `review-changes`                            | Before commit or task completion; reviews accumulated work and fixes in-scope issues            |
| `review-project`                            | Explicit project or scoped review; human selection of follow-ups, with authorized local commits |
| `find-bugs`                                 | Requested defect investigation within the selected scope                                        |
| `run-experiment`                            | Requested recorded comparisons; human review of EXP/ENV records and supporting files            |
| `workbench-adopt`                           | Requested adoption or migration of an existing project's Workbench integration                  |
| `fix-ci`                                    | Requested diagnosis and repair of failing CI checks in their actual environment                 |
| `update-ci`                                 | Requested CI version updates, including compiler images and newer Debian stable bases           |
| Language-specific dependency refresh skills | Requested updates or inspection in matching registered language roots                           |
| `nix-update`, `guix-update`                 | Explicitly requested environment updates when that environment is configured                    |

`update-ci` checks Debian stable and point releases as part of a general CI update, along with compiler, runtime,
action, package, and image pins. Targeted and inspection-only requests retain their scope. LLVM APT major selectors
require checking the actual package build and recording reproducible inputs; independently pinned CI environments may
differ from native patch versions. Guix and Nix pins change only when the request covers those environments. Version
updates preserve the configured compatibility matrix and language support boundaries.

Enable `fetch-and-rebase-onto` with `workbench skills enable fetch-and-rebase-onto`, then invoke it as
`$fetch-and-rebase-onto origin/main` in a supporting harness. It refuses before fetching when staged, unstaged, or
untracked work exists, or another Git integration is in progress. Ignored build output is allowed. It resolves conflicts
and verifies the rebased result without automatically stashing, creating temporary commits, or pushing.

`plan-work` creates or revises the requested planning document using the project's existing conventions and selected
method. It records material questions, developer answers, decisions, assumptions, and unresolved issues in the plan. New
findings revise affected steps and dependencies without implicitly expanding implementation authority. `review-plan`
assesses the plan and its relevant sources; fresh-context review is used only when available and authorized, and a
same-context review states that limitation. Both skills start disabled and do not change the record schema or prescribe
a planning framework.

For major features, the planning skills require human approval of the concrete plan before implementation and renewed
approval for material scope changes. Readiness and agent review do not establish that approval. Authorized small audit
fixes and refinements of the current implementation remain distinct.

Normal skills permit implicit selection when their description matches; this is not a scheduled hook. Required
completion review comes from ADR-C. `review-changes` considers the complete proposed commit and, at task completion, the
accumulated implementation across its commits and pending changes. It includes worthwhile design improvements revealed
by implementation. Skill availability does not itself authorize edits, commits, or publication.

`review-project` requires explicit invocation in both harnesses, using Claude's `disable-model-invocation` frontmatter
and Codex's `agents/openai.yaml` policy; validation checks agreement. An unqualified invocation covers the project; a
request can name a subsystem, task, or recent work and focus on usability, tests, simplification, performance, or
another concern. For example, `$review-project cache management, focusing on ownership and recovery` reviews that area
across its implementation boundaries. Explicit advice-only requests leave files unchanged. Otherwise, the review task
retains the overview, evidence, proposed groups, and coverage limits. There is no finding quota or numerical cap. Small
repairs require authorization.

The developer reviews proposed follow-ups before they become approved work. The log and authorized automatic repairs may
be committed locally while that review is pending. Proposal acceptance does not itself authorize implementing them.
Meaningful task updates accompany related work; authorized fixups can be folded into the task's own unpublished commits,
preserving unrelated and published history. Required developer completion acceptance and push authorization remain
separate from local verification and commits.

Backward compatibility is deliberately opt-in during initial development. Setup writes `compatibility.required = false`
to `workbench/config.toml`; only a human changes that Boolean to require compatibility. When enabled, the compatibility
ADR governs externally observable interfaces, persisted formats, protocols, and user workflows.

The independent project setting `compatibility.data` directs agents when a requested implementation change makes
existing data incompatible. Setup writes `ask`; omitting the setting also selects `ask`.

| Value     | Direction                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------- |
| `ask`     | Obtain the user's direction before migrating or deleting affected data.                            |
| `migrate` | Preserve affected data through migration.                                                          |
| `delete`  | Delete affected data instead of implementing migration, including data that cannot be regenerated. |

Only humans select either compatibility setting. A configured `delete` supplies standing authorization for data affected
by the requested change; explicit instructions for that change take precedence. It does not authorize unrelated cleanup.
The settings are independent: data handling does not waive required compatibility contracts. Inspect or change the data
policy through the project configuration interface:

```sh
workbench config get compatibility.data
workbench config set compatibility.data delete
workbench config unset compatibility.data
```

Unsetting restores `ask`. Global and local overrides are unavailable for this shared project policy. Editing the setting
does not itself execute a migration or delete data. Workbench's own development configuration explicitly selects
`delete`; new consuming projects use `ask`.

Architecture topics such as terminal interfaces, cloud adapters, and live services remain discoverable decisions. They
do not need selectors merely to suppress a short agent instruction. An ADR receives `agent_instruction` frontmatter when
its rule must guide an agent before topic-specific reading. The maps ADR supplies the routing instruction; generated
links supply its paths. Map entries pair each ADR's title with concise topic cues from its `summary`. Generated files
introduce no independent policy.

The engineering decisions cover the [shared baseline](../workbench/decisions/ADR-0A.md),
[testing](../workbench/decisions/ADR-0B.md), [review](../workbench/decisions/ADR-0C.md), and
[quality gates](../workbench/decisions/ADR-0U.md), followed by grouped language decisions. Read the map first and open
the decisions relevant to the work. Common requirements live in the baseline; language decisions specialize them.

Adopted decisions are edited in place to state current project policy. There is no `overrides` metadata or precedence
between collection and project decisions. Reconcile policy conflicts before accepting the adopted records.

## Copying examples

Each reference Makefile contains its recipes directly, without including the repository Makefile. After copying a
reference outside this repository, its language manifests still support native builds. Running its Workbench Make
targets also requires a pinned Workbench distribution, project configuration registering the copied directory as a
language root, and a selected language command suite. `WORKBENCH` overrides the executable location; the installed
`workbench` command is used by consumers. Copied `scripts/check.mjs` and `scripts/release-verify.mjs` files own the
example's source layout, artifact names, and behavioral assertions. Their configured commands pass the pinned Workbench
directory when reusable tool or coverage helpers are needed. Repository-relative documentation links and CI declarations
must be adapted for the consuming project; the examples do not supply a human-written project charter.

`language init` copies the language's declared starter files and selects its command suite. It does not install the
example's complete Nix, Guix, container, release-profile, or CI configuration. Copy and adapt those files explicitly
when adopting a complete environment. In both cases, copied files are owned by the consumer and are not replaced by
updates.

Runtime compatibility uses manual `compatibility-setup` and `compatibility-test` command roles from that same selected
suite, including complete local replacements. At least one test command is required when a compatibility target is
configured; omitting it fails instead of selecting an implicit test runner. Setup runs first under the verified runtime.
Commands may use `{runtime}` and `{runtimeVersion}` as literal argument substitutions. `workbench ci --json` reports the
selected commands and their sources. Compatibility outputs and dependencies are isolated by runtime version.

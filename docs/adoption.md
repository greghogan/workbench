# Adopt and update Workbench

[Workbench overview](../README.md). Commands assume your project root and an installed Workbench command.

## Initialize a project

Run one setup command from the repository root:

```sh
# This source repository
./bin/workbench setup

# A consuming repository after installing the user command
workbench setup
```

Setup asks for a new project ID when needed, writes project configuration, and configures Git change gates. It leaves
existing records intact. The executable is acquired separately; `.workbench/collections/` reserves deinitialized
collection submodule paths.

`workbench setup --id NAME` chooses an explicit root project ID; subsequent setup preserves it. `workbench project`
lists registered scopes (`--json` provides structured output). Project setup creates `workbench/config.toml`,
`workbench/projects.toml`, and all record maps. It never writes a charter or placeholder `AGENTS.md`. Checks cannot pass
until each registered project has a human-written `workbench/CHARTER.md`. Afterward, `workbench sync` derives the root
`AGENTS.md` from project charters and selected ADR instructions, including drafts. Existing hand-written agent guidance
is preserved and must be moved before sync can take ownership.

Setup configures Workbench's tracked Git hooks when doing so will not overwrite another hook path. These are ordinary
Workbench-owned `pre-commit`, `pre-push`, and `commit-msg` hooks; the project does not use the third-party `pre-commit`
framework. Setup and synchronization add the configured citation-library paths to tracked `.gitignore` rules, so clones
exclude local document downloads before running Workbench. Personal skill links use checkout-local `.git/info/exclude`
rules; skill synchronization creates both the links and their exclusions on each checkout.

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

## Projects and agent context

Register a subproject interactively with `workbench project add`, or noninteractively with:

```sh
workbench project add PROJECT_ID RELATIVE_PATH
```

The command creates its `workbench/` directory and maps but no charter or recursive `AGENTS.md`. One root `AGENTS.md`
embeds every registered project's charter and groups extracted ADR instructions by their applicable directory. The root
and subprojects use the same layout, each with a decision-map link. Adopted collection instructions apply to their
declared scopes; subproject instructions apply only within that directory and its descendants. Instructions stay inline
and link to their source ADRs. Agents read root and adopted collection maps, then narrower maps relevant to their work.

`[[language_root]]` entries in `workbench/projects.toml` select a language and its relative check root independently of
record scopes. Select a workspace root when its build tool covers members; select independent roots when it does not.
Setup detects conventional manifests such as `tsconfig.json`, `Cargo.toml`, and `pyproject.toml`.
`workbench language roots` reports configured roots and detected manifests. For an empty TypeScript, JavaScript, Java,
Ruby, or PHP root, `workbench language init LANGUAGE [PATH]` seeds the declared locked starter without overwriting
existing files; projects may then adapt it. Checks run project-configured commands, not a permanent comparison with
starter defaults.

`workbench language` shows supported languages and reference projects under `examples/languages/` in the executable
distribution. Inspect and adapt these examples, then use `workbench check` to verify configured project roots.
References carry the language's conventional configuration and checks without pretending to be complete application
templates. Their optional Guix and Nix definitions select tools independently of native pins. Guix defaults to the
configured project’s root `channels.scm`, with a complete subproject channel replacement when present and a
`manifest.scm` in each language root; Nix uses `flake.nix` with `flake.lock`. The examples are subprojects of this
repository. When copying one, adapt its paths and destination-project configuration, including the destination’s Guix
channel pin. Workbench never enters either environment automatically.

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
workbench skills enable workbench-review
workbench skills disable workbench-review
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

| Skill                                       | Selection                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `workbench-review`                          | After implementation or when reviewing pending changes; fixes in-scope issues         |
| `workbench-refactors`                       | Requested advice or a second look; advisory unless implementation is also requested   |
| `workbench-bug-hunt`                        | Requested defect investigation within the selected scope                              |
| `workbench-audit`                           | Explicit invocation only; whole-project audit with task-based continuity              |
| `workbench-experiment`                      | Requested recorded comparisons; human review of EXP/ENV records and supporting files  |
| `workbench-adopt`                           | Requested adoption or migration of an existing project's Workbench integration        |
| `workbench-ci`                              | Requested diagnosis and repair of failing CI checks in their actual environment       |
| `workbench-ci-update`                       | Requested CI version updates, including compiler images and newer Debian stable bases |
| Language-specific dependency refresh skills | Requested updates or inspection in matching registered language roots                 |
| `nix-update`, `guix-update`                 | Explicitly requested environment updates when that environment is configured          |

`workbench-ci-update` checks Debian stable and point releases as part of a general CI update, along with compiler,
runtime, action, package, and image pins. Targeted and inspection-only requests retain their scope. LLVM APT major
selectors require checking the actual package build and recording reproducible inputs; independently pinned CI
environments may differ from native patch versions. Guix and Nix pins change only when the request covers those
environments. Version updates preserve the configured compatibility matrix and language support boundaries.

Normal skills permit implicit selection when their description matches; this is not a scheduled hook. Required review
comes from ADR-C. A skill's availability does not itself authorize edits or commits. Full audits disable implicit
invocation with Claude's `disable-model-invocation` frontmatter and Codex's `agents/openai.yaml` policy; validation
checks agreement. Invoke `workbench-audit` by name with the harness's skill syntax. Advisory refactor review can reveal
both missed cleanup and broader opportunities after changeset review; it should explain which it found.

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

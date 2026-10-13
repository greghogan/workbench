# Adopt and update Workbench

[Workbench overview](../../README.md). Commands assume your project root; `workbench` denotes the executable in your
pinned distribution.

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

Versioned [user/system installations](installations.md) share immutable bytes while retaining exact project pins.
Their updates select an already installed revision or seal digest. The commands below describe the submodule workflow.

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
committing. Shared installations use the same isolated preparation with their tracked content pin. Vendored distributions and Workbench's own source checkout use their normal
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
`workbench language roots` reports configured roots and detected manifests. For an empty TypeScript, JavaScript, Java,
Ruby, or PHP root, `workbench language init LANGUAGE [PATH]` seeds the declared locked starter without overwriting
existing files; projects may then adapt it. Checks run project-configured commands, not a permanent comparison with
starter defaults.

`workbench language` shows supported languages and their executable reference projects under `examples/languages/`;
`workbench language check --all` verifies them. References carry the language's conventional configuration and checks
without pretending to be complete application templates. Their optional Guix and Nix files independently pin the tools
provided by each package set. Guix uses `channels.scm` with `manifest.scm`; Nix uses `flake.nix` with `flake.lock`.
Workbench never enters either environment automatically.

The environment decisions read in order from the [shared policy](../../workbench/decisions/ADR-0Q.md) to
[Nix](../../workbench/decisions/ADR-0R.md) and [Guix](../../workbench/decisions/ADR-0S.md). Read the shared policy and
the decision for the environment being used.

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

| Skill                                                                                                                                                              | Selection                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `workbench-review`                                                                                                                                                 | After implementation or when reviewing pending changes; fixes in-scope issues         |
| `workbench-refactors`                                                                                                                                              | Requested advice or a second look; advisory unless implementation is also requested   |
| `workbench-bug-hunt`                                                                                                                                               | Requested defect investigation within the selected scope                              |
| `workbench-audit`                                                                                                                                                  | Explicit invocation only; whole-project audit with task-based continuity              |
| `workbench-experiment`                                                                                                                                             | Requested recorded comparisons; mandatory human review of EXP records                 |
| `workbench-adopt`                                                                                                                                                  | Requested adoption or migration of an existing project's Workbench integration        |
| `workbench-ci`                                                                                                                                                     | Requested diagnosis and repair of failing CI checks in their actual environment       |
| `workbench-ci-update`                                                                                                                                              | Requested CI version updates, including compiler images and newer Debian stable bases |
| `rust-dependency-refresh`, `python-dependency-refresh`, `typescript-dependency-refresh`, `c-dependency-refresh`, `cpp-dependency-refresh`, `go-dependency-refresh` | Requested updates or inspection in matching language roots                            |
| `nix-update`, `guix-update`                                                                                                                                        | Explicitly requested environment updates when that environment is configured          |

`workbench-ci-update` checks Debian stable and point releases as part of a general CI update, along with compiler,
runtime, action, package, and image pins. Targeted and inspection-only requests retain their scope. LLVM APT major
selectors require checking the actual package build and recording reproducible inputs; independently pinned CI
environments may differ from native patch versions. Guix and Nix pins change only when the request covers those
environments. Version updates preserve the configured compatibility matrix and language support boundaries.

Normal skills permit implicit selection when their description matches; this is not a scheduled hook. Required review
comes from ADR-B. A skill's availability does not itself authorize edits or commits. Full audits disable implicit
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

The engineering decisions read in order from the [shared baseline](../../workbench/decisions/ADR-09.md) through
[testing](../../workbench/decisions/ADR-0A.md), [quality gates](../../workbench/decisions/ADR-0U.md), and
[review](../../workbench/decisions/ADR-0B.md), followed by the grouped language decisions. Read the map first and open
the decisions relevant to the work. Common requirements live in the baseline; language decisions specialize them.

A replacement ADR names its targets in the YAML `overrides` array, such as `overrides: [app:ADR-0]`. Its body states the
replacement rule. Replacements apply only within their owning scope, and root context displays that scope and the
affected records. Missing targets, sibling-scope overrides, duplicate replacements, and cycles are errors. Current draft
instructions and replacements affect the workspace immediately; only a human-reviewed commit accepts them.

## Copying examples

Each reference Makefile contains its recipes directly, without including the repository Makefile. After copying a
reference outside this repository, its language manifests still support native builds. Running its Workbench Make
targets also requires a pinned Workbench distribution, project configuration registering the copied directory as a
language root, and a selected language command suite. `WORKBENCH` overrides the executable location; a local
`.workbench/bin/workbench` is selected when present. Copied `scripts/check.mjs` and `scripts/release-verify.mjs` files
own the example's source layout, artifact names, and behavioral assertions. Their configured commands pass the pinned
Workbench directory when reusable tool or coverage helpers are needed. Repository-relative documentation links and CI
declarations must be adapted for the consuming project; the examples do not supply a human-written project charter.

`language init` copies the language's declared starter files and selects its command suite. It does not install the
example's complete Nix, Guix, container, release-profile, or CI configuration. Copy and adapt those files explicitly
when adopting a complete environment. In both cases, copied files are owned by the consumer and are not replaced by
updates.

Runtime compatibility uses manual `compatibility-setup` and `compatibility-test` command roles from that same selected
suite, including complete local replacements. At least one test command is required when a compatibility target is
configured; omitting it fails instead of selecting an implicit test runner. Setup runs first under the verified runtime.
Commands may use `{runtime}` and `{runtimeVersion}` as literal argument substitutions. `workbench ci --json` reports the
selected commands and their sources. Compatibility outputs and dependencies are isolated by runtime version.

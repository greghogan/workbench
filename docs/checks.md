# Checks, coverage, and human review

[Workbench overview](../README.md). Commands assume your project root; `workbench` denotes the executable in your pinned
distribution.

## Change gates

`workbench check` runs the commit gate, then attempts fresh online checks. `make check` does the same. If the
connectivity probe cannot reach its endpoint, the command reports that online checks were skipped; offline success
remains useful, but is not an online verification result. The default probe is an HTTP HEAD request to
`https://api.osv.dev/`, with a five-second timeout. Use `--connectivity-url URL` to select an endpoint suitable for your
project. DNS, routing, and connection timeouts permit a reported skip. Certificate errors and other unexpected errors
fail. Any HTTP response establishes connectivity; online checks then run and their failures remain failures, including
advisories, authentication errors, unavailable services, or a connection lost during execution.

Use `workbench pre-commit` or `make pre-commit` for the commit-stage gate alone. Use `workbench pre-push` or
`make pre-push` for required online checks without repeating offline tests. Pre-push never skips for lack of
connectivity. Both gates validate project records. Online results always run fresh and include required setup.

`workbench check --list` displays both plans without probing the network. Its `--json` output contains `preCommit` and
`prePush` plans. `pre-commit --list` and `pre-push --list` inspect individual gates. Explicit `check --stage STAGE` or
`check --role ROLE` runs only that selection. Repeat `--role` to select a union of roles, and repeat `--exclude-role` to
omit roles. For example, `workbench check --role lint --role type` runs those roles in configured order with required
setup once per session. Exclusions alone retain the commit-stage defaults; use `--stage ci` for CI selection. Unknown
roles, overlapping includes/excludes, and exclusion of required setup fail before execution. Select `clean` or
`distclean` alone. These flags apply to `check`; commit and push gates retain their complete configured requirements.
Use `--path` or `--project` to focus any gate, and `--verbose` to stream full logs. The matching Make targets support
the same root and project selectors.

Setup installs Git's `pre-commit`, `pre-push`, and `commit-msg` hooks. Commit checks use the staged tree; push checks
use each distinct outgoing tip tree from Git's ref updates. Deletions require no online checks. Annotated tags are
checked at their commit; tags pointing to non-commit objects have no project gate. Push checks leave the working tree
and index untouched and never prompt for human record approval. The command `workbench pre-push` itself checks the
selected project tree; it neither pushes commits nor installs hooks.

Declare network-dependent commands with `online = true` in project checks or language automation. They default to the CI
stage. `workbench pre-push` selects those configured for CI independently of their role. If none are configured, the
command reports that explicitly.

`workbench validate` checks the registry, record schemas and relationships, canonical record formatting, generated-file
freshness, documentation links, and source coverage. It does not rewrite files. Formatting and semantic checks are
separate: an incomplete draft can be formatted even when it is not ready to pass validation.

```sh
workbench format workbench/decisions/ADR-00.md     # Print formatted Markdown
workbench format workbench/citations/CIT-00.json --write
workbench format --all --write                     # Format registered records
workbench format --all --project api --check       # Check one scope without writing
workbench sync                                    # Refresh derived files after edits
```

Explicit paths accept Markdown, JSON, or YAML. `--all` requires `--write` or `--check` and covers records and their
citation acquisition metadata in registered scopes; it excludes retained upstream metadata, dependency records,
charters, generated files, and ordinary documentation. Batch formatting parses all selected files before writing, so
syntax errors leave the batch unchanged. Individual writes are atomic.

The formatter is bundled with Workbench and uses its pinned Markdown/JSON/YAML plugins. It normalizes layout and reflows
prose toward `[markdown].wrap_width` in `workbench/config.toml` (120 by default). The width is a target, not a hard
maximum for URLs, tables, or code. YAML values, sequence order, comments, and deliberate Markdown hard breaks are
preserved. Embedded code formatting is disabled so record evidence is not reformatted as source code. Canonical
formatting means that another pass produces identical output. Format before submitting ADRs, experiments, or hardware
environments for human review.

`workbench sync` refreshes maps, agent context, record sequences, release indexes, and skill discovery. Generated files
are verified against their renderers, which preserve embedded human-written charters.

`workbench/config.toml` contains project choices: environment and CI selection, formatting, compatibility, commit style,
citation storage, and distribution license policy. `workbench/automation.toml` contains agent-maintained commands, check
ordering, and documentation wiring. `workbench/projects.toml` registers document scopes and language roots. Unknown keys
are rejected; custom metadata belongs under `extensions`. Automation settings may be kept inline in small projects, but
the same section cannot be defined in both files.

Workbench configuration updates, development selection, collection reconciliation, and record allocation preserve TOML
comments and formatting outside the changed values. Removing a setting retains its comments as separate lines; replacing
a commented container keeps its comments beside the declaration.

Language references use compact suites in automation configuration:

```toml
[[check_suite]]
language = "rust"
path = "examples/languages/rust"
```

A suite uses the selected language's commands from the pinned Workbench distribution. `workbench check --list` displays
the expanded plan. Use explicit checks when a project needs different commands; do not select both forms for the same
suite. Names describe operations and do not determine execution order. The examples are independent language roots
sharing Workbench's charter and decisions; separate document scopes are needed only for distinct intent or records.

Automation configuration binds portable roles such as `format`, `lint`, `test`, and `docs` to project-owned commands:

```toml
[[check]]
name = "web tests"
role = "test"
project = "web"
command = ["{packageManager}", "run", "test"]
stages = ["commit", "ci"]

[check.coverage]
command = ["{packageManager}", "run", "coverage"]
stages = ["commit", "ci"]
environments = ["native"]

[check.coverage.ci]
operating_systems = ["linux"]
architectures = ["x64"]
toolchain = false
```

Omitted `stages` selects both commit and CI, or only CI for an online check; `stages = []` makes an operation
manual-only. Checks require their root's setup by default. A command that can run without dependency installation may
declare `requires_setup = false`; built-in lockfile advisory checks do so. A group still runs setup first when any
selected check requires it. This does not bypass environment selection or tool requirements, and online checks remain
fresh. Explicitly selecting the setup role still executes it.

Roots normally wait for their ancestors to finish. A project can explicitly allow an independent root to start after
another root's setup, or order sibling roots by completion:

```toml
[[check_order]]
root = "examples/languages/typescript"
after = "."
phase = "setup" # "complete" waits for all selected checks in the predecessor root.
```

Both paths must name configured check roots. Each rule changes only the named pair; other ancestor barriers and the
ordering of environments within one root remain in effect. Unknown roots, duplicate pairs, self-dependencies, and cycles
fail before execution. Keep rules alongside checks in `workbench/automation.toml`, or inline in the project config.

Ordering applies when both roots are selected. Focusing `--path`, a project, or a CI target does not add other roots to
the selection. Each root retains its own setup and one shared session for setup and dependent checks. Setup overlap
applies to automatic stage gates; explicit role operations, different environments, or predecessors without selected
setup wait for full completion. Declare overlap only when the roots can safely share the checkout after setup. Commands
that rewrite shared source files still need completion ordering.

A test check's optional `coverage` table supplies an alternative command for the same suite. On matching stages,
operating systems, and environments, it replaces the ordinary command. Its defaults are commit and CI, all supported
operating systems, and native tools. Development commands such as `make test` explicitly select ordinary tests.
`coverage.stages = []` permits only explicit coverage runs. Coverage enforces the same behavioral tests plus the
existing floors, without a suite timing cap.

An optional `coverage.ci` table narrows CI independently of local commit gates. Its `operating_systems` and
`environments` inherit the common coverage selections when omitted. `architectures` optionally selects `x64` or `arm64`;
`toolchain = false` selects the default toolchain, while a string selects one named profile. Omission allows all
profiles. The reference definitions use coverage for native commit gates and the default Linux x64 CI target for each
root; other CI targets run ordinary tests. Configured CI coverage must match at least one matrix target. Narrowing
required stages or targets requires human review.

Coverage remains limited by each adapter's supported platforms. The PHP reference uses native coverage on Linux; its
macOS and Windows commit gates retain ordinary tests.

`workbench check --list --stage ci` displays the selected plan; add `--role`, `--project`, `--path`, or `--environment`
to inspect a narrower selection. Explicit `workbench check --role coverage` runs coverage regardless of its automatic
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
Containers use the workspace descriptor. Missing definitions fail. `workbench check --list` shows the effective
selection.

Local preferences do not change CI matrices, project commands, or generated shared context and skill links. Git's
staged-tree gate uses the working checkout's local preference with the staged commands and environment definitions.
`workbench update` preserves ignored local preferences.

Use the same environment selection for an interactive shell or a single build command:

```sh
workbench shell --path examples/languages/rust
workbench shell --path examples/languages/rust -- cargo build --locked
workbench check --path examples/languages/rust
workbench check --path examples/languages/rust --environment native
```

The shell works in the checkout and exposes `workbench`. Inside Guix/Nix shells, checks require the same root and
environment; exit before switching. A Dev Container shell supports every registered root in its workspace, selecting
each root's native pins. Interactive sessions select PowerShell 7 (`pwsh`) on Windows. On Unix they use `SHELL`,
defaulting to zsh on macOS and Bash elsewhere. Selection occurs inside the chosen environment, so a Linux container uses
its own shell. Supported Unix shells include Bash, zsh, fish, sh, dash, ksh, csh, tcsh, and PowerShell. Personal startup
files are disabled to retain the selected tools. Node initializes the session and exposes the selected Workbench
distribution to nested shells without exported Bash functions. Commands supplied after `--` retain their literal
arguments.

The reference automation still uses POSIX utilities and requires Bash and Node; automatic interactive-shell selection
does not remove these tool dependencies. The supplied references also include Git. Direct language commands outside
Workbench use the current shell's tools. Opening a Workbench shell never changes the parent shell or `.envrc`.

### Agent command execution

Agent commands can use tools directly when their environment is already correct. An agent launched from a configured
shell may inherit its exports, but changing directories in a noninteractive subprocess does not trigger direnv's prompt
hook, even when the hook is installed and approved.

Run configured gates through `workbench check`. For other commands, `workbench shell --path ROOT -- COMMAND ...` selects
the root's environment, tools, and storage. It is a convenience when that environment is not already established; direct
commands remain valid with the correct environment. Reading and editing files needs no environment wrapper.

For an already configured and approved direnv hook, `direnv exec ROOT COMMAND ...` explicitly loads its exports without
an interactive prompt. The generated hook exports storage paths only; tool selection still applies. Direnv activation
alone does not establish that a native command is using the selected Nix/Guix tools.

Guix uses `manifest.scm` in each check root. Its `channels.scm` completely replaces the project-root default when
present; otherwise Guix uses the project-root pin. Both Nix modes need `flake.nix` and `flake.lock`: `nix` uses the host
CLI, while `nix-docker` uses Docker and the pinned `checks.nix_docker_image`. The latter is an explicit check/CI mode,
rather than an interactive development selection. Docker checks use an ephemeral project copy; checks with the same root
and environment share one session, preserving setup results. Copies omit dependency and build caches; the Nix store is
cached in a Docker volume keyed by the image digest. Each root's owned build cache is mounted separately, with host
ownership restored after execution. Temporary Git snapshot checks discard their build caches on completion. Each root's
`coverage/` reports are exported back to the checkout, including on check failure. Explicit build, release, and
formatting runs therefore require native, Guix, direct Nix, or a Dev Container. Environment pin updates remain
human-initiated.

Host checks verify exact versions from `.node-version`, `rust-toolchain.toml`, `.python-version`, `.go-version`,
`.llvm-version`, and `.tool-versions` when present in the check root. Each `.tool-versions` line names a standalone tool
and its exact version; checks inspect its `--version` output. A mismatch fails before the command runs. The
`{packageManager}` command prefix reads the exact package-manager selection from `package.json`, so check definitions do
not repeat its version. Workbench bootstraps that manager with `npm ci` using the committed manifest and lockfile in
`scripts/package-manager/`. npm verifies the recorded package integrity hashes and runs `npm audit signatures` before
activation; bootstrap lifecycle scripts are disabled. An offline version probe must also pass before activation. The
installation lives under `package-managers/` in Workbench's platform cache. pnpm's wrapper cannot download a fallback
native binary. A different package-manager selection requires a matching bootstrap lock; a complete project-owned
`workbench/package-manager/` directory in the language root replaces the shared bootstrap definition. Generate its lock
with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` in that directory and review the hashes.

Guix and Nix use their own pinned toolchains as explicit compatibility targets. They may differ from host pins; all
environments share language dependency lockfiles. Checks report actual tool versions inside the selected environment.
Python checks explicitly use its selected interpreter and disable automatic interpreter downloads. Versions supplied by
one environment are not silently replaced with another environment's tools.

Setup detects languages and reports recommended roles, but does not guess an existing project's commands. Add
`[[check]]` entries before treating setup as complete. A project that needs only structural validation explicitly sets
`allow_empty = true` under `[checks]`; otherwise a full run with no configured commands fails.

A command may invoke plain language tools, an xtask, or another project runner. Workbench orchestrates the command but
does not reproduce its implementation. `workbench check --list` shows configured roles and language recommendations;
`workbench pre-commit` validates Workbench structure and runs the commit stage. CI uses `check --stage ci`.
`workbench check --role ROLE` runs that role with its root's setup; use it for focused checks, not a complete gate.
Setup precedes dependent commands once per root and environment session; automatic gates reject setup excluded by their
stage. `--project ID` selects a registered scope and its descendant roots; it cannot be combined with `--path`.
`workbench check --path PATH` selects a registered language root; add `--environment native|guix|nix|nix-docker` to
override the local selection. Without `--path`, an explicit environment applies to every configured check root.

The Git adapter materializes the complete staged index as a temporary tree, including unchanged tracked files and
excluding unstaged edits and untracked files. Every commit requires successful complete commit-stage evidence for this
tree using its staged launcher. Matching local gate evidence can be reused as described below. Filenames do not select
which checks are required. Source, dependency, toolchain, and executable configuration changes invalidate code evidence.
Record changes receive fresh validation without invalidating unrelated code evidence. Tools may also use their own
incremental caches. The hook materializes the proposed tree and invokes its source launcher when developing Workbench,
or the installed `workbench` command in consumers. Collection originals travel as tracked files; no executable submodule
is required.

Before the first commit, stage the project configuration and the files needed by its configured checks. A working
checkout's untracked `workbench/config.toml` and `workbench/projects.toml` do not configure its staged tree; an ADR-only
initial commit cannot pass this gate.

Compatibility inspection with `--staged` reads immutable Git contents from registered scopes and declared adopted
collections. Changes to those policies or their applicability require another compatibility review; unrelated code
staging does not. Exported collections and test fixtures are not active project policy.

If Node coverage collection encounters an invalid report, it fails and saves bounded metadata in
`coverage/collection-error.json` before removing scratch files. Diagnostics identify the report, byte count, and process
and thread IDs when available; they do not retain source contents.

Concise output presents coverage only for the selected check root; fixture reports remain in the full logs. Failures
show a bounded excerpt and the retained log path. Use `--verbose` to stream complete output. Staged coverage compares
against the owning checkout's committed baseline.

### Native tool environments

Native checks run with an explicitly constructed environment. Workbench supplies selected tool paths, build and package
storage, and CPU allocations. Language definitions in `languages/LANGUAGE/config.toml` declare accepted caller variables
with `pass_environment`; complete local language replacements own that list too. Each root receives only its registered
languages' settings. Agent/session identifiers and terminal settings are not passed to tools.

Built-in definitions retain SDK and package-manager locations, authentication, certificates, and network settings.
Ambient compiler selections, compiler/linker flags, header/library search paths, runtime options, and test options are
not inherited. For example, shell `CC`, `CXX`, `C_INCLUDE_PATH`, `LIBRARY_PATH`, `NODE_OPTIONS`, and `GOFLAGS` do not
change native checks. Put stable build choices in project configuration or check commands; explicitly forward caller
overrides only when they are intentional inputs. The resulting effective environment controls both execution and cache
identity.

Native tools inherit `LANG` for locale selection. `LC_*` and `LANGUAGE` overrides require explicit forwarding; agent
locale overrides therefore do not change checks run with the same `LANG` in a terminal. Projects testing other locales
can declare those caller inputs or select locales within their tests.

Project-specific inputs can be forwarded explicitly:

```toml
[checks]
pass_environment = [ "APPLICATION_MODE", "SERVICE_ENDPOINT" ]
environment_files = [ "${HOME}/.config/company/build.toml" ]
```

Names are literal, without patterns. Forwarded values are inherited from the caller; an unset variable remains absent,
and an empty value remains empty. Workbench's selected toolchain and required storage settings remain authoritative.
`environment_files` paths are project-relative or absolute and may reference `${NAME}` from the tool environment. Their
contents, including whether a file is absent, become cache inputs. File contents and environment values are never
printed in cache diagnostics.

The default tool search path uses selected SDKs and resolved host utility locations. Unrelated caller `PATH` entries are
omitted. A project needing additional executable search paths can explicitly forward `PATH`; the resulting path then
contributes to cache identity. Prefer declaring tools or using explicit executable paths.

On Windows, checks prefer the selected Git installation's native tools and MSYS utilities. Git's launchers prepend these
paths for hooks; selecting them for ordinary checks too avoids switching between Git and a separate MSYS installation
when committing.

Common selected Git, npm, uv, Cargo, Maven, Ruby, certificate, and PHP configuration files are fingerprinted. Declare
additional configuration and indirectly referenced files with `environment_files`. This does not isolate filesystem or
network access; use fresh checks when relevant external inputs cannot be identified. Nix and Guix retain their managed
environments and currently run fresh.

### Reusing successful checks

`workbench pre-commit` and the commit phase of `workbench check` save successful native gates in the selected user cache
storage. Repeated working-directory runs and the commit hook reuse that evidence when their code inputs, selected
checks, tools, and environment match. Security checks, together with their required setup, run fresh on a cache hit.
Reuse reports cached and refreshed check counts and the original verification time. Use `workbench check --no-cache` to
run fresh and replace the saved evidence. Cache misses report changed input categories and, when available, changed
environment variable names from the prior result, without their values; `--verbose` also reports lookup time and the
result location. CI and explicit role operations always run fresh.

Concurrent gates for the same checkout sharing the Workbench user cache wait for the active gate, including working-tree
checks and Git's staged snapshots. After waiting, each caller validates its selected tree and rereads the check plan and
inputs. Matching successful evidence can then be reused; changed inputs require fresh checks. Failed or canceled gates
supply no new success evidence. `--no-cache` also waits for ownership and then runs fresh. Different checkouts have
independent queues. A wait that exceeds 30 minutes fails with the lock location for inspection.

The source fingerprint conservatively covers the whole project; it does not infer which files affect each check. The
source inventory includes tracked files and non-ignored untracked files, with contents and executable modes. Project
records and sidecars, adopted collections, charters, record/source maps, generated `AGENTS.md`, and each registered
root's `coverage/coverage-summary.json` are excluded by default. Test-owned fixtures remain inputs, as do executable
files such as `workbench/config.toml`, `projects.toml`, `automation.toml`, and `quality.json`. Record/map validation,
required approvals, and policy compatibility remain independent of cached checks. Executable README examples retain
their evidence with unchanged code and documentation inputs; restoring their build products is unnecessary on a hit.

Declare record material deliberately used by a build or test under `[checks]`:

```toml
[checks]
inputs = [ "workbench/experiments/EXP-00/driver.py" ]
```

Entries are literal project-relative file or directory paths; directories include their descendants. Explicit inputs
also include otherwise ignored files. Missing inputs become part of the inventory when created. Symlinks are not
permitted in explicit input paths. Staged snapshots use their own files, never unstaged contents in the owning checkout.

The key also covers committed coverage baseline contents, Workbench distribution, resolved command and tool executable
contents, tool version probes, host identity, effective tool environments and selected configuration files, storage
selection, and CPU/job allocation. Environment values contribute only to the hash; saved results do not contain them.
Input lookup reads source bytes rather than trusting modification times on network filesystems.

Failed or interrupted gates do not save success. Inputs are checked again after execution; code input edits made during
a gate prevent that run from being cached. Updating an excluded generated summary does not invalidate code evidence. The
message identifies changed input categories without exposing source contents or environment values. Damaged results
trigger fresh verification. Human record approval, local policy compatibility, and structural validation remain separate
from cached command evidence.

Managed environments, projects without a usable Git inventory, initialized submodules, and unsupported source links
currently run fresh. Use `--no-cache` when checks depend on additional external state. Reuse proves the earlier check
outcome; it does not restore deleted build products or reports. Explicit build/release roles still execute their work.

`workbench cache` includes saved check results and retained logs; `workbench cache prune` removes them along with owned
build products. Active runs are protected, and installed dependencies require `--dependencies`.

Commit-message modes, shared prefix restrictions, width settings, and Git hook enforcement are documented in the
[contributing guide](contributing.md#commit-messages).

The review gate protects charters, ADRs, experiments, hardware environments, and supporting files beside those records.
Humans approve exact staged changes with `workbench review`. Ordinary implementation and configuration changes do not
require a review receipt. Human approval is still required before weakening quality checks under ADR-B.

Advisory roles run in CI and can be requested with `workbench check --role advisory`. They query OSV using exact npm,
Cargo, uv, Go, RubyGems, Packagist, and Maven dependency identities. Network failures or incomplete responses fail the
check. Findings name the locked package and version, link to the advisory, and include its description, severity, and
fixed release boundaries when that metadata is available. Missing advisory details never suppress a finding. Findings
identify locked inputs, not proven exploitability; fix or review them without weakening the check. Distribution bundling
requires each included package's declared SPDX expression in `[licenses].allow` and retains its license notice. This
policy covers dependencies included in Workbench's distributed executable; it is not a license audit of system packages
or every development dependency.

## Daily commands

`languages/<id>/automation.toml` defines each language's reusable commands under `[[command]]`, including gate checks
and manual build, release, formatting, and cleanup operations. `[[check_suite]]` selects these definitions for a
registered language root; command roles and stages control when they run.

`manifest.scm` lists the development tools. Select it explicitly for local development; Workbench and `.envrc` do not
load Guix automatically. Optional [direnv integration](adoption.md#optional-direnv-integration) exports storage settings
for interactive use and loads ignored `.envrc.local` additions. This repository also adds `bin/` to `PATH`.

The optional static top-level Makefile delegates to Workbench configuration. `make` or `make build` builds all
configured roots; `make check` runs the commit gate followed by online checks when reachable; `make pre-commit` runs
only the commit gate; `make test` runs ordinary tests; `make coverage` runs instrumented tests and enforces floors.
`make release` prepares local release artifacts without tagging or publishing. `make fmt` writes formatting changes,
`make lint` runs lint checks, and `make help` lists targets. Release, formatting writes, and cleanup are manual-only
operations. Setup adds this Makefile only when one is absent; it preserves existing consumer files.

Workbench and its TypeScript, JavaScript, and React examples lint source, tests, scripts, launchers where present, and
ESLint/Vitest configuration. Strict typed presets are supplemented with correctness rules for comparisons, callbacks,
throws, and dead assignments. Unused lint suppressions fail. Focused tests are rejected by lint and by Vitest, including
local runs. Prettier owns layout; lint rule details remain in each project's standalone configuration.

Select a project and descendants with `make build/service` or `make build PROJECT=service`; the same patterns support
check, pre-commit, pre-push, test, coverage, release, fmt, lint, clean, and distclean. Select exactly one language root
with `make build ROOT=examples/languages/rust`. Adding projects or roots requires no Makefile edits.
`ENVIRONMENT=native|guix|nix|devcontainer` overrides the local environment. Multiple requested Make targets run
sequentially. The direct Workbench CLI remains available without Make; the reference-directory Makefiles are static
wrappers selecting their own root.

Inspect the same resolved plan with `workbench check --list`: the table lists the selected root, role, environment,
check, and definition source. `--all` adds excluded checks and their reasons; `--json` also includes commands. Both
imply `--list` and never execute checks. Selection flags match execution, including `--stage ci` and `--role test`. A
focused role includes its setup but skips structural validation. `make pre-commit` and `workbench pre-commit` run
complete commit gates. `make check` and `workbench check` additionally attempt online checks.

## Check output

Independent check roots run concurrently within the user's `execution.max_jobs` and the available CPU budget. Ancestor
roots finish before descendants start unless an applicable `check_order` rule permits setup overlap. Environments for
the same root and checks within each group run in order. Setup and dependent checks retain a shared shell and build
lock. Use `workbench config set execution.max_jobs 1` for serial execution; add `--scope local` for this checkout alone.
`execution.cpus_per_job` or `WORKBENCH_CPUS` caps each worker's allocation. Automatic allocation gives the root most of
the CPU budget while reserving space for explicitly overlapping example roots. Each active group keeps its assigned
budget until it finishes; total assigned CPUs and active group count bound admission. Single-root runs use the full
available budget. `--list` and `--json` show the resolved ordering and allocations. See [CPU budgets](execution.md).
Cleanup runs serially. Failure stops new admission and lets active groups finish. Ctrl-C cancels active commands, stops
subsequent steps and queued groups, and waits for shutdown and cleanup before releasing locks, tool leases, and
disposable checkouts. Cancelled gates exit with status 130 and never save successful check evidence.

Canceling a waiting command leaves the active gate and other waiters running. Workers also stop their commands if their
coordinator disappears. A later gate can recover an abandoned lock only when its recorded local owner and all tracked
workers or command groups have exited. Foreign, damaged, incomplete, and otherwise uncertain ownership is preserved for
inspection; elapsed time alone never makes a lock safe to remove.

Interactive terminals retain completed tasks with their runtimes and redraw a bounded list of active tasks with
continuously updated elapsed times. The final count includes the total runtime. Redirected output prints start and
completion events without cursor controls. Failures name the check and display bounded diagnostics with a link to its
full log. After the active display finishes, coverage changes and advisory slow-test warnings appear together by check
root. Use `workbench check --verbose` for full streamed command output, or `WORKBENCH_VERBOSE=1 git commit` for verbose
pre-commit checks. Native command logs are retained in local cache storage and reported with the run, including for
disposable pre-commit checkouts.

Each executed run writes versioned `results.json` beside its logs, including completed checks, pending work, failures,
cancellation, durations, and structured coverage and slow-test details. `workbench check --report PATH` additionally
writes one JSON document covering both phases of a combined gate. It requires a new destination and runs checks fresh;
an existing file is never replaced. `--json` continues to describe the plan without execution and cannot be combined
with `--report`.

The external document has `version: 1`, `kind: "workbench-check-report"`, `success`, a bounded `error` message on
failure, and a `runs` array. Each run has `version: 1`, `kind: "workbench-check-run"`, an ID, start/finish timestamps, a
status, its retained `logs` directory when allocated, a bounded `error` message on failure, and `checks`. Checks include
their name, role, root, environment, status, duration in milliseconds when started, and `details`. Check statuses are
`pending`, `running`, `passed`, `failed`, or `cancelled`; final run statuses are `passed`, `failed`, or `cancelled`.
Detail records have `version: 1` and kinds `coverage`, `coverage-unavailable`, or `slow`; coverage contains current and
available baseline totals, and slow records contain scope, name, elapsed seconds, and advisory threshold seconds.
Reports retain up to 32 details per check and 16 KiB per record, count excess records in `omittedDetails`, and report
omissions visibly. Human-readable coverage tables and warning text are presentations of these records, not report
parsing interfaces. Full retained logs remain available for diagnosis.

## Review receipts and coverage evidence

Run `workbench review` in a terminal to inspect protected staged changes using Git's colored diff and configured pager,
then answer the approval prompt. Changed charters require a separate confirmation of human authorship. Declining or
interrupting the review records no new acknowledgment. `workbench review --plain` displays an uncolored diff without a
pager and uses a line-oriented approval prompt. `NO_COLOR=1` disables diff color independently. See
[terminal presentation](tooling.md#terminal-presentation) for saved preferences and environment selection. Changes to
protected staged contents during review require another review. Redirected input or output displays the diff without
offering approval.

Project/local policy compatibility is reviewed separately. An agent may inspect both policy sets and acknowledge their
compatibility, referring conflicts to the human. Record approval does not acknowledge compatibility, and compatibility
review does not approve protected records. See the [collection guide](collections.md#local-context-and-compatibility).

The local receipt at `git rev-parse --git-path workbench/review.json` binds acknowledgment to exact staged content and
is separate for linked worktrees. Ordinary code edits do not invalidate it. Receipts are cooperative guards, not
signatures or proof of authorship. Agents must not supply human approval.

`[[check]].warn_seconds` enables advisory elapsed-time reporting. It includes everything in that command, including
build/setup. Exceeding it never kills the command or changes a successful result. Interpret warnings using host
resources and build context. Coverage variants omit this advisory cap; floors remain enforced by each language's
configured tool.

Workbench's coverage runner and the Rust, C/C++, and Go check adapters read `workbench/quality.json` relative to their
language root. It owns coverage floors; C/C++ and Go also use its advisory `slow_test_seconds`. Python and the
TypeScript reference keep these settings in `pyproject.toml` and `vitest.config.mjs`; Rust's slow-test settings live in
`.config/nextest.toml`. Each value has one authoritative source.

The root coverage runner retains test outcomes, failure diagnostics, and timings in ignored `coverage/tests.json`.
Detailed merged unit and CLI coverage lives in ignored `coverage/coverage-final.json`; the test report omits its
duplicate map. Ignored `coverage/timings.json` records elapsed time for workspace preparation, tests, subprocess
coverage processing, reporting, and cleanup, including raw-report and converted-script counts. The subprocess total
includes its source-map, report-processing, and conversion phases; do not add it to those phases. These observations
help distinguish slow tests from expensive coverage processing and do not change acceptance thresholds. Per-phase times
also appear in the retained coverage-check log, including phases completed before a failure. Each root's normalized
`coverage/coverage-summary.json` is the only coverage report retained in Git. It uses relative source paths and stable
formatting. `workbench/quality.json` remains committed check policy.

`make coverage` presents totals and per-file changes against the summary committed at `HEAD`, including covered/total
counts and percentage-point differences. Native CI coverage checks use the pull request base revision, or the previous
revision for a push, and append the comparison to the GitHub job summary. The checkout fetches history for these
comparisons. `WORKBENCH_COVERAGE_BASE` selects another baseline revision explicitly. A missing summary or unavailable
revision is reported as an unavailable comparison; it never implies zero coverage or a successful comparison. The first
run establishes a summary to review and commit. Floors are still enforced independently of the comparison. Other
configured coverage commands need a supported report format to participate; built-in references cover Vitest,
coverage.py, LLVM coverage, and Go profiles. Comparison data and detailed reports are excluded from runnable release
packaging.

## Project-owned release verification

When a native CI target has a `release` role, both hosted and local CI invoke a separate `release-verify` role before
retaining its artifacts from `dist/`. Declare that check in the consuming project's automation; it should exercise
copied artifacts outside the checkout. A missing verifier fails the release phase. For example:

```toml
[[check]]
name = "Verify packaged application"
role = "release-verify"
path = "."
command = ["node", "scripts/verify-release.mjs"]
stages = []
```

The Workbench examples explicitly select their sample artifact verifier. That verifier is specific to the sample APIs;
consumers supply their own command. Named release profiles independently declare their `prepare` and `verify` commands
in project configuration. See the [profile guide](profiles.md).

# Checks, coverage, and human review

[Workbench overview](../../README.md). Commands assume your project root; `workbench` denotes the executable in your
pinned distribution.

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

## Daily commands

`languages/<id>/automation.toml` defines each language's reusable commands under `[[command]]`, including gate checks
and manual build, release, formatting, and cleanup operations. `[[check_suite]]` selects these definitions for a
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

Workbench and its TypeScript, JavaScript, and React examples lint source, tests, scripts, launchers where present, and
ESLint/Vitest configuration. Strict typed presets are supplemented with correctness rules for comparisons, callbacks,
throws, and dead assignments. Unused lint suppressions fail. Focused tests are rejected by lint and by Vitest, including
local runs. Prettier owns layout; lint rule details remain in each project's standalone configuration.

Select a project and descendants with `make build/service` or `make build PROJECT=service`; the same patterns support
check, test, coverage, release, fmt, lint, clean, and distclean. Select exactly one language root with
`make build ROOT=examples/languages/rust`. Adding projects or roots requires no Makefile edits.
`ENVIRONMENT=native|guix|nix|devcontainer` overrides the local environment. Multiple requested Make targets run
sequentially. The direct Workbench CLI remains available without Make; the reference-directory Makefiles are static
wrappers selecting their own root.

Inspect the same resolved plan with `workbench checks`: the table lists the selected root, role, environment, check, and
definition source. `--all` adds excluded checks and their reasons; `--json` also includes commands. Selection flags
match `checks run`, including `--stage ci` and `--role test`. A focused role includes its setup but skips structural
validation. `make check` and unqualified `checks run` remain complete commit gates.

## Review receipts and coverage evidence

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
Detailed merged unit and CLI coverage lives in ignored `coverage/coverage-final.json`; the test report omits its
duplicate map. Each root's normalized `coverage/coverage-summary.json` is the only coverage report retained in Git. It
uses relative source paths and stable formatting. `workbench/quality.json` remains committed check policy.

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
heavy = true
```

The Workbench examples explicitly select their sample artifact verifier. That verifier is specific to the sample APIs;
consumers supply their own command. Named release profiles independently declare their `prepare` and `verify` commands
in project configuration. See the [profile guide](profiles.md).

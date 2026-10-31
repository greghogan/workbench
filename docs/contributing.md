# Develop Workbench

[Workbench overview](../README.md). Commands assume your project root; `workbench` denotes the executable in your pinned
distribution.

## Commit messages

Project-owned `workbench/config.toml` selects commit-message policy independently of adopted records. Setup writes:

```toml
[commit]
style = "conventional"
subject_width = 50
body_width = 72
```

| Mode           | Example                           | Requirements                                                      |
| -------------- | --------------------------------- | ----------------------------------------------------------------- |
| `conventional` | `fix(parser): reject empty input` | Type, optional scope and `!` breaking marker, then a description. |
| `plain`        | `Fix empty input handling`        | An ordinary subject without a required prefix.                    |
| `area`         | `parser: reject empty input`      | A subsystem label followed by a description.                      |
| `unrestricted` | Any project-defined format        | Workbench skips message-format checks.                            |

The first three modes require a nonempty subject without surrounding whitespace, a blank line before the body, and the
configured subject/body widths. Widths count visible graphemes, including combined characters and emoji. Git comment
lines are excluded from body-width checks. Generated merge, revert, `fixup!`, and `squash!` messages are exempt.
`unrestricted` still requires valid configuration.

Conventional types and area labels share one optional `commit.prefixes` allowlist. Conventional types classify changes;
areas identify project subsystems. An explicit list replaces the mode's defaults and compares prefixes
case-insensitively. With no list, `conventional` accepts `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, and `revert`; `area` accepts any valid area label. Valid prefixes use ASCII letters, digits,
dots, underscores, slashes, or hyphens, and cannot begin with a slash or hyphen. Conventional scopes retain lowercase
identifier syntax. Plain and unrestricted modes ignore a valid prefix list.

For example, select additional Conventional Commit types by declaring the complete list, or select area labels:

```sh
workbench config set commit.prefixes '["feat", "fix", "docs", "deps"]'
workbench config set commit.style area
workbench config set commit.prefixes '["parser", "storage", "docs"]'
workbench config unset commit.prefixes  # Restore the selected mode's defaults.
```

The installed `commit-msg` hook invokes `workbench commit check MESSAGE_FILE`; the same command can check a prepared
message directly. Workbench enforces syntax and layout; agents review the message's meaning and agreement with the
changeset. Projects selecting `unrestricted` can retain their own message validator.

## Harness verification

Run the optional harness integration tests when Codex or Claude Code is installed:

```sh
node scripts/check-harnesses.mjs codex claude
```

Select either harness by passing only its name. These tests are separate from the normal gate and need no credentials or
inference service: actual CLIs communicate with a local model stub. Temporary Git repositories and isolated application
homes exercise root and nested sessions, automatic `AGENTS.md` loading, skill discovery and invocation, explicit-only
visibility, and disabled session persistence. No instruction file is injected through the prompt and no `CLAUDE.md` is
created. User settings, skills, credentials, and conversation history are not copied. Fixtures and application state are
deleted on exit. Output reports the tested version without imposing a version gate. These tests verify harness
integration, not a model's workflow judgment.

Evaluate skill behavior separately with real inference:

```sh
node scripts/evaluate-skills.mjs codex --output /tmp/workbench-skill-results
# Select cases or a model explicitly; Claude accepts the same case names.
node scripts/evaluate-skills.mjs claude review refactors --output /tmp/workbench-claude-results
```

The output directory must be new. Cases cover immediate changeset repair, advisory refactoring without edits, a targeted
dependency upgrade, audit continuation from a task, existing-project adoption, local commit/push through installed
hooks, failed-check recovery, and a human-policy handoff. The first four use the supplied skills; the remaining workflows
do not enable a named skill. Deterministic positive and negative tests exercise outcome checks in the normal test gate
without running an agent. Real-model runs are optional, explicitly selected evaluations. Use `--model NAME` to select a
model explicitly.

These optional evaluations use paid or subscription inference and, for dependencies, the public package registry. Codex
uses `OPENAI_API_KEY` or a temporary copy of its authentication file; Claude requires `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`. Only credentials are passed into disposable application homes; user settings, personal
skills, and conversation history are not copied. Each model invocation has a five-minute limit. Temporary repositories
and application state are removed on exit; intentional evaluation evidence stays in the selected output directory. Run
on a trusted development host: disposable directories and disabled history are not a general security sandbox.

Outcome checks verify concrete behavior and scope preservation. The advice-only scenario checks file preservation;
the handoff scenario checks a nonempty deliverable and unchanged project policy. Neither establishes advice quality.
Reports retain replies, diffs, new files, an optional `assessmentPrompt`, and model, harness and skill-content identities.
They explicitly state that qualitative assessment was not performed. Passing these checks does not establish useful
advice, complete review, or general adherence to a skill.

## Build and distribution

Author CLI code in `src/*.ts`, tooling and reference helpers in `.mts`, and the CommonJS bundle loader in
`bin/bundle-runtime.cts`. Tests and their fixtures use `.mts`. Edit the authored sources. Run `pnpm run tooling:build`
to regenerate JavaScript, browser assets, and copied reference assets. Runtime and consumer JavaScript stays tracked;
parity checks reject stale tracked outputs. `scripts/tooling-artifacts.mts` owns the tracking and emission policy.
Development-only JavaScript, including build, test, lint, packaging, and maintenance helpers, is ignored and regenerated
by `pnpm run setup` or `pnpm run tooling:maintainers`. Configured dependency setup and the relevant package scripts
prepare these outputs automatically without repairing tracked files during verification. The tooling builder runs from
its TypeScript source on the declared development Node version. Setup also runs from TypeScript, using the committed
runtime helpers to install locked dependencies before compiling development helpers. These outputs live beside their
sources and are regenerated on each preparation; no checksum manifest is maintained. Packages omit generated development
helpers and include the runnable bundles and compiled helpers used by consumers. Fresh Git installations launch the
handwritten `bin/workbench.mjs` and committed bundles without development setup.

`tooling:build` also updates the generated development-output block in `.gitignore`. `build-tooling.mts --check`
verifies tracked outputs and that block; `--maintainers-only` prepares ignored development outputs without repairing
tracked files. These two flags cannot be combined, and unknown options are rejected. Artifact roles, emitted paths, and
transform/bundle choices have one authority in `scripts/tooling-artifacts.mts`. Bundled helpers resolve to authored
sources so stale generated dependencies cannot enter a fresh bundle. Bundle construction is shared by building and
verification; publication closes staged candidates first and activates compressed payloads before their loaders.
Verification also checks the emitted runtime dependency graph and literal `{workbench}` paths in language templates.
External package imports must name Node builtins or declared runtime dependencies; development dependencies alone do not
make a package available to consumers. Runtime helper bundles include their locked parser dependencies. Strict lint
applies to their authored TypeScript; generated bundles also contain upstream code and are verified through parity and
isolated execution.

This repository configures pnpm, Prettier, type-aware ESLint, TypeScript 7 type checking, Vitest, bundle parity, and
shell checks. Rust tools in the root development manifest support the Rust reference checks; the Workbench CLI itself
runs on Node.js. The reference's `rust-toolchain.toml` selects its compiler when using rustup, while its `Cargo.toml`
declares its minimum Rust version. `pnpm run bundle:build` rebuilds the bundle; `pnpm run bundle:check` verifies the
checked-in bundle without modifying it. Shipped bundles contain compressed, minified JavaScript without source maps.
Small CommonJS launchers decompress them in memory using Node, with no dependency installation or expanded files on
disk. `bundle.compression` is a project build setting in `workbench/config.toml`: `brotli` (default), `zlib` (gzip), or
`zstd`. Set it with `workbench config set bundle.compression zstd`, then rebuild the distribution. Consuming projects
use their pinned artifact's format; changing their configuration does not recompress an existing dependency. All three
formats use Node's built-in decompression; Zstandard needs a runtime with built-in Zstandard support, available in every
selected Node CI version. Coverage builds unminified bundles with inline source maps in a temporary workspace, reuses
installed development dependencies, and removes that workspace afterward. Coverage reports refer to the original source
paths. Rust, Python, TypeScript, JavaScript, Java, Ruby, PHP, C, C++, and Go have executable language references.

## Repository maintenance

Workbench's development inputs, an installed Workbench release, and a project's adopted collection pins have separate
update workflows. The maintainer scripts below operate on this repository's manifests, locks, native acquisition
catalogs, CI actions, and environment definitions. They do not select an installed release or update adopted
collections.

Generate a plan from authoritative registries and upstream release feeds, then apply that exact plan:

```sh
pnpm run maintenance:plan --output /tmp/workbench-maintenance.json
pnpm run maintenance:apply /tmp/workbench-maintenance.json --environments --refresh-locks --lock-scope selected
```

Choose a writable plan path outside the checkout; these examples use Unix `/tmp`. Both commands also run directly as
`node scripts/maintenance/main.mjs plan` and `node scripts/maintenance/main.mjs apply`. The plan command only reads
project files and upstream metadata. `--kind dependencies toolchains` narrows discovery; `environments` includes
Nix/Guix pins and `automation` includes recognized CI action and container-base pins. Environment changes require an
explicit human request and the apply command's `--environments` option.

The plan records each authority, current and selected versions, release references, constraints, and unavailable
sources. Apply rejects changed inputs, unknown targets, incompatible tool lines, and downgrades. It reacquires selected
release metadata, preserves aliases and dependency groups, and retains TOML comments. Native recipes preserve their
platforms and authentication requirements. Windows component directory pins require separate servicing review; their
directory names do not track serviced binary versions. Fixed flake revisions and paired-browser acquisition constraints
are reported explicitly.

Without `--refresh-locks`, apply changes declarations and acquisition metadata only. Lock refresh defaults to changed
roots, including their dependent package managers; shared configuration changes select all roots.
`--lock-scope selected` also refreshes transitive locks throughout the plan's selected inventory. The command prints its
root and command selection before publishing declarations. Tools are prepared through verified native managers. Maven
collects fresh checksum indexes in every configured environment, merges them deterministically without old entries,
rejects conflicting hashes, and only then regenerates managed inputs.

Plans use schema version 2 and record structured target locations and available immutable publication identities. Apply
reacquires the selected release and rejects changed action commits, distribution integrity, image digests, or native
acquisition evidence. Discovery chooses the newest eligible stable release, reporting any newer blocked line separately.
Bounded feed pagination reports incomplete discovery explicitly.

Maintenance operations serialize per checkout. Each declaration replacement is atomic and rechecks input hashes; a
publication failure identifies any files already published and preserves conflicting work. Reconcile an interrupted
partial declaration batch and generate a new plan. Lock refresh retains checkpoints beside the plan as
`<plan>.progress.json`. After reviewing an interrupted refresh, resume with the same scope:

```sh
pnpm run maintenance:resume /tmp/workbench-maintenance.json --lock-scope selected
```

Resume verifies the project, original plan, declarations, Go support boundaries, and checkpointed inputs. It skips
completed commands and refuses intervening edits. A failed manager command can be retried explicitly; no operation
stages, commits, or resets files. Finish by reviewing constrained and unavailable targets, running validation and the
affected configured gates, and reviewing the complete diff. Language update skills retain guidance for migrations,
provenance, compatibility, and verification; the maintainer scripts handle source discovery and mechanical updates.

## Browser presentation

The local UI composes pages, navigation, forms, cache tables, and source differences as server-rendered TypeScript TSX
under `src/web/`. Pinned Preact renders the shared document frame in `src/web/page-document.tsx`; browser controllers
remain separate TypeScript modules. Components return JSX elements and ordinary text values. Serialize HTML at the
document or live-update response boundary. The Markdown renderer in `src/web/markdown-view.tsx` owns the single raw HTML
boundary for escaped MarkdownIt output; document text never enters it directly. Project-owned CSS lives under
`src/web/styles/`, composed by `src/web/style.css`. Keep the shared palette, fonts, spacing, and layout values in the
stylesheet's design tokens. Document typography and source differences retain dedicated rules. Preserve keyboard focus,
reduced motion, and forced colors when changing presentation.

Strict JSX accessibility linting includes useful checks beyond the preset, with Preact's `for` attribute mapped
explicitly. Keep exceptions local and explain the actual semantic limitation. Static linting supports the browser and
human accessibility assessment. ESLint restricts raw HTML insertion to the Markdown renderer. Typed mutation forms own
CSRF, source context, required target/version fields, and action-bound editable controls; server validation remains
authoritative. Form protection follows the action, and route ownership keeps global destinations outside project
prefixes. Compile-only fixtures verify invalid form and route declarations are rejected. Record views resolve
capabilities and comparison choices before rendering. Snapshot-owned reference indexes avoid repeated catalog scans.
Cache views prepare only their displayed row groups; initial documents and live updates serialize the same row nodes at
explicit boundaries. Inventory ownership and version-family indexes are prepared once per presentation. Presentation
tests use the shared owned-DOM fixture and assert DOM behavior and native label associations rather than HTML attribute
ordering or entity spelling.

Static JSX lint fixtures exercise the same shared rules without starting TypeScript's project service; a separate
configuration assertion verifies production enforcement.

`pnpm run tooling:build` embeds the minified CSS and compiled browser controllers in `src/web/assets.ts`; edit their
sources rather than the generated module. The existing bundle build ships these assets offline without a CSS framework
or separate frontend service. Generated-asset verification detects stale CSS as well as stale browser code.

Browser controller race tests use pinned jsdom as a development dependency. Its selected version supports the existing
Node runtime matrix; it is absent from application bundles. Browser scenarios use the separately pinned Playwright
driver and a managed Chrome Headless Shell. Both are development dependencies; running Workbench needs neither.

## Browser verification

Build the bundles, install the declared tools, then run browser integration in the selected environment:

```sh
workbench tools install --path .
workbench check --path . --role browser
```

The helper creates isolated projects and storage, starts the bundled service on a free loopback port, and runs named
scenarios covering search, source differences, stale drafts, staged review, collection preview/application, live
refresh, keyboard focus, and desktop/narrow layouts. Review actions affect only the disposable fixtures. It retains
screenshots and diagnostics in the printed directory; the direct helper accepts `--output NEW_DIRECTORY` and an optional
`--browser PATH` override. Each scenario has its own project, storage, service, and browser. Use `--scenario NAME` in an
already prepared environment to rerun one named scenario; configured gates run every scenario. Ordinary checks never
download a browser. Native setup verifies the platform archive against its recorded digest; the engine version matches
the locked Playwright driver. Linux requires the declared browser runtime libraries and fonts, provided by CI
preparation and the native development container. Nix and Guix package the same engine with their own runtime closures
and fonts, without changing their channel pins. Their containers run Linux; native browser checks also target macOS
ARM64 and Windows x64. Browser checks run in CI and remain explicitly selectable locally. PDF scenarios verify
Workbench's links, response headers, exact bytes, ranges, and changed-content rejection, without inspecting a
browser-specific PDF viewer. These checks complement HTTP/service tests and do not establish complete Section 508
conformance. The accessibility scenario runs axe WCAG A/AA and best-practice rules across the dashboard, cache, search,
record, editor, diff, review, and collection pages, plus keyboard, enlarged-text, reflow, and presentation checks. Its
`accessibility.json` identifies the release digest, tool/browser versions, rule outcomes, and incomplete or unverified
criteria. Treat this as automated evidence, not a conformance assertion. Real NVDA, VoiceOver, or Orca evaluation
requires a supported headed assistive-technology environment and remains outside these headless browser checks.

A separate required Windows CI job exercises the disposable demonstration with NVDA and a headed Chrome for Testing
browser. Guidepup packages are exact development dependency pins; NVDA's archive version and SHA-256 come from the
locked Guidepup manifest. Chrome shares the `.tool-versions` browser version with the headless shell and has a separate
verified Windows archive recipe in `scripts/screen-reader-assets.json`. Browser updates must refresh both recipes.
Chrome for Testing does not advertise separate artifact authentication; the recipe records that limitation. The NVDA archive's
GitHub release digest agrees with the Guidepup manifest; no separate signature is advertised in that release.

After locked dependency setup and `pnpm run tooling:maintainers`, run `node scripts/prepare-screen-reader.mjs` on an
isolated Windows x64 desktop, then `node scripts/check-screen-reader.mjs --browser PATH --output NEW_DIRECTORY`.
The serial workflow checks spoken headings and form labels during search, charter editing and exact-file review,
while retaining transcripts, screenshots on failure, the tested release digest and software versions. It adds
interoperability evidence; its report does not claim complete Section 508 conformance. `--browser-only` can rehearse
the same browser actions with the existing headless shell on other platforms; its report explicitly contains no
screen-reader verification. These tools are development dependencies and are not included in the installed CLI.

Release verification extracts the archive and installs it through npm offline, then initializes and structurally
validates every bundled language starter outside the source checkout. This exercises the installed template assets;
native example gates and explicit consumer gate runs verify the corresponding compiled and interpreted checks.

## Consumer integration

The permanent consumer integration suite exercises the npm-installed package outside this checkout. Run it
independently:

```sh
node bin/workbench.mjs check --role integration --path . --environment native
```

It creates independent projects for all ten bundled languages, including separate C/C++ and JavaScript/TypeScript cases.
Each journey checks preview, initialization without SDK acquisition, nested application roots, paths containing spaces
and Unicode, pinned tool installation, the commit gate, and an actual commit with hooks enabled. It introduces a
compiling behavioral defect, requires application-test failure, restores the source, and verifies recovery and an
offline-mode rerun. Adoption preserves application files and custom checks, then runs the actual language suite with a
behavioral fault and recovery. Other cases cover repeated initialization, mixed-language roots, concurrent check gates,
cancellation, and retry. Fixture review receipts apply only to the shipped test charter in disposable repositories; no
project records are approved.

Once per run, installation scenarios invoke the actual `workbench` command through `PATH` (the native `.cmd` shim on
Windows). They exercise the release package in an isolated simulated system prefix, first installation of a user
launcher through real npm/Git acquisition, project revision selection from nested directories, and reuse of two cached
revisions after their source repository becomes unavailable. A missing offline revision must fail without falling back
to another executable. Git redirects a fixture HTTPS URL into a private local repository; Node networking is blocked.
The Git fixture combines the candidate's retained original source manifest with its prebuilt files, so accidental
installation lifecycle scripts or development-dependency acquisition fail under the network guard. It asserts the
selected repository, revision and directory through `workbench executable --json`. Literal-argument cases include
quotes, percent signs and shell metacharacters as well as spaces and Unicode; Windows CI also exercises the real command
shim independently. Homes, npm configuration, caches, launchers, and completion files are disposable. These tests
require no administrator access, external repository, published release, or changes to the invoking user's installation.

The same integration phase prepares a source-only developer checkout. A private Git repository captures working source,
including new files, without changing the caller's index or refs. Generated development helpers and volatile build
results are absent initially. The rehearsal verifies bootstrap execution, validation before and after locked dependency
setup, bundle parity, and unchanged tracked source. It runs in CI and explicit local integration, alongside the
installed consumer scenarios.

Use the underlying runner to select languages, retain reports in a new directory, or test an existing release candidate:

```sh
node scripts/check-consumers.mjs --language c --language cpp --output /tmp/workbench-consumer-check
node scripts/check-consumers.mjs --artifacts dist
```

Without `--artifacts`, the runner prepares a private package from the current source. It records the tested archive's
SHA-256, original source-manifest SHA-256, platform, Node version, suite/case/command lifecycle states and timings,
application-check reports, and complete redacted logs under `build/consumer-integration/run-*/`. Version 3
`results.json` checkpoints running work and records primary and cleanup failures separately. Its `installations` section
runs once, independently of compiler profiles. A failed prerequisite leaves dependent cases `blocked`, with their
prerequisite names in `blockedBy`; independent cases and profiles continue. Installation and compiler suites have
separate log directories under the run. Coverage checks preserve these reports, and CI copies fresh integration evidence
into its retained target reports even when a check fails. Temporary projects and their build products are removed,
including on failure. `--output` must name a new directory. Failures preserve diagnostic evidence and produce a nonzero
exit status.

Configuration, local collections, state and Git settings are isolated. The default run reuses verified tool and download
caches; Rust and Python installations use suite-owned cache locations. `--cold-cache` selects an empty tool cache and
requires enough disk space and connectivity for the selected SDKs. Offline cases enforce Workbench and package-manager
offline settings and block Node network connections. Prepared-image verification separately establishes operation with
networking disabled at the container boundary.

The normal commit gate includes fast initialization, failure and recovery regressions. The full integration suite runs
in CI once per native platform, before release preparation, and also runs in local `workbench ci` rehearsals. It remains
enabled with `--no-release`; alternate Node profiles retain their ordinary tests without repeating every SDK journey.

## Workbench release preparation

Release preparation and artifact verification already run in native CI. To verify a candidate locally after the
configured checks and consumer integration have passed:

```sh
pnpm run release
node scripts/check-release.mjs dist
node scripts/check-consumers.mjs --artifacts dist
```

`pnpm run release` builds the bundles and prepares `dist/workbench-artifacts/workbench.tar.gz` and `SHA256SUMS`. The
artifact verifier checks the checksum, extraction, npm installation and all language starters. The integration command
executes the complete consumer journeys against those exact candidate bytes. A clean committed source tree also supplies
the immutable repository/revision identity recorded in the package. Preparation performs no publication; publish the
verified archive and checksum through the project's chosen release channel and retain the integration report.

The archive contains the exact original source manifest as `workbench-source-manifest.json`. Candidate installation
tests read this retained copy, including when `--artifacts` refers to a package from another checkout; the invoking
checkout's manifest does not participate. The integration report records that manifest's digest alongside the archive
digest.

Compiler-profile comparisons use the same prepared archive and npm installation. On Windows x64, the default run also
exercises the C/C++ journeys with `mvsc`. Select explicit profiles by repeating `--compiler`, for example
`node scripts/check-consumers.mjs --language c --language cpp --compiler clang --compiler gcc` on Linux. Profiles run
sequentially, continue after independent failures, and share verified tool caches. Cancellation stops remaining work.
Package preparation receives an explicit output directory, and fixture receipt creation runs with an isolated child
environment. Integration helpers are loaded through their own private bundle rather than the package entry point.

Coverage scratch directories carry ownership records. Graceful cancellation drains owned children before deleting
scratch. Later runs reclaim marked abandoned scratch only after the local owner and registered child groups are
confirmed dead. Unmarked, foreign, incomplete, and active ownership remains untouched; age alone does not authorize
cleanup. Retained reports and redacted command logs are outside scratch and survive cleanup.

Coverage processing uses a bounded queue. Ready workers request the next report, reuse their source-map index, and
reduce completed reports immediately. Its admission interface accepts external capacity leases so it can join the
planned jobserver; the jobserver itself is not part of this change.

Cache inspection JSON uses `schema_version: 2`. Filesystem entries carry an explicit measurement state and omit unknown
byte values. An unavailable quantity is not a zero-byte cache. Cleanup approval binds selected identities, writer
generations, and protection state; publishing a new size estimate alone does not revoke approval. Cache size scans have
no elapsed deadline. Cancelling an inspection drains its subprocesses before releasing worker ownership.

The web service retries an unexpectedly exited read-only workspace worker three times with bounded backoff while serving
its last complete snapshot. After exhaustion, the freshness control offers an explicit retry. Invalid document contents
remain visible errors and do not trigger worker restarts. Mutations are never replayed automatically.

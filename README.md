# Workbench

Workbench keeps agentic-development records in ordinary versioned files and provides deterministic setup, routing, and
change gates. This repository develops Workbench. A consuming repository pins it at `.workbench/` and owns separate
records in `workbench/`. The checked-in JavaScript bundle needs Node.js 22.12 or newer; setup does not build or download
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

Project setup creates `workbench/config.toml`, `workbench/projects.toml`, and all record maps. It never writes a charter
or placeholder `AGENTS.md`. Checks cannot pass until each registered project has a human-written
`workbench/CHARTER.md`. Afterward, `workbench sync` derives the entire root `AGENTS.md` from the root charter, decision
routing, and selected standing ADR instructions. Existing hand-written agent guidance is preserved and must be moved
before sync can take ownership.

Setup configures Workbench's tracked Git hooks when doing so will not overwrite another hook path. These are ordinary
Workbench-owned `pre-commit` and `commit-msg` hooks; the project does not use the third-party `pre-commit` framework.
The Git adapter also adds the local citation-library pattern to `.git/info/exclude` without changing `.gitignore`.

## Projects and agent context

Register a subproject interactively with `workbench project add`, or noninteractively with:

```sh
workbench project add PROJECT_ID RELATIVE_PATH
```

The command creates its `workbench/` directory and maps but no charter or recursive `AGENTS.md`. One root `AGENTS.md`
provides standing context. Root maps route to subproject maps, and agents open narrower records when their work makes
them relevant.

`[[language_root]]` entries in `workbench/projects.toml` select a language and its relative check root independently of
record scopes. Select a workspace root when its build tool covers members; select independent roots when it does not.
Setup detects conventional manifests such as `tsconfig.json`, `Cargo.toml`, and `pyproject.toml`.
`workbench project languages` reports configured roots and detected manifests. For an empty TypeScript root,
`workbench language init typescript [PATH]` seeds the locked starter without overwriting existing files; projects may
then adapt it. Checks run project-configured commands, not a permanent comparison with starter defaults.

`workbench language list` shows supported languages and their executable reference projects under
`examples/languages/`; `workbench language check --all` verifies them. References carry the language's conventional
configuration and checks without pretending to be complete application templates. Their optional Guix and Nix files pin
equivalent host tools where each package set permits. Guix uses `channels.scm` with `manifest.scm`; Nix uses
`flake.nix` with `flake.lock`. Workbench never enters either environment automatically.

`workbench sync` activates only applicable Workbench-owned skills. Environment update skills are separate for Guix and
Nix and appear only when configured checks use that environment. Language skills follow registered language roots:
Codex discovers their union at the repository root in `.agents/skills/`, while Claude Code discovers applicable links
under each project's `.claude/skills/`. The links point to one canonical skill source in the pinned Workbench module;
Workbench never replaces a user-owned skill. Update skills do not change environment pins without a human request.

Backward compatibility is deliberately opt-in during initial development. Setup writes `compatibility.required = false`
to `workbench/config.toml`; only a human changes that Boolean to require compatibility. When enabled, the compatibility
ADR governs externally observable interfaces, persisted formats, protocols, and user workflows.

Architecture topics such as terminal interfaces, cloud adapters, and live services remain discoverable decisions. They
do not need selectors merely to suppress a short agent instruction. An ADR receives `Agent instruction:` only when a
non-obvious standing rule deserves root context.

## Records and maps

`workbench --help`, `workbench -h`, and `workbench help` list top-level commands. A group such as
`workbench citation --help` lists only its subcommands, while `workbench --help-all` prints the complete public command
tree. The built-in record types are decisions (`ADR`), tasks (`TSK`), experiments (`EXP`), environments (`ENV`),
citations (`CIT`), and releases (`REL`). For example:

```sh
workbench record add TSK "Implement parser"
workbench record open workbench:TSK-0
workbench sync
```

Use `record add` for ADR, TSK, and ENV records or for a manual CIT draft. Prefer `citation add` when an arXiv ID or DOI
is available. Use `workbench experiment start TITLE PROTOCOL_PATH` after an experiment protocol is complete. Task
records accept `--parent` and repeatable `--depends-on` scoped task references. The task map includes unfinished tasks;
maps for all other record types retain every record. A human-reviewed commit accepts a new or changed ADR; no acceptance
flag or prior approval step exists. A human stages changed ADRs to establish the review baseline; staging itself is not
acceptance. `AGENTS.md` is generated and needs no separate review.

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

`workbench feedback add TITLE` creates a local uncommitted feedback draft in the user's XDG data directory. Resolve it
with `workbench feedback resolve ID accepted|rejected EXPLANATION [--record REF]`; accepted feedback can link to a
project record when it becomes actionable.

Citation records are one-item CSL YAML bibliographies. Their main purpose is to retain enough metadata and source URLs
for a user to acquire papers that the project does not redistribute. Import metadata from an arXiv ID or DOI, fetch an
explicit direct source, or import a PDF obtained through a human browser flow:

```sh
workbench citation add 1706.03762
workbench citation fetch workbench:CIT-0
workbench citation sync
workbench citation import workbench:CIT-1 ~/Downloads/paper.pdf --source published
```

The first command performs network access for metadata. Fetch never bypasses authentication or CAPTCHA challenges.
Downloaded PDFs use source-specific deterministic names under the ignored `library/citations/` directory. A citation
may retain both published and arXiv sources, each with its own SHA-256 computed on fetch or import. A missing digest
means acquisition is pending; all zeroes mean the PDF was confirmed unavailable. The generated citation map indexes
bibliographic records rather than local files.

## Change gates

`workbench validate` validates Workbench-owned structure: the registry, records, maps, generated agent context,
documentation links and source coverage, and Markdown wrapping. The width is configured in
`workbench/config.toml`; `workbench format markdown PATH --write` performs an explicit conservative rewrite.

Project configuration binds portable roles such as `format`, `lint`, `test`, and `docs` to project-owned commands:

```toml
[[check]]
name = "web tests"
role = "test"
project = "web"
command = ["pnpm", "run", "test"]
heavy = true
```

`[checks].environment` chooses `none` (the default), `guix`, `nix`, or `nix-docker` for configured checks; a `[[check]]`
can override the choice. Guix needs `channels.scm` and `manifest.scm` in that project's check root. Both Nix modes need
`flake.nix` and `flake.lock`: `nix` uses the host CLI, while `nix-docker` uses Docker and the pinned
`checks.nix_docker_image`. Docker checks use an ephemeral copy of the project, so each command must be self-contained.
The Nix store is cached in a Docker volume keyed by the image digest.
Workbench reports missing definitions instead of silently falling back to host tools. Environment pin updates are
human-initiated.

A command may invoke plain language tools, an xtask, or another project runner. Workbench orchestrates the command but
does not reproduce its implementation. `workbench checks list` shows configured roles and language recommendations;
`workbench checks run` runs the configured commands. When benchd is installed, a heavy command uses `benchctl hold` and
Workbench waits for its result.

The Git adapter materializes the staged index as a temporary tree, runs structural and configured checks there, and
validates the proposed commit message. The reusable operations accept a supplied project tree rather than depending on
Git, allowing another version-control adapter later. Git's whitespace, merge-marker, and private-key checks remain in
the Git adapter.

Change messages use Conventional Commit form by default. Conventional Commits does not prescribe widths; Workbench uses
the common 50-character subject and 72-character body convention, both configurable. A project may configure
`unrestricted` message style when another system owns that policy.

## Develop Workbench

`manifest.scm` lists the development tools. Enter its Guix profile explicitly when useful; Workbench and `.envrc` do
not load Guix automatically. The tracked `.envrc` loads ignored machine-local `.envrc.local` settings and adds `bin/` to
`PATH`.

This repository configures pnpm, Prettier, type-aware ESLint, TypeScript 7 type checking, Vitest, bundle parity, and
shell checks. `make check`, `make fmt`, `make lint`, and `make test` delegate to the configured Workbench roles.
`pnpm run build` rebuilds the bundle; `pnpm run bundle:check` verifies the checked-in bundle without modifying it. Rust
and Python remain supported through executable language references. The first decision set and implementation remain
uncommitted pending human review.

`make clean` removes build outputs and test/tool caches from Workbench and all language references. `make distclean`
also removes local `node_modules` and Python `.venv` directories. Each reference supports the same targets from its own
directory. Both preserve the checked-in bundle, source files, lockfiles, and shared external caches, including external
Cargo targets and Nix/Guix stores.

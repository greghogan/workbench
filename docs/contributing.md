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

## Build and distribution

Author CLI code in `src/*.ts`, tooling and reference helpers in `.mts`, and the CommonJS bundle loader in
`bin/bundle-runtime.cts`. Tests and their fixtures use `.mts`. Edit these sources, then run `pnpm run tooling:build` to
regenerate the adjacent plain-Node helpers and configuration files; copied reference helpers therefore need no
TypeScript runtime. `pnpm run typecheck` checks production/tooling and tests as separate strict projects. Typed lint
checks both, formatting checks authored sources, and bundle parity checks verify every emitted helper. Repository helper
source maps attribute subprocess coverage to the authored TypeScript, including helpers copied into temporary projects.
Emitted reference helpers use their reference project's formatting settings. The tooling builder itself runs from its
TypeScript source on the declared development Node version, so edits to the builder take effect in the same regeneration
pass.

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

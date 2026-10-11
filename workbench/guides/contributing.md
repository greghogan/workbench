# Develop Workbench

[Workbench overview](../../README.md). Commands assume your project root; `workbench` denotes the executable in your
pinned distribution.

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

## Build and distribution

This repository configures pnpm, Prettier, type-aware ESLint, TypeScript 7 type checking, Vitest, bundle parity, and
shell checks. Rust tools in the root development manifest support the Rust reference checks; the Workbench CLI itself
runs on Node.js. The reference's `rust-toolchain.toml` selects its compiler when using rustup, while its `Cargo.toml`
declares its minimum Rust version. `pnpm run build` rebuilds the bundle; `pnpm run bundle:check` verifies the checked-in
bundle without modifying it. Shipped bundles contain compressed, minified JavaScript without source maps. Small CommonJS
launchers decompress them in memory using Node, with no dependency installation or expanded files on disk.
`bundle.compression` is a project build setting in `workbench/config.toml`: `brotli` (default), `zlib` (gzip), or
`zstd`. Set it with `workbench config set bundle.compression zstd`, then rebuild the distribution. Consuming projects
use their pinned artifact's format; changing their configuration does not recompress an existing dependency. All three
formats use Node's built-in decompression; Zstandard needs a runtime with built-in Zstandard support, available in every
selected Node CI version. Coverage builds unminified bundles with inline source maps in a temporary workspace, reuses
installed development dependencies, and removes that workspace afterward. Coverage reports refer to the original source
paths. Rust, Python, TypeScript, JavaScript, Java, Ruby, PHP, C, C++, and Go have executable language references. The
first decision set remains draft pending human review; temporary CI commits do not accept those decisions.

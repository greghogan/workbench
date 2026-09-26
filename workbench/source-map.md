# Source map

Start at `AGENTS.md` for project context, `workbench/decision-map.md` for decisions, and `workbench/task-map.md` for
unfinished work. The first decision set remains uncommitted pending human review.

- `bin/workbench` starts the checked-in Node bundle and identifies the owning project.
- `ts/core.ts` owns project configuration, record identities, canonical paths, and safe file operations.
- `ts/projects.ts` owns non-destructive setup, subproject registration, and Git hook configuration.
- `ts/languages.ts` loads language references, seeds TypeScript roots, and verifies reference projects.
- `ts/records.ts` creates, opens, and validates records and task or experiment relationships.
- `ts/citations.ts` owns CSL YAML validation, identifier imports, and source-specific PDF acquisition.
- `ts/releases.ts` creates release records and derives artifact indexes.
- `ts/maps.ts` derives maps for all six record types and routes root maps to subprojects.
- `ts/agents.ts` derives the entire root agent context from the human-written charter and mapped decisions.
- `ts/skills.ts` exposes only configured skills through Codex and Claude Code discovery paths.
- `ts/checks.ts` runs portable configured check roles and selected Guix or Nix environments.
- `ts/markdown.ts`, `ts/documentation.ts`, and `ts/validation.ts` own formatting and structural checks.
- `ts/feedback.ts` stores local feedback; `ts/commit.ts` validates change-message policy.
- `ts/main.ts` owns the hierarchical command interface and routing.
- `tests-ts` exercises both project layouts, every record type, contextual help, skill activation, and safe cleanup.
- `skills` contains canonical Guix and Nix update skills and future language-specific skills.
- `bundle` contains distributable JavaScript.
- `scripts/build-bundle.mjs` builds the bundle; `scripts/check-bundle.mjs` checks it against TypeScript sources.
- `scripts/check-shell` provides shell format and lint roles used by local checks and the Git adapter.
- `.githooks/pre-commit` checks a staged snapshot; `.githooks/commit-msg` validates change messages.
- `examples/languages` contains executable TypeScript, Rust, and Python references with optional Guix and Nix
  environments.
- `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` lock TypeScript dependencies and scripts.
- `tsconfig.json`, `eslint.config.mjs`, `vitest.config.mjs`, and `.prettierrc.json` set code-quality defaults.
- `channels.scm` pins Guix for `manifest.scm`, which lists optional development tools; `.envrc` only loads local
  settings and the launcher path.
- `Makefile` exposes development commands, delegates checks to Workbench, and cleans local outputs and dependencies.

# JavaScript reference

A standalone Node project with JavaScript sources, strict JSDoc type checking, typed ESLint, Prettier, and Vitest.
JavaScript has its own shared language definition and example. It uses the same Node support policy and package tools as
TypeScript, without a TypeScript compilation step. Building copies JavaScript sources; the release package exports only
application modules. Syntax and platform APIs must remain usable on the declared Node minimum.

`.node-version` selects native development Node 26.11.1, the newest stable release including Current. Node API types and
syntax retain the Node 22 baseline. `engines.node` declares the minimum; CI tests each configured
maintained release line and the Current line. Nix and Guix supply independently pinned development Node versions, and
Workbench also supports Dev Containers. Native platforms are Linux x64/arm64, macOS arm64, and Windows x64.
`packageManager` pins pnpm; all environments install from the same committed lockfile.

Nix selects `nodejs_latest` from its locked package set, currently Node 26.9.0. The pinned Guix channel's newest stable
Node is 24.18.0. Environment input revisions remain independently pinned.

`jsconfig.json` enables `allowJs`, `checkJs`, strict checking, indexed-access checks, and exact optional properties. The
TypeScript 7 compiler checks JavaScript without emitting files; a separate TypeScript 6 alias supplies the compiler API
needed by the pinned typescript-eslint release. JSDoc describes public types. ESLint uses strict typed and stylistic
presets, rejects focused tests and unused suppressions, and allows no warnings. Review the preset rules when updating
the locked tools.

The project-owned `.pnpmfile.cjs` hook applies Workbench's external package and store locations to direct pnpm commands
in an integrated project. `node_modules` contains links to cached dependencies. Retain the hook when copying the
example; without integration it leaves pnpm's defaults intact. Builds use separately owned external staging directories.

The static Makefile delegates to configured commands: `make` builds, `make check` runs the commit gate, `make test` runs
ordinary tests, and `make coverage` runs the same suite with coverage floors and presents summary changes. CI selects
coverage on Linux/native and ordinary tests elsewhere. `make fmt` formats sources. `make release` creates a package in
`dist/`, verified outside the checkout. `make clean` removes outputs and reports; `make distclean` also removes links in
`node_modules`, retaining shared downloads.

The gate verifies this console example after building:

```console
$ node --input-type=module -e 'import { pathToFileURL } from "node:url"; const { countByte } = await import(process.env.WORKBENCH_STORAGE_EXTERNAL === "true" ? pathToFileURL(`${process.env.WORKBENCH_BUILD_DIR}/javascript/build/src/arithmetic.js`) : "./build/src/arithmetic.js"); console.log(countByte(new TextEncoder().encode("banana"), 97));'
3
```

# TypeScript reference

This small Node project demonstrates the TypeScript 7 compiler, strict type checking, a committed pnpm lockfile,
type-aware ESLint, Prettier, and Vitest. The `@typescript/native` alias selects TypeScript 7 for compilation and type
checking. The `typescript` alias selects the TypeScript 6 compatibility package because the locked `typescript-eslint`
requires its JavaScript compiler API, which TypeScript 7.0 does not provide. This follows Microsoft's
[side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60).
Retire the compatibility package when the lint tooling supports the native compiler's API. The optional Guix and Nix
definitions provide host tools; pnpm's lockfile governs project packages.

ESLint uses the strict typed and stylistic typed presets, exhaustive switch checks, and no warnings. Prettier owns
layout; its compatibility config is last. Compiler options add indexed-access and optional-property checks to strict
mode. Review preset changes when updating the locked lint tools.

`.node-version` pins host Node; `packageManager` selects pnpm for all environments. Guix and Nix supply their own
independently pinned Node versions. Every environment uses frozen lockfile installs and verifies the same reference. CI
also verifies the minimum Node version from `engines.node`. The Nix shell supplies runtime libraries for native package
binaries; native Nix on NixOS also needs an FHS loader such as the system's `nix-ld` configuration. The declared minimum
accommodates the locked lint tools as well as application execution.

The Node 22 minimum selects the latest patch of the oldest supported maintained LTS line when updated. Native
development selects Node 24 as the newest LTS line at selection time. Review both choices against the upstream release
schedule when updating pins; a newer Current release does not automatically replace the LTS default.

`make clean` removes build outputs and coverage; `make distclean` also removes `node_modules`.

The gate verifies this console example (after building where required):

```console
$ node --input-type=module -e 'import { pathToFileURL } from "node:url"; const { countByte } = await import(process.env.WORKBENCH_BUILD_DIR ? pathToFileURL(`${process.env.WORKBENCH_BUILD_DIR}/typescript/build/src/arithmetic.js`) : "./build/src/arithmetic.js"); console.log(countByte(new TextEncoder().encode("banana"), 97));'
3
```

`vitest.config.mjs` owns advisory slow-test reporting and coverage floors, including unimported source files. Timing is
advisory; coverage below a declared floor fails. Workbench configuration owns the advisory whole-command threshold. It
includes build/setup inside the command and does not terminate slow runs. Human review is required to change the
protected quality configuration.

The static Makefile delegates to the repository's configured commands for this root: `make` builds, `make check` runs
the commit gate, `make test` runs ordinary tests, and `make coverage` runs the same suite with instrumentation and
coverage floors. CI selects coverage on Linux/native and ordinary tests on other targets. `make release` prepares local
release artifacts; `make fmt` formats files. Coverage has no whole-command timing cap.

The release tarball in `dist/` exports the arithmetic module and its TypeScript declarations; compiled tests are
excluded.

# React example

A standalone React and TypeScript counter application. esbuild produces a minified static site; React does not own a
separate Workbench build command. This example selects the ordinary TypeScript command suite.

## Native use

Use the Node version in `.node-version` and the package manager declared in `package.json`:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm run coverage
corepack pnpm run build
corepack pnpm run release
node scripts/check-site.mjs dist/site
```

Open `build/index.html` in a browser. The production site needs no Node runtime or dependency installation. Release
preparation copies the site to `dist/site`; publication is a separate action. The release check loads the actual
minified bundle into a DOM environment from an isolated copy and verifies the counter interactions. It does not replace
testing in a real browser for an application's browser support claims.

Project-owned files declare React dependencies, JSX and strict TypeScript options, React Hooks linting, and component
tests with Testing Library and Vitest. Coverage includes the application entry and all components, with 100% floors for
lines, statements, functions, and branches. Full reports and installed dependencies are ignored. ESLint uses strict typed
presets for TypeScript source and tests; additional correctness rules also cover scripts and tool configuration. Unused lint
suppressions fail. Lint rejects direct focused tests, and Vitest rejects all focused test forms locally and in CI.

After building, the same gate verifies the production bundle's counter interactions:

```console
$ node scripts/check-site.mjs
Verified the production static site.
```

## Guix and Nix

`channels.scm` and `manifest.scm` define the authenticated Guix environment. `flake.nix` and `flake.lock` define the Nix
environment for direct and Docker execution. Their initial pins match the TypeScript reference; package versions remain
independent of native `.node-version`. The package manifest and lockfile own React and check-tool dependencies in every
environment.

Nix selects `nodejs_latest` from its locked package set, currently Node 26.9.0. The pinned Guix channel supplies Node
24.18.0 as its newest stable release; native development uses Node 26.11.1. Node API types retain the Node 22 baseline.

In this repository, use the same checks with an explicit environment:

```sh
make check ENVIRONMENT=guix
make check ENVIRONMENT=nix
make check ENVIRONMENT=nix-docker
make check ENVIRONMENT=devcontainer
```

Direct Nix requires an installed Nix bootstrap. Nix Docker requires Docker and the project-configured pinned image; both
execute the locked flake. Guix requires an installed Guix bootstrap and working container support. Dev Container
execution uses the consuming repository's descriptor; this repository supplies one shared workspace descriptor.

Without Workbench, the native project commands also work inside `nix develop --no-update-lock-file` or the environment
selected by `guix time-machine -C channels.scm -- shell --container --emulate-fhs --network -m manifest.scm`. Use the
declared package-manager version; the managed Node package need not provide Corepack. Workbench commands bootstrap pnpm
through npm's committed bootstrap lock, then use this example's frozen pnpm lock for project dependencies. Without
Workbench, install the declared package manager yourself; equivalent bootstrap pinning uses a committed npm lockfile
containing the selected manager and its dependencies.

## Workbench use

The static Makefile invokes configured Workbench commands without including a parent Makefile. In this repository it
selects `examples/frameworks/react`. After copying this example into another repository, pin Workbench at `.workbench/`,
register the copied directory as a TypeScript language root in `workbench/projects.toml`, and select its TypeScript
`check_suite` in `workbench/automation.toml`. Native package-manager commands above work independently of Workbench.

Keep the project-owned `.pnpmfile.cjs` hook with the copied example. When Workbench integration is present, it applies
the selected local or external dependency storage to direct pnpm commands and preserves managed-session paths. Invalid
integration fails before packages are installed. Without Workbench, pnpm keeps its normal defaults.

CI runs this example on Linux x64/ARM64, macOS ARM64, and Windows x64 with the selected Node release. Nix and Guix also
run it in their prepared Linux environments alongside Workbench and the language examples. It uses the shared TypeScript
language definition and project-owned framework dependencies, without a separate framework ADR or configuration layer.

Configuration follows the upstream [React TypeScript guide](https://react.dev/learn/typescript),
[Hooks lint guidance](https://react.dev/reference/eslint-plugin-react-hooks), and
[React Testing Library documentation](https://testing-library.com/docs/react-testing-library/intro/).

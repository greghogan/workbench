# Distribution and updates

Acquire the independently pinned executable and reconcile project-owned collections.

Workbench ships one package of prebuilt JavaScript and runtime assets without bundling Node. This keeps the developer
distribution small and uses an installed Node runtime across supported platforms. The application and release packaging
are written in TypeScript; emitted bundles run without the compiler or development dependencies. These are choices for
the Workbench implementation; consuming applications select their own languages and distribution formats.

Tooling and reference helpers are authored in `.mts` sources and emitted as adjacent `.mjs` files for ordinary Node
execution and independent copying. `scripts/build-tooling.mts` owns emission and parity checks; source maps retain the
authoring paths for repository-helper coverage and diagnostics. Emitted reference helpers follow their project's
formatter; formatting their generated JavaScript precludes retaining the original emission map.
`scripts/tooling-artifacts.mts` distinguishes required runtime and reference helpers from ignored development outputs.
`scripts/setup-development.mts` installs locked dependencies before generating those local outputs. Release packaging
omits generated development helpers; runtime and reference helpers remain ready to run.

The launcher runs directly on a capable installed Node. For an older supported native Node, it loads the bootstrap
bundle and uses the shared verified installer to select the pinned runtime before loading commands. Managed environments
retain their selected runtime. Runtime floors and acquisition prerequisites are documented in
[installation guidance](../../docs/installations.md).

| Paths                                                                                      | Responsibility                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `bin/workbench.mjs`, `bin/workbench`, `bin/workbench.cmd`                                  | Start Workbench from its source or npm package.                                                                    |
| `bin/bundle-runtime.cts`, `bin/bundle-runtime.cjs`                                         | Decompresses and executes bundles in memory.                                                                       |
| `src/launcher.ts`                                                                          | Validates the bootstrap runtime, resolves project pins, and dispatches exact Git packages through npm.             |
| `src/bootstrap.ts`, `src/startup-runtime.ts`                                               | Hand older native Node to a verified pinned runtime before loading the CLI.                                        |
| `src/distribution-identity.ts`                                                             | Reads immutable package source identity for project-pin dispatch.                                                  |
| `src/package.ts`, `src/package-output.ts`, `src/package-verify.ts`                         | Package source files and references into verified, reproducible Node-based releases with owned output replacement. |
| `src/cli/installation.ts`                                                                  | Installs owned user or system command launchers.                                                                   |
| `src/runtime-distribution.ts`                                                              | Materializes an external executable into disposable CI checkouts.                                                  |
| `src/distribution-manifest.ts`                                                             | Verifies artifact inventories and resolves recorded input hashes.                                                  |
| `src/update.ts`, `src/update-git.ts`, `src/update-prepare.ts`                              | Prepare and apply executable-pin updates in isolated checkouts.                                                    |
| `src/sync.ts`                                                                              | Coordinates derived project context.                                                                               |
| `bundle`                                                                                   | Contains runnable distributable JavaScript and its standalone launcher.                                            |
| `scripts/build-bundle.mts`, `scripts/check-bundle.mts`                                     | Build bundles and establish source parity.                                                                         |
| `scripts/bundle-options.mts`, `scripts/bundle-artifacts.mts`                               | Select compilation and deterministic compression.                                                                  |
| `scripts/bundle-licenses.mts`, `scripts/bundle-license-overrides.json`, `scripts/licenses` | Retain bundled dependency license evidence.                                                                        |
| `scripts/package-workbench.mts`, `scripts/package-output.mts`                              | Prepare an executable package without project policy or development dependencies.                                  |
| `scripts/check-release.mts`                                                                | Verifies the checksummed release tarball outside the checkout.                                                     |
| `scripts/check-node-runtime.mts`                                                           | Verifies supported installed Node execution and rejects unsupported interpreters before loading commands.          |
| `scripts/check-bootstrap.mts`                                                              | Verifies real older-Node handoff to the pinned CLI runtime.                                                        |

- `scripts/build-tooling.mts`: Emit and check plain-Node helpers, typed configuration, and standalone subprocess
  fixtures with source maps.
- `src/generated-file.ts`: Defines the generated source/output pairing and header shared by emission and source maps.
- `scripts/authored-tooling.mts`: Resolves bundled helpers to their authored sources rather than stale emitted copies.
- `scripts/bundle-build.mts`: Constructs one bundle candidate set for read-only verification and staged publication.
- `scripts/runtime-dependencies.mts`: Checks emitted imports, worker assets, bundle payloads, and shipped template
  paths.

- `src/distribution-layout.ts`: Share declared payload validation and generated/personal-state exclusions between
  release packaging and independently writable copy-on-write rehearsal distributions.
- `scripts/metadata-http.mts`: Share bounded streaming metadata reads and reader cleanup; each provider retains
  ownership of authentication, redirects, retry, and cancellation policy.

- `src/formatter.ts`, `bundle/formatter.cjs`: Keep standalone formatting dependencies behind an operation-triggered
  runtime bundle.
- `scripts/node-runtimes.mts`: Share runtime floors, defer optional bundles, and enforce retained dependencies' runtime
  requirements.

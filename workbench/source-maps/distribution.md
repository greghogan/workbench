# Distribution and updates

- `bin/workbench.mjs`, `bin/workbench`, `bin/workbench.cmd`: Start Workbench from its source or npm package.
- `bin/bundle-runtime.cts`, `bin/bundle-runtime.cjs`: Decompresses and executes bundles in memory.
- `bundle`: Contains runnable distributable JavaScript and its standalone launcher.
- `scripts/build-bundle.mts`, `scripts/check-bundle.mts`: Build bundles and establish source parity.
- `scripts/bundle-options.mts`: Select compilation targets and deferred runtime entry points.
- `scripts/bundle-licenses.mts`, `scripts/bundle-license-overrides.json`, `scripts/licenses`: Retain bundled dependency
  license evidence.
- `scripts/package-workbench.mts`, `scripts/package-output.mts`: Prepare an executable package without project policy or
  development dependencies.
- `scripts/check-release.mts`: Verifies the checksummed release tarball outside the checkout.
- `scripts/check-node-runtime.mts`: Verifies supported installed Node execution and rejects unsupported interpreters
  before loading commands.
- `scripts/check-bootstrap.mts`: Verifies real older-Node handoff to the pinned CLI runtime.
- `scripts/build-tooling.mts`: Emit and check plain-Node helpers, typed configuration, and standalone subprocess
  fixtures with source maps.
- `scripts/build-diagram-assets.mts`, `app/resources/browser`: Build and retain the separate browser diagram renderer
  and its dependency notices without loading it during CLI startup.
- `scripts/authored-tooling.mts`: Resolves bundled helpers to their authored sources rather than stale emitted copies.
- `scripts/bundle-build.mts`: Constructs one bundle candidate set for read-only verification and staged publication.
- `scripts/runtime-dependencies.mts`: Checks emitted imports, worker assets, bundle payloads, and shipped template
  paths.
- `bundle/formatter.cjs`: Keep standalone formatting dependencies behind an operation-triggered runtime bundle.
- `app/src/core/distribution/node-runtimes.mts`: Share runtime floors, defer optional bundles, and enforce retained
  dependencies' runtime requirements.

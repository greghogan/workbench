# Distribution and updates

- `src/core/distribution/bundle-artifacts.mts`, `src/core/distribution/bundle-layout.mts`,
  `src/core/distribution/node-runtimes.mts`: Share bundle identities, compression, deferred loading, and runtime
  requirements with repository build tooling.

- `src/cli/launcher.ts`: Validates the bootstrap runtime, resolves project pins, and dispatches exact Git packages
  through npm.
- `src/core/storage/node-compile-cache.ts`: Enables optional native Node compilation caching and retires aged owned
  bytecode through automatic maintenance.
- `src/core/distribution/bootstrap.ts`, `src/core/distribution/startup-runtime.ts`: Hand older native Node to a verified
  pinned runtime before loading the CLI.
- `src/core/distribution/distribution-identity.ts`: Reads immutable package source identity for project-pin dispatch.
- `src/core/artifacts/package.ts`, `src/core/artifacts/package-output.ts`, `src/core/artifacts/package-verify.ts`:
  Package source files and references into verified, reproducible Node-based releases with owned output replacement.
- `src/cli/installation.ts`: Installs and updates owned command launchers and manages installed service registrations.
- `src/core/distribution/systemd-service.ts`: Manages owned systemd units, including service readiness and release
  activation.
- `src/core/distribution/runtime-distribution.ts`: Materializes an external executable into disposable CI checkouts.
- `src/core/distribution/distribution-manifest.ts`: Verifies artifact inventories and resolves recorded input hashes.
- `src/core/distribution/release-archive.ts`: Verifies release checksums and unpacks a private copy for qualification
  and installation.
- `src/core/distribution/installed-release.ts`: Retains verified archives by digest and switches or restores the
  release selected by the stable CLI and service entry point.
- `src/core/distribution/release-transition.ts`: Persists the previous release and affected service before an update
  so the launcher can recover from interruption.
- `src/core/distribution/update.ts`, `src/core/distribution/update-git.ts`, `src/core/distribution/update-prepare.ts`:
  Prepare and apply executable-pin updates in isolated checkouts.
- `src/core/records/sync.ts`: Coordinates derived project context.
- `src/core/runtime/generated-file.ts`: Defines the generated source/output pairing and header shared by emission and
  source maps.
- `src/core/distribution/distribution-layout.ts`: Share declared payload validation and generated/personal-state
  exclusions between release packaging and independently writable copy-on-write rehearsal distributions.
- `src/core/toolchains/acquisition/metadata-http.mts`: Share bounded streaming metadata reads and reader cleanup; each
  provider retains ownership of authentication, redirects, retry, and cancellation policy.
- `src/core/records/formatter.ts`: Keep standalone formatting dependencies behind an operation-triggered runtime bundle.
- `src/core/distribution/launcher-identity.ts`, `src/core/distribution/launcher-acquisition.ts`,
  `src/core/distribution/launcher-runtime.ts`: Own immutable executable identity, npm handoff, and child-process
  lifetime independently of CLI admission.

- `src/core/distribution`: Selects executable revisions, bootstrap runtimes, bundle contracts, and installed
  distribution contents.

- `src/core/artifacts`: Builds and verifies development images and release packages, including input and publication
  identities.

- `src/core/verification`: Runs installed-product rehearsals against disposable projects and distributions.
- `src/core/artifacts/preparation-store.ts`, `src/core/storage/managed-builder-store.ts`: Select preparation backends,
  verify Docker's access to local cache directories, and attach shared stores.


- `resources/verification`: Provides the human-written charter used by disposable verification projects.

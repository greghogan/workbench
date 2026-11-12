# Tool acquisition and dependencies

- `src/core/execution/checks/advisories.ts`: checks locked language dependencies against OSV.
- `src/core/toolchains/dependencies.ts`: switches dependency installations and maintains Python environment links.
- `src/core/toolchains/tool-probes.ts`: declares package executables and shares version probes between installation and
  environment guards.
- `src/core/toolchains/native/native-tools.ts`, `src/core/storage/storage.ts`: installs and selects declared native
  tools in platform cache storage; app/src/core/storage/storage.ts resolves platform user directories and keeps durable
  records separate.
- `src/core/toolchains/native/native-assets.ts`: resolves native pins, validates language-required native selections,
  and derives authenticated artifact metadata, filters, and installation identities.
- `src/core/toolchains/tool-host.ts`: checks binary SDK libc requirements before acquisition and activation.
- `src/core/toolchains/native/native-asset-maintenance.ts`: plans acquisition metadata pruning from active pins and
  atomically publishes validated, optionally formatted replacements.
- `src/core/artifacts/package-manager.ts`: delegates locked package-manager bootstrap to npm in isolated platform cache
  storage.
- `src/core/artifacts/container-tools.ts`: selects and installs the independently locked Dev Container CLI without
  Workbench's development dependencies.
- `src/core/toolchains/miri.ts`: validates supplementary dated Rust nightly pins and invokes Miri without changing
  compiler defaults.
- `src/core/toolchains/tool-downloads.ts`: verifies upstream artifacts and safely publishes installations;
  scripts/native-assets.json, scripts/llvm-assets.json, and scripts/bootstrap-tools.json record verified acquisition
  metadata.
- `src/core/toolchains/acquisition/archive-extraction.ts`, `src/core/toolchains/acquisition/artifact-decoders.ts`:
  bounds ordinary tar and ZIP extraction; app/src/core/toolchains/acquisition/artifact-decoders.ts owns bounded,
  cancellable decompression.
- `src/core/toolchains/acquisition/artifact-streams.ts`: bounds and hashes incoming bytes and checks archive metadata
  before buffering.
- `src/core/toolchains/acquisition/artifact-signatures.ts`: verifies streamed OpenPGP signatures in independently owned
  temporary homes, retaining their files when process drainage is uncertain.
- `src/core/toolchains/acquisition/artifact-proofs.ts`: retains authenticated proof bytes for bounded offline
  re-verification.
- `src/core/toolchains/acquisition/artifact-policy.ts`: binds installation provenance and cache identities to source,
  filter, proofs, and trust.
- `src/core/toolchains/acquisition/artifact-repositories.ts`: authenticates signed repository catalogs, pinned indices,
  and exact runtime packages.
- `src/core/toolchains/acquisition/artifact-attestations.ts`,
  `src/core/toolchains/acquisition/attestation-verification.ts`: acquires proof bundles and lazily verifies their
  identities, digest bindings, and retained trust roots.
- `src/core/toolchains/filtered-artifacts.ts`: owns filtered extraction, retained-content manifests, and cache
  verification.
- `src/core/toolchains/vcpkg.ts`: prepares pinned C/C++ dependencies with the selected compiler and ABI-aware caching.
- `src/core/toolchains/ruby-manager.ts`: bootstraps the verified, lockfile-selected Bundler through RubyGems.
- `src/core/artifacts/runtime-builds.ts`, `src/core/execution/environments/host-environment.ts`,
  `test/core/execution/checks/runtime_build_environment.test.mts`: builds verified language runtimes in private
  installation images.
- `src/core/toolchains/seven-zip.ts`: validates bounded RubyInstaller archive members and contained extraction.
- `src/core/toolchains/php-manager.ts`: verifies the pinned Composer bootstrap before delegating package operations.
- `src/core/toolchains/php-coverage.ts`: installs verified Xdebug sources for the selected PHP ABI.
- `src/core/execution/checks/advisory-details.ts`: Fetches and decodes optional advisory enrichment independently of
  finding detection and presentation.
- `src/core/toolchains/pnpm-lock.mts`: Shares pnpm lock document and package-identity decoding across acquisition,
  metadata retention, and advisory checks.
- `src/core/toolchains/acquisition/archive-paths.ts`: Validates archive member names and link text independently of
  download orchestration.
- `src/core/toolchains/tool-execution.ts`: Executes native tools and forwards Windows shim arguments at a shared process
  boundary.
- `src/core/artifacts/native-image-inputs.ts`: fetches pinned native test and analysis inputs without executing suites,
  sharing canonical Maven repository materialization with managed environments.
- `src/core/toolchains/native/native-artifact-records.ts`: Retains verified native artifact metadata so exact pins
  survive executable updates and SDK cache pruning.
- `test/core/review/signature_lifecycle.test.mts`: Verifies that acquisition cleanup cannot remove an unconfirmed
  verifier's files, and that uncertain Maven preparation retains its working inputs.
- `src/core/review/signature-status.ts`: Interprets grouped GnuPG status, binding approved primary/subkey identities and
  rejecting expired or revoked evidence; app/src/core/toolchains/acquisition/artifact-proofs.ts retains digest-bound
  verification metadata.
- `src/cli/maven.ts`, `src/core/toolchains/maven/maven-acquisition.ts`, `src/core/toolchains/maven/maven-artifacts.ts`:
  Present preparation results, authenticate Maven inputs before candidate execution, and stream verified artifacts into
  private packaging candidates.
- `src/core/toolchains/maven/maven-policy.ts`, `src/core/toolchains/maven/maven-proposal.ts`: Decode publisher trust and
  evidence, bind reviewable proposals to their inputs, and recover interrupted activation of checksum and authentication
  files together.
- `src/core/toolchains/maven/maven-workspace.ts`: Bind declared source modules to contained project roots and proposal
  input identities; keep Maven's source reactor separate from the verified external artifact repository.
- `src/core/toolchains/maven/maven-files.ts`: Bound metadata reads and compare each operation against the exact input
  bytes it staged.
- `src/core/toolchains/maven/maven-pom.ts`: Shared XML syntax ranges and structural model validation without rewriting
  unrelated content.
- `src/core/toolchains/maven/maven-test-selection.ts`: Select tests in disposable consumer POMs while compiling sibling
  sources and preserving project POMs; `scripts/java-check.mjs` exposes the shared Java runner to consumers.
- `src/core/toolchains/maven/maven-environment.ts`: Exclude inherited JVM/Maven injection from isolated acquisition and
  source checks.
- `src/core/toolchains/maven/maven-bootstrap.ts`: Apply the consuming root's pinned resolver graph only to disposable
  metadata POMs, retaining XML namespace bindings and leaving authoritative project files unchanged.
- `src/core/toolchains/java-release.ts`: Packages Maven's declared runtime closure and application capabilities using
  verified artifacts; docs/java-dependencies.md describes acquisition, activation, frozen checks, and consumer
  distributions.

- `src/core/toolchains`: Resolves selected tools and verifies acquired executables and language dependency inputs.

- `src/core/storage`: Measures, locks, and prunes owned caches while protecting active use and retained evidence.

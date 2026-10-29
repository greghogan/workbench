# Tool acquisition and dependencies

Authenticate downloads, publish tool installations, and prepare language dependencies.

| Paths                                                                                                             | Responsibility                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/advisories.ts`                                                                                               | checks locked language dependencies against OSV.                                                                                                                                                   |
| `src/dependencies.ts`                                                                                             | switches dependency installations and maintains Python environment links.                                                                                                                          |
| `src/tool-probes.ts`                                                                                              | declares package executables and shares version probes between installation and environment guards.                                                                                                |
| `src/native-tools.ts`, `src/storage.ts`                                                                           | installs and selects declared native tools in platform cache storage; `src/storage.ts` resolves platform user directories and keeps durable records separate.                                      |
| `src/native-assets.ts`                                                                                            | resolves native pins, validates language-required native selections, and derives authenticated artifact metadata, filters, and installation identities.                                            |
| `src/tool-host.ts`                                                                                                | checks binary SDK libc requirements before acquisition and activation.                                                                                                                             |
| `src/native-asset-maintenance.ts`                                                                                 | plans acquisition metadata pruning from active pins and atomically publishes validated, optionally formatted replacements.                                                                         |
| `src/package-manager.ts`                                                                                          | delegates locked package-manager bootstrap to npm in isolated platform cache storage.                                                                                                              |
| `scripts/package-manager`                                                                                         | retains the shared npm bootstrap manifest and lockfile for pnpm and its platform packages.                                                                                                         |
| `src/container-tools.ts`, `scripts/container-tools`                                                               | selects and installs the independently locked Dev Container CLI without Workbench's development dependencies.                                                                                      |
| `src/miri.ts`                                                                                                     | validates supplementary dated Rust nightly pins and invokes Miri without changing compiler defaults.                                                                                               |
| `src/tool-downloads.ts`, `scripts/native-assets.json`, `scripts/llvm-assets.json`, `scripts/bootstrap-tools.json` | verifies upstream artifacts and safely publishes installations; `scripts/native-assets.json`, `scripts/llvm-assets.json`, and `scripts/bootstrap-tools.json` record verified acquisition metadata. |
| `src/archive-extraction.ts`, `src/artifact-decoders.ts`                                                           | bounds ordinary tar and ZIP extraction; `src/artifact-decoders.ts` owns bounded, cancellable decompression.                                                                                        |
| `src/artifact-streams.ts`                                                                                         | bounds and hashes incoming bytes and checks archive metadata before buffering.                                                                                                                     |
| `src/artifact-signatures.ts`                                                                                      | verifies streamed OpenPGP signatures in independently owned temporary homes, retaining their files when process drainage is uncertain.                                                             |
| `src/artifact-proofs.ts`                                                                                          | retains authenticated proof bytes for bounded offline re-verification.                                                                                                                             |
| `src/artifact-policy.ts`                                                                                          | binds installation provenance and cache identities to source, filter, proofs, and trust.                                                                                                           |
| `src/artifact-repositories.ts`                                                                                    | authenticates signed repository catalogs, pinned indices, and exact runtime packages.                                                                                                              |
| `scripts/keys/README.md`                                                                                          | records pinned public trust material and proof availability.                                                                                                                                       |
| `src/artifact-attestations.ts`, `src/attestation-verification.ts`                                                 | acquires proof bundles and lazily verifies their identities, digest bindings, and retained trust roots.                                                                                            |
| `src/filtered-artifacts.ts`                                                                                       | owns filtered extraction, retained-content manifests, and cache verification.                                                                                                                      |
| `scripts/keys`                                                                                                    | retains the artifact verification keys and Sigstore trust roots used by the verified installer.                                                                                                    |
| `src/vcpkg.ts`                                                                                                    | prepares pinned C/C++ dependencies with the selected compiler and ABI-aware caching.                                                                                                               |
| `src/ruby-manager.ts`                                                                                             | bootstraps the verified, lockfile-selected Bundler through RubyGems.                                                                                                                               |
| `src/runtime-builds.ts`, `src/host-environment.ts`, `tests/runtime_build_environment.test.mts`                    | builds verified language runtimes in private installation images.                                                                                                                                  |
| `src/seven-zip.ts`                                                                                                | validates bounded RubyInstaller archive members and contained extraction.                                                                                                                          |
| `src/php-manager.ts`                                                                                              | verifies the pinned Composer bootstrap before delegating package operations.                                                                                                                       |
| `src/php-coverage.ts`                                                                                             | installs verified Xdebug sources for the selected PHP ABI.                                                                                                                                         |
| `scripts/php-coverage.php`                                                                                        | translates PHPUnit production coverage into compact summaries.                                                                                                                                     |

`tests/fixtures/authenticated-assets.json` retains the metadata matching captured signature and attestation fixtures;
production catalog pruning does not change that evidence.

- `src/advisory-details.ts`: Fetches and decodes optional advisory enrichment independently of finding detection and
  presentation.
- `scripts/pnpm-lock.mts`: Shares pnpm lock document and package-identity decoding across acquisition, metadata
  retention, and advisory checks.
- `src/archive-paths.ts`: Validates archive member names and link text independently of download orchestration.
- `src/tool-execution.ts`: Executes native tools and forwards Windows shim arguments at a shared process boundary.

- `bundle/attestation-verification.cjs`: Load the Sigstore verifier only when attestation authentication requests it,
  keeping the bootstrap runtime independent of its newer Node requirement.

- `src/native-image-inputs.ts`: fetches pinned native test and analysis inputs without executing suites, sharing
  canonical Maven repository materialization with managed environments.

- `src/native-artifact-records.ts`: Retains verified native artifact metadata so exact pins survive executable updates
  and SDK cache pruning.
- `tests/signature_lifecycle.test.mts`: Verifies that acquisition cleanup cannot remove an unconfirmed verifier's files,
  and that uncertain Maven preparation retains its working inputs.

- `src/signature-status.ts`: Interprets grouped GnuPG status, binding approved primary/subkey identities and rejecting
  expired or revoked evidence; `src/artifact-proofs.ts` retains digest-bound verification metadata.
- `src/cli/maven.ts`, `src/maven-acquisition.ts`, `src/maven-artifacts.ts`: Present preparation results, authenticate
  Maven inputs before candidate execution, and stream verified artifacts into private packaging candidates.
- `src/maven-policy.ts`, `src/maven-proposal.ts`: Decode publisher trust and evidence, bind reviewable proposals to
  their inputs, and recover interrupted activation of checksum and authentication files together.
- `src/maven-workspace.ts`: Bind declared source modules to contained project roots and proposal input identities; keep
  Maven's source reactor separate from the verified external artifact repository.
- `src/maven-files.ts`: Bound metadata reads and compare each operation against the exact input bytes it staged.
- `src/maven-pom.ts`: Shared XML syntax ranges and structural model validation without rewriting unrelated content.
- `src/maven-environment.ts`: Exclude inherited JVM/Maven injection from isolated acquisition and source checks.
- `src/maven-bootstrap.ts`: Apply the consuming root's pinned resolver graph only to disposable metadata POMs, retaining
  XML namespace bindings and leaving authoritative project files unchanged.
- `src/java-release.ts`: Packages Maven's declared runtime closure and application capabilities using verified
  artifacts; `docs/java-dependencies.md` describes acquisition, activation, frozen checks, and consumer distributions.

---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-3: Finish authenticated streaming artifact installation and filtered caches

## Review summary

Implemented authenticated streaming downloads, bounded filtering, private staging, verified cache reuse, and tool
activation. Real Linux x64 LLVM installations and C/C++ checks passed without the earlier PATH workaround, with about
87% less extracted storage. Detailed measurements and verification follow; hosted platform checks remain in
workbench:TSK-7.

## Progress

- [x] Authenticate and bound streamed artifact acquisition.
- [x] Filter and validate C/C++ installations and cache reuse.
- [x] Verify real Linux tool activation and storage reduction.

## Outcome

Deliver the bounded, authenticated streaming installer described in workbench:ADR-O and prove that filtered native
installations preserve required behavior. Keep source authentication distinct from locally computed output integrity.

## Current state

Streaming filtering, independent C/C++ filters, source/output digests, private staging, cache verification, OpenPGP
verification, and Sigstore verification have draft implementations. LLVM 23 metadata selects Zstandard signatures; LLVM
21 metadata selects provenance attestations. Real Linux x64 C and C++ installations completed source checksum and
OpenPGP verification, streamed filtering, retained-content verification, atomic activation, and exact-version guards in
disposable `/tmp` storage on 2026-10-09. Both configured lint checks passed without an LLVM PATH override. The C filter
retained 673 files totaling 1,595,102,890 bytes; C++ retained 2,362 files totaling 1,607,828,350 bytes. Neither retained
a downloaded archive. An explicit second installation verified and reused the filtered C installation.

After explicit activation in the final platform cache, both language lint checks passed again, followed by all five C
tests and all four C++ tests. Measured installation sizes including manifests and directory metadata were 1,595,348,351
bytes for C and 1,608,984,061 bytes for C++, versus 12,403,258,597 bytes for the old complete extraction: approximately
87% smaller. The disposable `/tmp` installations and build directories were removed; verified toolchains and older
versions remain in shared cache storage. Native execution evidence covers Linux x64 only; other-platform evidence is
limited to frame-header inspection and fixtures.

The PATH investigation found that discovery correctly excluded an older, unfiltered XZ installation: the selected
Zstandard source digest and language filter identify a different installation. The first streamed attempt then exposed a
decompression-window mismatch and removed its staging directory. The pinned LLVM 23.1.2 Zstandard frame headers on all
four native platforms require a 1 GiB window. With explicit human approval, metadata grants those artifacts that cap
while the default remains 128 MiB. Inspection now reports receipt status; failed tool execution includes an explicit
installation hint.

Workbench-managed downloads and vcpkg now select the platform cache's `toolchains/` directory, independently of durable
user-data storage. CI cache paths and keys follow that location, including CI-managed Python installations. Ordinary
checks do not download missing tools; deleting the shared toolchain cache requires explicit reinstallation. Existing
data-directory installations are not relocated automatically. Automatic installed-toolchain pruning is not implemented.
The existing local toolchains and both newly verified LLVM installations were explicitly moved to the cache by atomic
rename, preserving older versions without copying their contents. Thirty-two focused tests cover installation,
filtering, selection, diagnostics, vcpkg, and CI paths; they include cache deletion and explicit reinstallation.

The file-permission fixture now checks actual installed permissions and passes under the scheduler's restrictive umask.
All eleven filtered-artifact tests pass. Lint cleanup made callback returns and diagnostic conversions explicit, reused
archive-text validation for links, and made cancellation wait for every transfer while preserving the original failure.
The early rejection observer remains documented, with failures propagated by the owning await. The complete root commit
gate, including formatting, lint, type checking, bundle verification, structural validation, and all 146 root tests,
passed locally on 2026-10-09. The packaged distribution also validated outside the checkout. Relocated GCC 14.4.0,
15.3.0, and 16.2.0 drivers resolved their support files without rebuilding GCC.

Authentication is now declared for every native asset: signed checksum catalogs for Node and CMake, direct OpenPGP
signatures for Go and GCC, workflow attestations for uv/actionlint/cargo-llvm-cov, and signed GitHub release
attestations for nextest. Downloads without upstream proofs record the absence and its authority explicitly. Trust
material and provenance are documented in `scripts/keys/README.md`; source checksums remain mandatory. Real Linux x64
proofs passed for all of those authenticated tools, including GCC 14.4.0, 15.3.0, and 16.2.0, without compiling GCC.

The Ubuntu 26.04 local CI image now verifies Node's signed catalog and streams its verified bootstrap runtime into
private staging. A real local Docker image build passed and ran the pinned Node version. LLVM's ICU 70 ABI dependency is
installed privately on Linux x64 and ARM64 from an Ubuntu package authenticated through a signed release catalog, pinned
package index, and exact package digest. Linux x64 execution verified LLD and a linked ThinLTO program without changing
host packages or SDKs. ARM64 execution remains part of workbench:TSK-7.

Filtered cache manifests and directory identities now include acquisition policy, trust digests, and resource bounds.
Cache restoration checks the complete retained contents before reuse. Native build fingerprints include selected tool
installation identities, preventing old CMake caches from retaining paths after relocation or filter changes. Hosted CI
has separate exact-path caches for filtered LLVM and its private runtime; installation succeeds before cache saving and
language checks. Source archives and complete LLVM distributions are excluded from those caches.

Ordinary tar downloads now receive bounded streaming preflight before system extraction, including PAX size overrides.
ZIP extraction uses lazy directory iteration, validates entry types and paths, and bounds declared and actual streamed
bytes. Debian payloads use the bounded tar path. Defaults retain 100,000 entries; reviewed GCC metadata permits 200,000
raw headers for GCC 14 and 400,000 for GCC 15/16. Direct inspection found 301,132 raw headers in GCC 15.3.0 and 330,158
in GCC 16.2.0, whose 165,079 members each carry a PAX header. These limits remain independent of filtering.

The complete C and C++ native commit gates passed again on 2026-10-10, including ordinary tests, full and thin LTO,
sanitizers, portable builds, lint, and documentation. The root commit gate passed all 181 tests across 42 files, plus
formatting, lint, types, bundle and license parity, structural validation, shell checks, workflow validation, README
examples, and credential scanning. Instrumented tests also passed all 181 cases with every unchanged coverage floor
satisfied. Coverage reports explicitly note that HEAD has no committed summary for comparison. Coverage verification
caught and fixed a missing language-definition directory and storage hook in its disposable workspace; a regression
checks that copied workspace contract. Native V8 capture now starts only in CLI children, while Vitest measures the test
workers; malformed raw reports still fail with the report filename in the diagnostic. Regression checks preserve CLI
attribution, reject incomplete reports, and verify that ordinary workers do not need duplicate capture. The packaged
distribution passed validation outside the checkout, and explicit warm-cache installation verified and reused both
filtered LLVM installations. Failure fixtures cover signer, digest, filename, repository, release tag, HTTPS, resource
limits, paths, links, staging cleanup, and cache policy changes. Native execution evidence is Linux x64 only;
other-platform and hosted cache execution remain workbench:TSK-7.

## Completion

Real ordinary-archive validation passed for Node 24.21.0, CMake 4.4.4, Go 1.27.1, and GCC 14.4.0/15.3.0/16.2.0; a
disposable Ninja 1.13.2 ZIP installation ran successfully. GCC was not rebuilt. Disposable extraction directories and
the bootstrap test image were removed; older shared toolchains are preserved. Automatic installed-toolchain pruning
remains unimplemented.

Native installation and cache behavior are complete for this task's local Linux x64 verification scope. Hosted cache
restore/save and execution on other supported platforms remain workbench:TSK-7. ADR text remains draft pending human
review; no push or deployment occurred.

Follow-up acquisition maintenance on 2026-10-10 adds automatic native metadata pruning during bundle builds and
read-only rejection of obsolete entries during bundle checks. Active native pins, compiler support declarations,
bootstrap pins, and implicit dependencies retain their supported platform entries; installed caches are preserved. The
current inventory has no obsolete versions. Python compatibility CI selects the existing authenticated uv installer
without installing unrelated development tools. pnpm bootstrap delegates to npm with a committed native lockfile,
disabled lifecycle scripts, registry-signature and attestation auditing, an offline version probe, private staging, and
cached activation. The shared bootstrap definition uses complete project replacement when provided. Real Linux x64
bootstrap verified both installed npm packages' signatures and attestations; a fresh authenticated uv installation ran
all five Python example tests on 3.11.17 and 3.14.8. Integrity, authentication, and version failures remove private
staging without activation. This follow-up does not change package-manager dependency resolution or implement cache
eviction.

Further refactoring on 2026-10-10 gives inventory pruning one atomic publication path after build-time formatting,
shares package-manager pin parsing, and resolves native installation plans through one implementation for inspection and
installation. Help visibility follows the command definitions. Bootstrap tests isolate their caches per case. CI caches
selected native artifacts and their acquisition policy, with independent package-manager bootstrap caches and exact
LLVM/GCC installation paths. Package definitions now declare executable probes and version matching shared by selected
installation and complete environment guards. Probes use the selected installed files, including contained upstream
symlinks; library-only runtime packages use content validation. Bootstrap launchers make nested package scripts use the
same locked manager and selected Node runtime.

The root native CI gate passed all 190 tests across 43 files, every coverage floor, and its formatting, lint, types,
bundle/license, structural, shell, workflow, documentation, advisory, and credential checks. All seven example native
commit gates passed: TypeScript, Python, Rust, Go, C, C++, and React. Real selected-tool installation reused and probed
uv, LLVM, and cargo-llvm-cov successfully on Linux x64. Fresh bootstrap acquisition verified both installed packages'
registry signatures and attestations, and the root build passed through nested pnpm scripts. Regression checks cover
inventory formatting conflicts, package-manager cache isolation, selected-artifact trust changes, executable/argument
contracts, and rejection of a mismatched installed executable despite a matching host tool. Other-platform and hosted
execution remain workbench:TSK-7; no push or deployment occurred.

---
name: workbench-ci-update
description:
  Refresh CI tool versions, action revisions, compiler images, and Debian bases on request in a Workbench project.
  Preserve narrower update or inspection scope; use workbench-ci for failure diagnosis.
---

# CI updates

Read the CI, toolchain, environment, and quality-gate decisions and scoped overrides. Inspect the workflow, registered
language roots, matrix generation, native pins, container definitions, and cache keys to find each version's owner.
Preserve inspection-only and explicitly targeted requests. A general CI update includes checking for newer Debian stable
releases and point releases wherever CI uses Debian directly or through a compiler or workspace image.

Use primary release sources to select maintained stable versions. Keep the full configured OS, architecture,
environment, compiler-family, and supported-release coverage. Refresh patches within supported compiler/runtime lines;
report end-of-life lines or proposed support-boundary changes for human review. Do not raise a language minimum or
substitute a development snapshot merely because a package or image is available. Apply each language decision's
maintenance policy: the shared C/C++ policy covers all upstream-maintained GCC majors and the latest three stable
LLVM/Clang majors, with the latest patch of every selected line. LLVM's older compatibility majors need not remain
upstream-maintained. Check GCC branch-closure announcements and new stable Clang majors; update compiler minima,
complete major coverage, artifact metadata, and documentation together when the human request covers the resulting
support-boundary change. Report scoped exceptions rather than silently extending or narrowing the window.

For Debian bases, use the newest suitable stable release, including its latest point release; testing and unstable need
an explicit request or scoped decision. Check the new suite's compiler repository, prerequisite packages, and native
architecture availability before changing it. Update the base tag and immutable digest together, along with APT suite
names, package pins, and installation commands that depend on that release. For third-party compiler images, verify
their actual Debian base; changing a tag's name does not establish that the requested base exists. Report unavailable
combinations rather than silently changing compilers or architectures. Check that required libc compatibility and any
declared oldest-OS support survive the base update.

For LLVM APT packages, select the intended major release line using versioned package names and the matching signed
repository suite. A major selector does not pin an exact release: inspect package metadata and actual tool output for
patch versions, source revisions, Debian revisions, and prerelease status. Keep installation provenance in committed
package metadata or a pinned environment image. Verify repository signatures and package checksums; use a scoped keyring
rather than disabling authentication. If rolling package availability prevents rebuilding an exact pin, retain verified
inputs through the project's artifact or snapshot mechanism and report that limitation. Native archive pins and
independently pinned CI environments may differ where the project policy permits it; preserve their version checks and
supported minima.

Coordinate compiler, formatter, linter, coverage tools, and required runtimes within each environment. Install the
required distribution components instead of every LLVM package. Preserve exports and runtime dependencies when stripping
publisher-owned binaries, and verify the final stripped artifacts. Update consumers to immutable image digests or
verified archive checksums. For GitHub actions, resolve the chosen release to its full commit revision. Update related
declarations, acquisition metadata, documentation, and cache identities without introducing a second version authority.

When the project publishes toolchains separately, update that publisher's recipes and the consumer's artifact pins as
one coordinated change. Linux container images do not replace native macOS or Windows archives and checks. Preserve the
configured native artifact targets and verify repackaged upstream binaries before choosing a source build.

Guix and Nix updates require a human request covering those environments under ADR-Q. When requested together with CI,
use the applicable guix-update or nix-update skill for their channels, flake inputs, package selections, and image pins.
Their package collections need not match native or APT patch versions. A general CI update alone does not authorize
changing these independently managed environments.

Build and inspect changed containers locally, then run the affected checks in those environments and the applicable gate
using the configured resource scheduler. Verify both native Linux architectures when claimed; identify emulation and
unavailable platforms explicitly. Local verification does not establish a hosted pass. Report old and new base, package,
action, and image selections, sizes where relevant, checks run, and remaining verification. Do not stage, commit, push,
trigger remote workflows, or publish without the user's authorization; retain any review-before-deployment instruction.

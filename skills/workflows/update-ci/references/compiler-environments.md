# Debian bases and LLVM APT packages

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

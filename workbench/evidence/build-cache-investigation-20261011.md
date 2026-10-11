# Build cache investigation — 2026-10-11

## Review summary

The [hosted baseline](https://github.com/greghogan/workbench/actions/runs/38147824694) passed all 34 jobs. Its complete
cache working set was **14.61 GB compressed across 91 exact keys**, with Zstandard level 3. The repository retained
10.72 GB in 37 entries at the final inventory; 54 keys used by this run were absent. Inventory after eviction is not the
working-set size. All sizes here use decimal GB/MB.

Level 9 remains selected for future saves. Local samples confirm useful savings beyond LLVM, but compression alone does
not establish that the full matrix fits the cache allowance. The simplest next reduction is to omit installed dependency
trees from hosted archives, retaining package download stores and useful compiled outputs. Local development can keep
its installed dependencies. No language support, compiler matrix, or retention policy was changed by this investigation.

Detailed measurements, exact hosted keys, profiling conditions, exclusions, and checks are retained in
[the evidence JSON](build-cache-investigation-20261011.json).

## Where the space goes

| Cache group                       | Compressed GB | Finding                                                                          |
| --------------------------------- | ------------: | -------------------------------------------------------------------------------- |
| Other native tools                |         4.065 | JDKs, runtimes, CMake, vcpkg, and other tools; broad archives overlap.           |
| LLVM and older Clang              |         4.022 | Six filtered archives; the preceding reduction saved 2.827 GB.                   |
| Builds and installed dependencies |         2.429 | Combines project outputs, installed dependencies, Go cache, and container tools. |
| Rust toolchains                   |         2.239 | Includes stable, minimum Rust, and manual-only Miri.                             |
| Package downloads                 |         0.745 | Package managers validate these reusable inputs.                                 |
| Compiled GCC                      |         0.510 | Six expensive installations, already stripped.                                   |
| Guix source/authentication        |         0.484 | Channel acquisition and authentication remain separate from application builds.  |
| Package-manager bootstrap         |         0.112 | Small relative to the SDKs.                                                      |

Only 6 of 31 jobs restored a build archive. Thirteen misses had changed keys; twelve used unchanged keys from the
preceding run. The unchanged misses and missing final entries are consistent with eviction, although these measurements
are not an eviction audit log. Both invalidation and capacity matter.

## Reuse value in the examples

The local profile used Ubuntu 26.04 on Linux x64, four CPUs per root, at most six parallel roots, and `benchctl hold`.
Verified tool and package download stores were available in every pass. Fresh outputs means absent project build,
dependency, and Go compilation directories, rather than an empty machine.

Commands ran each example's ordinary test role with required setup. C and C++ additionally ran their sanitizer and LTO
roles. These are exploratory single observations on a shared host, not controlled runtime benchmarks or complete CI
rehearsals.

| Example    | Fresh outputs, seconds | Cached outputs with fresh source mtimes | Compiled outputs retained; dependencies recreated |
| ---------- | ---------------------: | --------------------------------------: | ------------------------------------------------: |
| C          |                   73.9 |                                    12.1 |                                              11.0 |
| C++        |                   80.6 |                                    13.2 |                                              11.0 |
| Rust       |                    9.6 |                                     1.9 |                                               1.2 |
| Go         |                   16.3 |                                     2.3 |                                               2.5 |
| Python     |                    8.2 |                                     3.8 |                                               3.6 |
| TypeScript |                    6.8 |                                     3.2 |                                               3.5 |
| JavaScript |                    5.2 |                                     3.1 |                                               3.7 |
| React      |                    8.2 |                                     3.7 |                                               5.8 |
| Java       |                   11.7 |                                     8.6 |                                               9.7 |
| Ruby       |                    6.7 |                                     2.7 |                                               6.4 |
| PHP        |                    9.4 |                                     5.7 |                                               7.7 |

All 60 example role invocations passed. C/C++ dependencies and build variants account for most of the clear reuse
benefit. Java deliberately rebuilds application classes to prevent stale outputs; its compatibility output archives are
only about 34 KB each. The large Java cost is the installed JDK, not its application build output. Python and Node
installed trees mainly save a few seconds in these examples. Ruby and PHP also showed modest installed-tree savings.

Workbench's 375 root tests passed after correcting the private profiling fixture. Two initial attempts passed 374 tests
and failed the standalone packaging test because the copied source lacked Git metadata. Those attempts are excluded from
runtime conclusions. Adding a private empty Git commit corrected the fixture; the primary checkout and index were not
changed.

## Compression beyond LLVM

| Local sample                         | Level 3, MB | Level 9, MB | Reduction |
| ------------------------------------ | ----------: | ----------: | --------: |
| Filtered LLVM, preceding measurement |       672.8 |       589.4 |     12.4% |
| Stable Rust                          |       298.0 |       266.1 |     10.7% |
| Miri Rust                            |       215.4 |       193.0 |     10.4% |
| Node, Go, Java, and supporting tools |       267.3 |       243.7 |      8.8% |
| Compiled outputs and Go cache        |        86.4 |        69.1 |     19.9% |
| All installed dependencies           |       231.6 |       204.5 |     11.7% |
| vcpkg checkout                       |        72.8 |        70.4 |      3.3% |

All 24 new archive/decode measurements passed complete tar-stream SHA-256 comparison. These used the default window and
four compression workers. The first pass encountered cold filesystem reads; later passes were warm. Their elapsed times
are therefore not a controlled comparison of compressor speed. No archives were retained after verification.

Applying these category-specific sample ratios to the hosted groups gives an illustrative working set of about **13.2
GB** at level 9, holding unmeasured groups constant. It remains an extrapolation across platforms and workloads, not a
measured hosted result. Omitting installed dependency trees would remove 204.5 MB from this local sample alone; the
hosted savings depend on each target's dependency selection. Compression by itself is insufficient.

## Additional findings

### Selected-root combinations create more cache entries

C alone and C plus C++ produce different tools keys while archiving the exact same four paths. The key includes
root-qualified vcpkg pin inputs, so identical installations receive different identities. More broadly, native tool,
download, and build keys depend on the selected roots. A single full-run working set therefore understates storage
across different affected-root selections and branches.

Normalize identical tool identities first. Per-tool archives could then share verified installations between native,
compatibility, and Dev Container jobs while keeping platform, architecture, ABI, filter, authentication, and resource
identities. This belongs in shared CI orchestration; independent examples need no shared installed dependency tree.

### Ordinary CI installs unused Miri

Native installation includes Miri whenever its pin file exists, although both Miri checks have empty stage lists and are
manual. The complete configured native Rust CI-stage gate passed locally with Miri's installation hidden behind an
empty, read-only bind mount. Stable Rust and required coverage tools remained available. The native installation phase
itself still requests Miri; phase-aware tool selection is needed to remove that unnecessary acquisition.

The Linux x64 Miri sample occupies about 729 MB as a tar stream and 193 MB compressed at level 9. Its bytes on other
platforms were not isolated, so multiplying this sample by every platform is only an approximation. Keep Miri available
for its explicit workflow and retain rustup-managed manifests; do not delete arbitrary Rust SDK files.

### Pin-only build keys do not refresh application outputs

Actions cache entries are immutable. A key determined by tool and dependency pins restores its first saved snapshot
after code-only changes, then declines to replace that snapshot. Build systems still detect changed source correctly,
but the archive does not continually learn the latest incremental outputs. The examples' application code is small;
elaborate snapshot rotation should be justified before adding retention churn.

### Further tool filtering has smaller, specific opportunities

The inspected CMake installation allocates 217.5 MB, including 63.1 MB of HTML documentation and 124.6 MB of binaries.
GUI and duplicate documentation filtering merits a separate measured check while retaining command-line tools, modules,
help resources, and licenses. The vcpkg checkout compresses to about 70 MB at level 9; much of its Git history is
already compressed. Native compiler-support archives share vcpkg, CMake, Ninja, and Node across several broader tool
bundles.

Go's standard-library sources and compiler tools are working SDK inputs. Node headers can be needed by native package
builds. Rust compiler libraries, standard libraries, coverage components, and supported component ownership should be
preserved. Removing documentation or compiler test data can be assessed narrowly; arbitrary SDK trimming or stripping is
not supported by the current evidence. Large prebuilt JDK caches are another policy choice: verified reacquisition may
be preferable to evicting expensive source-built tools, but that tradeoff needs acquisition timing before changing it.

### Guix duration is mostly an environment bootstrap issue

The Guix environment step took 2,550 seconds. Its first root took about 1,972 seconds, including roughly ten minutes
updating channel history, four minutes authenticating 134,711 commits, and later Guix derivation builds/substitutions.
The unchanged source/authentication cache key missed and was saved again at job end. Subsequent roots shared that job's
environment. Application build archives will not eliminate this bootstrap cost. Investigate channel/authentication cache
reuse separately; whole Nix/Guix stores would compete with the already crowded Actions cache.

### Local persistent variants need separate cleanup

The local inventory found 988 marked variants across 347 namespace/checkout/root/environment groups. Deduplicating
hard-linked files globally gives **35.17 GB logical and 38.49 GB allocated** across build, dependency, Go, and container
caches. Summing each variant independently would overstate this usage.

The 641 variants beyond one per group are not automatically obsolete: multiple compiler selections and environments can
be intentional. There is no bounded generation retention or last-use ledger for these build variants. Existing explicit
project clean/distclean operations are available. A broader pruning facility should preview owned candidates, preserve
active selections, acquire the relevant locks, and retain selected generations. No persistent cache was deleted here.

## Recommended order

1. Keep level 9, package download stores, and useful compiled outputs; omit installed dependency trees from hosted
   saves.
2. Select tools for executed CI phases, avoiding acquisition of manual-only Miri during ordinary CI.
3. Normalize redundant cache identities, then assess per-tool archives against the added orchestration complexity.
4. Investigate Guix bootstrap cache reuse and add safe local variant pruning separately.
5. Re-estimate the working set with margin for branches and changing pins. A reduced hosted Clang matrix remains a human
   policy choice; keeping additional versions in local CI would require explicit hosted selection while preserving the
   complete local target plan.

These changes should preserve all checks and example independence. They are recommendations from investigation, not
implemented retention changes or a claim that the resulting cache will fit a particular allowance. No new full hosted
run or deployment was started.

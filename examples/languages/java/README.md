# Java reference

A standalone Maven project with strict compiler warnings, Google Java Format through Spotless, SpotBugs, JUnit, and
JaCoCo. Java 17 is the minimum runtime and API target. Native development uses Temurin 25 LTS; compatibility checks run
on the maintained LTS lines and the Current release listed in the project registry. The compiler's `--release` setting
checks Java 17 syntax, class-file format, and platform APIs even when development uses a newer JDK.

`.java-version` pins the full upstream release and build; `.tool-versions` pins Maven. Native installation checks both
recorded archive SHA-256 digests and upstream detached signatures. Nix and Guix independently pin their own development
tools. The reference also uses Workbench's Dev Container support. Native platforms are Linux x64/arm64, macOS arm64, and
Windows x64; Windows requires Git Bash. Managed Linux environments use the same POM and trusted checksum index.

`pom.xml` owns exact dependency and plugin requirements, the minimum release, strict diagnostics, parallel tests,
coverage floors, and the executable JAR manifest. `.mvn/checksums/checksums.sha256` records a compact SHA-256 allowlist
using [Maven's native trusted checksum support](https://maven.apache.org/resolver/expected-checksums.html). Maven
verifies artifacts when resolving them, including cache hits and plugins' dynamic dependencies; absent or mismatched
hashes fail. Ordinary checks never record new hashes. Explicit dependency updates regenerate the allowlist by running
all configured build tools, then review it and rerun frozen checks. This verifies inputs without sandboxing plugins. The
checked-in settings route every repository to Google's Maven Central mirror. A single content-hash index works across
the independently selected Maven versions; Maven retains its own repository-provenance tracking.

Workbench keeps Maven's repository under its external cache, shared across roots, and separates compiled outputs by
checkout, root, environment, and input fingerprint. The allocated CPU count controls Maven, the JVM, and JUnit workers.
A copied project can also invoke Maven directly, supplying its chosen repository and build locations.

The static Makefile delegates to configured commands: `make` builds, `make check` runs the commit gate, `make test` runs
ordinary tests, and `make coverage` runs instrumented tests, enforces the POM floors, and presents coverage changes.
Coverage summaries record lines, branches, and methods; bytecode instructions are not reported as statements. `make fmt`
formats Java sources. `make release` produces the standalone `dist/count.jar`, verified outside the source checkout with
`java -jar count.jar 97 banana`, which prints `3`. `make clean` removes disposable build outputs and reports; shared
downloads remain cached.

The gate verifies this console example after building:

```console
$ java -cp "${WORKBENCH_BUILD_DIR}/java/target/classes" org.example.workbench.Count 97 banana
3
```

The formatter is pinned to Google Java Format 1.36.1: 1.37 changes its style API and is incompatible with the selected
Spotless release. `.mvn/jvm.config` declares the formatter's compiler-module access. Maven's file locks coordinate the
shared repository between processes. Maven, the JVM, SpotBugs, and JUnit receive the complete CPU allocation.

The Guix Maven package uses Guice 4.1, which needs the declared `java.base/java.lang` access on modern JDKs. The
manifest selects both the runtime and `jdk` outputs of OpenJDK so the compiler is available. Security overrides in the
POM update the plugins' Plexus reporting and archive dependencies; the advisory check includes these build tools. Its
Resolver 1.9.4 reads the unprefixed `checksumAlgorithms` property, so the Maven configuration selects SHA-256 through
both that key and the current Resolver key.

Dependency updates use the configured `dependency-lock` role through
`workbench checks run --role dependency-lock --path ROOT`, or Maven's documented trusted-checksum recording mode.
Recording runs formatting checks, tests, coverage, analysis, and packaging, and replaces the index with the artifacts
resolved by that session. Review changed versions and hashes before ordinary checks. No lock extension or alternate
package manager is required.

When supporting several managed Maven versions, record each environment into a fresh index and combine the resulting
artifact paths and hashes, rejecting conflicting hashes. This retains metadata needed by each resolver while dropping
unused artifacts from previous requirements. Verify the combined index with every configured environment.

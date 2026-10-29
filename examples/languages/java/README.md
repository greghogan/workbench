# Java reference

A standalone Maven project with strict compiler warnings, Google Java Format through fmt, SpotBugs, JUnit, and JaCoCo.
This example selects Java 17 as its minimum runtime and API target in the POM; consuming projects choose their own
target independently of the JDK required to run build tools. Native development uses Temurin 25 LTS. CI uses the
selected native JDK on each native platform and independently pinned Nix/Guix JDKs in prepared Linux environments.
Additional compatibility profiles can verify other runtime promises. The compiler's `--release` setting checks Java 17
syntax, class-file format, and platform APIs even when development uses a newer JDK.

`.java-version` pins the full upstream release and build; `.tool-versions` pins Maven. Native installation checks both
recorded archive SHA-256 digests and upstream detached signatures. Nix and Guix independently pin their own development
tools. The reference also uses Workbench's Dev Container support. Native platforms are Linux x64/arm64, macOS arm64, and
Windows x64; Windows requires Git Bash. Managed Linux environments use the same POM and trusted checksum index.

`pom.xml` owns exact dependency and plugin requirements, the minimum release, strict diagnostics, parallel tests,
coverage floors, and the executable JAR manifest. `.mvn/checksums/checksums.sha256` records a compact SHA-256 allowlist
using [Maven's native trusted checksum support](https://maven.apache.org/resolver/expected-checksums.html). Maven
verifies artifacts when resolving them, including cache hits and plugins' dynamic dependencies; absent or mismatched
hashes fail. Ordinary checks never record new hashes. Explicit dependency updates prepare authenticated inputs
separately from execution, then activate the inspected proposal and rerun frozen checks. This verifies inputs without
sandboxing plugins. The checked-in settings route every repository to Google's Maven Central mirror. A single
content-hash index works across the independently selected Maven versions; Maven retains its own repository-provenance
tracking.

Workbench keeps Maven's repository under its external cache, shared across roots, and separates compiled outputs by
checkout, root, environment, and input fingerprint. The allocated CPU count controls Maven, the JVM, and JUnit workers.
A copied project can also invoke Maven directly, supplying its chosen repository and build locations.

Formatting writes back only changed Java files and rejects conflicts with edits made during the run. Other concurrent
edits and new files remain intact. Test reports in `coverage/surefire/` describe one run at a time; renamed or deleted
tests leave no stale reports. The retained `.workbench-run.json` identifies the run and whether its reports passed,
failed, or were missing.

The static Makefile delegates to configured commands: `make` builds, `make check` runs the commit gate followed by
online checks when reachable, `make test` runs ordinary tests, and `make coverage` runs instrumented tests, enforces the
POM floors, and presents coverage changes. Coverage summaries record lines, branches, and methods; bytecode instructions
are not reported as statements. `make fmt` formats Java sources. `make release` produces the application distribution
`dist/count/`, verified outside the source checkout. `java -jar dist/count/count.jar 97 banana` prints `3`. Maven
derives the exact runtime dependency closure in the JAR manifest; packaging copies each checksum-verified JAR and its
publisher POM into relative `lib/` paths. Original JARs retain their embedded licenses and notices. Replacing this
application distribution removes stale runtime dependencies without touching other applications. `make clean` removes
disposable build outputs and reports; shared downloads remain cached.

The gate verifies this console example after building:

```console
$ java -cp "${WORKBENCH_BUILD_DIR}/java/target/classes" org.example.workbench.Count 97 banana
3
```

The POM pins Google Java Format and its fmt Maven integration. `.mvn/jvm.config` declares the formatter's
compiler-module access. Maven's file locks coordinate the shared repository between processes. Maven, the JVM, SpotBugs,
and JUnit receive the complete CPU allocation. The complete Temurin release in `.java-version` is available across the
supported native platforms.

The declared `java.base/java.lang` access also supports Maven distributions using Guice 4.1 on modern JDKs. The Guix
package retains its JRE runtime; its development manifest selects the `jdk` output and removes the JRE output from the
shell path so the compiler and its modules remain available. Security overrides in the POM keep formatter, reporting,
and archive dependencies on patched releases; the advisory check includes these build tools. Older Resolver versions
read the unprefixed `checksumAlgorithms` property, so the Maven configuration selects SHA-256 through both that key and
the current Resolver key.

Dependency updates use the configured `dependency-lock` role or
`workbench tools maven prepare --path ROOT --output DIR`. The starter's `.mvn/acquisition.json` pins the resolver;
declare independently established signer fingerprints and key files for new artifacts, or explicit
unavailable-authentication evidence. Preparation returns verified artifacts and a checksum/evidence proposal without
running project formatting, compilation, tests, or analysis. Review it, then run
`workbench tools maven accept --path ROOT --proposal DIR` and the normal frozen checks. A signature failure cannot
become unsigned acceptance. See Workbench's
[dependency workflow](https://github.com/greghogan/workbench/blob/main/docs/java-dependencies.md).

The application release is the default. An optional `.mvn/runtime.json` selects `kind` (`application` or `library`),
`nativeAccess` module names (for example `ALL-UNNAMED` for a JNI library), and additional JVM `modules`. Capabilities
apply to this application's tests and launchers, not global JVM settings. The generated `run` and `run.cmd` launchers
select those flags; ordinary dependency-free applications can also use `java -jar`. Library mode keeps the project JAR
thin.

The minimal Nix/Guix package recipes compile the dependency-free reference directly with the JDK. Dependency-bearing
applications should use their frozen Maven build and the same application packager within the selected managed shell;
the direct-JDK recipe is not a general Maven resolver. Managed package recipes must declare their runtime closure and
JRE modules as package inputs when adopting external libraries. Projects own any additional upstream license files
required beyond the notices retained in dependency JARs and POM license declarations.

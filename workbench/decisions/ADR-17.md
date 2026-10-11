---
summary: Maintained JDKs, explicit release targets, strict checks, verified dependencies, and portable JARs.
---

# ADR-17: Java implementation

Apply ADR-9. Use a maintained OpenJDK distribution with an explicit support policy; the reference uses Eclipse Temurin.
Pin native development to the newest suitable LTS JDK and test the declared maintained LTS lines and Current release.
The initial baseline is Java 17 because the selected testing tools require it; Java 8 and 11 are excluded despite their
continued availability. Review this choice with tooling and upstream maintenance changes.

Separate development JDK selection from the project-owned minimum runtime and compiler release target. Compile with
`--release` to constrain syntax, bytecode, and Java SE API availability. Verify behavioral compatibility on the declared
runtimes as well. Projects may raise their release baseline. Managed environments own their selected JDK versions.

Pin plugins and dependencies, including transitive artifacts, and enforce reviewed content hashes through build-system
tooling, including cached artifacts. Missing or mismatched hashes fail; only explicit dependency updates record new
hashes. Use external build and repository caches without changing user-wide settings. Acquisition follows ADR-O; keep
the reference's Maven configuration and checksum maintenance in its documentation.

Enable strict compiler diagnostics, static analysis, canonical formatting, tests, and coverage as separate roles.
Publish portable JARs with a declared minimum runtime and verify them outside the source checkout. Language servers use
the selected JDK and project model; they do not silently substitute a global runtime.

Rationale: A newer development JDK can enforce an older platform contract, while runtime tests and verified dependency
inputs make the compatibility and build claims observable.

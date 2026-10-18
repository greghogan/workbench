---
summary: Maintained JDKs, project-owned release targets, verified build dependencies, strict checks, and portable JARs.
---

# ADR-14: Java

Use a maintained OpenJDK distribution with an explicit support policy. Native development prefers the newest suitable
LTS JDK. Select compatibility profiles from maintained LTS and Current releases.

Projects declare their application minimum independently of the development JDK and build-tool runtime requirements.
Constrain syntax, bytecode, and Java SE APIs to that target and verify behavior on declared runtimes.

Pin plugins and dependencies, including transitives. Build-system tooling enforces reviewed hashes even for cached
artifacts; missing or mismatched hashes fail, and only explicit dependency updates record replacements.

Publish portable JARs with a declared minimum runtime. Release verification follows ADR-S.

Rationale: Separate application and tool requirements permit newer development JDKs without imposing unnecessary
application baselines; runtime evidence and verified dependencies make the contract observable.

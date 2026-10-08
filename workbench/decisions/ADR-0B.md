---
summary: Pins, support minima, strict checks, language servers, updates.
agent_instruction: Use authoritative tool and dependency pins; do not weaken checks merely to make changes pass.
---

# ADR-B: Toolchains and engineering constraints

Pin development and CI compilers, runtimes, package managers, and check tools to exact versions, directly or through a
pinned environment. Commit dependency lockfiles and use locked installs. Keep versions and commands in manifests,
environment definitions, and reference documentation; update pins deliberately with matching locks and verification.

Each tool has one authoritative version selection per execution environment, owned by native toolchain files or a pinned
environment. Scopes, language roots, and supported environments may select different toolchains. Secondary declarations
consume that selection, are generated from it, or are checked against it. Language lockfiles own package-managed check
tools; avoid competing environment installations.

Every required native pin has a documented, tested installation and selection path on supported platforms. Delegate to
language installers or verified upstream artifacts. Explicit setup installs tools into persistent user storage; ordinary
checks select and verify installed tools. Keep downloadable archives in disposable cache and preserve global defaults.

Resolve language servers from each language root's declared tooling and selected development environment, with its
dependencies and sysroot or interpreter. Shared installations may supply executables, but project declarations select
their versions; do not silently substitute global tools.

Prefer upstream-maintained stable release lines, including security-maintenance branches. Start support at the oldest
maintained line where practical; document exclusions required by features, dependencies, or platforms. Examples avoid
unnecessary newer-language requirements. Review support at upstream end of life and during toolchain or dependency
updates.

When selecting or updating a minimum, use the latest patch of the oldest supported maintained release line. An older
patch floor requires a documented scoped exception, including constraints from supported pinned environments.

Development pins and supported ranges are distinct. Use the newest suitable maintained releases for development,
respecting language-specific release policies and availability in pinned environments. Configure static checks for the
supported language baseline where the tools allow it. Projects configure their own release targets and may raise the
baseline. Native language declarations own runtime support requirements; consuming check configuration must agree with
them. Compiler families and language standards are independent project choices. CI executes behavioral tests on every
maintained release line within the declared support range, as well as declared minima and other claimed compatibility
boundaries. Language decisions may specialize release-line coverage where upstream has a different maintenance model.
Language decisions may document an alternative minimum policy. Libraries may publish dependency ranges while locking
their development and test environment.

Each supported language provides a dependency-update skill covering requested scope, manifest requirements, lockfiles,
and configured verification. A general dependency upgrade considers current stable releases, including major versions;
inspection-only, compatible-only, and lockfile-only requests retain their narrower scope. Preserve declared support
boundaries and environment pins unless their change is part of the request.

Configure canonical formatting with explicit write and read-only modes, strict linting and type checking, and behavioral
tests. Prefer strict, mechanically validated subsets and formats over human editing convenience. Enable broad strict
rule sets; resolve contradictory or formatter-owned rules explicitly and review new rules with tool upgrades. Explain
narrow suppressions. Do not relax checks, coverage thresholds, types, or meaningful assertions merely to pass a change;
intentional policy changes follow decision review.

Language decisions and the environment policy in ADR-R specialize this baseline. Projects choose equivalent tools when
appropriate and document exceptions in scoped decisions.

Rationale: Explicit ownership prevents accidental tool substitution. Pinned inputs and consistent checks constrain agent
changes, while tested support boundaries distinguish compatibility promises from development preferences.

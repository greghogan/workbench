---
summary: Pins, support minima, strict checks, language servers, updates.
agent_instruction: Use authoritative tool and dependency pins; do not weaken checks merely to make changes pass.
---

# ADR-9: Toolchains and engineering constraints

Language specifications use ADR-1's complete replacement mode, including commands. Inspection identifies shared
definitions, local replacements, and local additions. Native manifests, toolchain files, and lockfiles are
project-owned; copying a reference does not authorize future replacement.

Compatibility execution uses the selected definition's commands as well as its declared runtime range. Shared runners
prepare verified tools; project-owned commands define application tests, artifact names, and release behavior.

Pin development and CI tools exactly, directly or through a pinned environment. Commit dependency locks and use locked
installs. Each tool has one authoritative version per root and environment; secondary declarations derive from it or are
checked against it. Language locks own package-managed check tools. Update pins deliberately with matching locks and
verification; libraries may separately publish dependency ranges.

Required native pins have documented, tested installation and selection paths on every supported platform. Delegate to
language installers or verified upstream artifacts. Explicit setup installs tools in user storage without changing
global defaults; ordinary checks select and verify them. Acquisition inventories cover active pins and their required
dependencies, remove unused metadata, and preserve required platform coverage without deleting installed tools. Keep
maintenance procedures in the tooling guide.

Language servers use the root's declared tools, selected environment, dependencies, and sysroot or interpreter. Shared
installations may supply executables; project declarations select versions without silent global substitution.

Prefer upstream-maintained stable lines, including security maintenance. Start support at the oldest maintained line
where practical, using its latest patch whenever selecting or updating a minimum. Document exclusions and older patch
exceptions, including pinned-environment constraints. Review support at end of life and during dependency or toolchain
updates; examples avoid unnecessary newer-language requirements.

Develop on the newest suitable maintained release available in the selected environment, respecting language-specific
policies. Target the supported baseline with static checks where possible. Projects may raise release targets and
independently choose compiler families and language standards. Native language declarations own runtime requirements;
check configuration must agree. Declare runtime and compiler profiles for the compatibility boundaries that the project
promises to verify. Use the same selections locally and in CI; an environment owns its versions independently. Static
targeting alone does not prove behavioral compatibility. Reference examples demonstrate selected development tools and
minimum API targeting; they need not repeat exhaustive release-line matrices. Language decisions guide support-line
selection.

Each language supplies a dependency-update skill covering manifests, locks, and verification. General upgrades consider
current stable releases, including majors; narrower requests retain their scope. Preserve support boundaries and
environment pins unless their change is requested.

Require canonical formatting with write and read-only modes, broad strict linting, type checking, and behavioral tests.
Prefer mechanically validated formats. Resolve contradictory and formatter-owned rules, review new rules on upgrades,
and explain narrow suppressions. Do not weaken checks, coverage floors, types, or meaningful assertions merely to pass a
change. Policy changes require decision review. Projects may choose equivalent tools and record scoped exceptions.

Coverage includes all project-owned shipped code, including libraries and executable entry points. Include unexecuted
production files and subprocess execution; exclude dependencies and third-party generated code.

Rationale: Explicit ownership prevents accidental tool substitution. Pinned inputs and consistent checks constrain agent
changes, while tested support boundaries distinguish compatibility promises from development preferences.

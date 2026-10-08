---
summary: Node LTS, compiler strictness, typed linting.
---

# ADR-H: TypeScript projects

Apply ADR-B. New roots adapt the executable reference. `packageManager` owns the package-manager pin; package metadata
and the lockfile own compiler and check tools. Runtime requirements such as `engines.node` declare supported versions,
separately from the development runtime pin.

Default native development and production to the newest Node LTS line. Prefer compatibility with maintained LTS lines
and the Current line where tooling permits; verify supported targets in CI. Use the
[Node release schedule](https://nodejs.org/en/about/previous-releases) when selecting lines and reviewing support.

Keep compiler output targets, library declarations, and runtime API types compatible with the declared support baseline
while using newer development tools.

Enable strict types, checked indexed access, exact optional properties, and explicit overrides. Configure formatting,
type-aware linting, type checking, and tests as separate checks. Prefer the strict typed and stylistic lint presets; the
formatter owns layout. Record any exclusions beside the configuration.

Existing projects may configure equivalent checks without replacing their files. Validation checks configured behavior,
not conformity to starter files.

Rationale: Strong initial checks expose mistakes at boundaries while allowing projects to choose tools and structure
that fit their needs. Tool versions and temporary integration workarounds belong with the executable reference.

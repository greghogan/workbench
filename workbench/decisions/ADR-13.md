---
summary: Latest stable Node development, supported API baselines, compiler strictness, typed linting.
---

# ADR-13: TypeScript projects

Apply ADR-9. New roots adapt the executable reference. `packageManager` owns the package-manager pin; package metadata
and the lockfile own compiler and check tools. Runtime requirements such as `engines.node` declare supported versions,
separately from the development runtime pin.

Default native development to the newest stable Node release, including Current; default production deployments to the
newest LTS line. Use the latest patch of each supported maintained LTS line and the supported Current line when
selecting project compatibility profiles under ADR-9. Use the
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

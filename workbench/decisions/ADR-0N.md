# ADR-N: TypeScript projects

Summary: TypeScript projects start with strict types, pnpm, type-aware ESLint, Prettier, and Vitest.

Initialize each selected TypeScript root from the executable reference, `examples/languages/typescript`. Pin pnpm and
commit its lockfile. The starter enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
`noImplicitOverride`; it also supplies type-aware ESLint, Prettier, Vitest, and a nonmutating `check` command. Run
type checking separately from builds and tests. Vitest projects can group packages and add coverage as needed.

The reference tests TypeScript 7's native compiler. Until type-aware ESLint supports its programmatic API, a compatible
TypeScript 6 package supplies the lint parser's API while the TypeScript 7 compiler remains authoritative for
type-checking. Project checks validate the configured commands, not conformity to starter defaults; later divergence
is allowed.

The reference is a starting point, including for large or mixed-language repositories, not a file-by-file mandate.

---
summary:
  Node release policy, independent API targets, strict authoring, distinct language definitions, and portable releases.
---

# ADR-11: Node, TypeScript, and JavaScript

`packageManager` owns the package-manager pin; package metadata and locks own compiler and check tools. Runtime
requirements such as `engines.node` declare support independently of development pins.

Default native development to newest stable Node, including Current, and production to newest LTS. Select compatibility
profiles from maintained LTS and Current lines using the
[Node release schedule](https://nodejs.org/en/about/previous-releases). Align output syntax, library declarations, and
runtime API types with the application baseline despite newer tools.

Use strict TypeScript checking and type-aware linting. JavaScript uses strict JSDoc checking while remaining executable
without transpilation. Keep separate complete language definitions and executable examples for TypeScript and
JavaScript.

Node-based releases follow ADR-S and declare whether a compatible runtime is supplied by the user's environment or
included in the artifact. A platform-neutral JavaScript payload may require installed Node; a self-contained release
includes a compatible runtime for each supported operating system and architecture.

Rationale: Shared runtime policy avoids duplicated Node rules while distinct authoring and test paths verify each
language's contract. Explicit runtime requirements let projects choose distribution formats independently of authoring
tools without overstating portability.

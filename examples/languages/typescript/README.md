# TypeScript reference

This small Node project demonstrates the TypeScript 7 compiler, strict type checking, a committed pnpm lockfile,
type-aware ESLint, Prettier, and Vitest. TypeScript 6 currently supplies the ESLint parser API; it is not the
authoritative type checker. The optional Guix and Nix definitions provide host tools; pnpm's lockfile governs project
packages.

`make clean` removes build outputs and coverage; `make distclean` also removes `node_modules`.

# Language definitions and examples

[Workbench overview](../../README.md). Commands assume your project root; `workbench` denotes the executable in your
pinned distribution.

A local language replacement supplies the entire definition and the corresponding Workbench definition is ignored. There
is no field-by-field or command-by-command merge with the inherited language. A complete local definition may add a
language that Workbench does not supply. Updating Workbench changes inherited definitions; local replacements and
starter copies retain their ownership. Agents can compare them with upstream before making explicit changes.

Shared language definitions live in `languages/<id>/`: `config.toml` declares identity, manifest detection, and the
reference location and optional `starter` file list; `automation.toml` declares reusable `[[command]]` entries.
`languages/index.toml` lists the bundled identities. Language-specific assets, such as C and C++ LLVM filters, belong to
the selected definition directory.

A consumer references these files through its pinned `.workbench/` distribution. An optional `workbench/languages/<id>/`
directory selects a complete local definition with both configuration files and any required assets. Use lowercase
identities containing letters, digits, and hyphens, beginning with a letter. A local definition may add a language
absent from the distribution. The resolver opens the selected definition only; missing local files fail instead of
falling back to the ignored shared definition. Inspection reports its source and location. `reference` is relative to
the distribution root for shared definitions, or the consuming repository root for local ones; `manifests` lists paths
relative to a language check root. Custom command suites do not automatically add native installer or
compatibility-matrix adapters for a new runtime.

`workbench/projects.toml` binds definitions to project directories and selects project-specific compatibility and
compiler options. `[[check_suite]]` in `workbench/automation.toml` selects the complete command suite for a registered
root; additional project commands remain independent. Starter initialization copies project-owned native files and adds
a suite selection rather than copying the shared commands.

Runnable projects remain under `examples/languages/` and `examples/frameworks/`. The
[React example](../../examples/frameworks/react/README.md) uses the TypeScript command suite with project-owned React
dependencies, JSX, Hooks linting, component tests, and an esbuild static build. Framework examples do not require
framework ADRs or a separate framework configuration mechanism. React CI selects Linux x64 for native, Guix, Nix Docker,
and Dev Container checks, without additional runtime compatibility jobs. Direct Nix uses the same locked flake as Nix
Docker.

The native lint configuration is project-owned. Shared language automation invokes it; initialization copies starter
rules into a new project, and updating Workbench does not rewrite existing copies.

| Reference                                                           | Lint and type baseline                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [TypeScript](../../examples/languages/typescript/eslint.config.mjs) | Strict typed ESLint presets, additional correctness rules, exhaustive switches, and zero warnings; strict compiler options.                      |
| [JavaScript](../../examples/languages/javascript/eslint.config.mjs) | Strict typed ESLint plus checked JSDoc through `allowJs`/`checkJs`; source-preserving builds.                                                    |
| [Java](../../examples/languages/java/pom.xml)                       | All compiler lint warnings as errors, SpotBugs at maximum effort and low threshold, Spotless formatting, and an explicit `--release` API target. |
| [Ruby](../../examples/languages/ruby/.rubocop.yml)                  | Broad RuboCop rules, Ruby 3.3 syntax targeting, explicit RBS signatures and strict Steep diagnostics.                                            |
| [PHP](../../examples/languages/php/phpstan.neon)                    | Strict types, maximum-level PHPStan with an explicit API baseline, broad PHP CS Fixer rules and verified Composer distributions.                 |
| [React](../../examples/frameworks/react/eslint.config.mjs)          | TypeScript baseline plus React Hooks checks; both `.ts` and `.tsx` files are covered.                                                            |
| [Python](../../examples/languages/python/pyproject.toml)            | All stable Ruff rules with documented exclusions; strict mypy, unreachable code, and exhaustive matches.                                         |
| [Rust](../../examples/languages/rust/Cargo.toml)                    | Clippy default, pedantic, nursery, and selected restriction rules; all workspace members and targets, with warnings denied.                      |
| [C](../../examples/languages/c/.clang-tidy)                         | Broad clang-tidy groups and strict compiler warnings, treated as errors; configuration validated before analysis.                                |
| [C++](../../examples/languages/cpp/.clang-tidy)                     | C baseline plus modernization and C++ Core Guidelines, with documented style exclusions.                                                         |
| [Go](../../examples/languages/go/scripts/check.mjs)                 | Module integrity and tidy checks, go vet, and all Staticcheck checks.                                                                            |

Named development and release profiles implement the draft [ADR-Y](../../workbench/decisions/ADR-0Y.md). See the
[profile guide](../../workbench/guides/profiles.md) for local selection, managed Dev Containers, verified packaging, and
completion installation. Human review and hosted publication verification remain pending.

### Language targets and C/C++ compiler selection

Projects configure supported runtime releases in native declarations, separately from exact development pins. Python's
`requires-python` and Ruff/mypy targets, Node's `engines.node`, TypeScript output/libraries and `@types/node`, Go's
`go.mod` directive, and Rust's `rust-version` describe their respective baselines. Select a higher baseline by changing
these declarations together; the registry's `ci_versions` chooses the exact runtime versions exercised by CI.

C/C++ roots configure language standards and compiler support in `workbench/projects.toml`:

```toml
[[language_root]]
language = "cpp"
path = "native"
standard = "20"
compiler = "clang"
lto = "full"
compilers.clang = { minimum = "21.1.8", ci_versions = ["21.1.8", "22.1.8", "23.1.3"] }
compilers.gcc = { minimum = "14.4.0", ci_versions = ["14.4.0", "15.3.0", "16.2.0"], ci_architectures = ["x64", "arm64"] }
```

`compiler` selects development builds; `compilers` declares supported families, minimum versions, and CI versions.
Declare either family or both. Upstream-maintained GCC majors and the latest three stable Clang majors guide support
selection; use the latest patch in each selected line. Projects choose the compatibility profiles they promise to test.
Clang's older majors are a project compatibility promise beyond the upstream patch cycle; retire them as new stable
majors move the window. Review GCC retirement when upstream closes its branch. Scoped exceptions document any older
required compiler. Compiler compatibility jobs select Linux `x64` by default; `ci_architectures` can select `x64`,
`arm64`, or both per family. `standard` selects C or C++ syntax independently of the compiler version; the shared
adapter passes it to the reference CMake configuration. `.llvm-version` is always required for clang-format, clang-tidy,
and LLVM coverage, and also selects Clang development builds. `.gcc-version` selects GCC development when
`compiler = "gcc"`; its presence alone never installs or requires GCC. LLVM remains required when selecting GCC. Native
GCC installation and compiler compatibility coverage support Linux x64 and arm64 only. Managed GCC development needs GCC
added to the selected Guix/Nix environment alongside LLVM; its environment pin owns that compiler version.

Languages sharing a check root must agree on compiler selection and support policy; C and C++ retain separate `standard`
values. The adapter exposes `WORKBENCH_C_STANDARD` and `WORKBENCH_CXX_STANDARD` for both declarations.

Use an explicit selection for compatibility checks without changing development pins:

```sh
./bin/workbench tools install --path examples/languages/cpp --compiler gcc --compiler-version 16.2.0
./bin/workbench checks run --path examples/languages/cpp --environment native --compiler gcc --compiler-version 16.2.0
```

Project code and vcpkg dependencies use the selected compiler. Compiler family, version, standard, and environment
separate build caches, including local storage. GCC linting uses a separate Clang compilation database and dependency
build; LLVM coverage also uses Clang and retains ordinary tests on the selected compiler.

`lto` selects release link-time optimization and defaults to `"off"`. Clang supports `"off"`, `"full"`, and `"thin"`;
GCC supports `"off"` and `"full"`. Unsupported modes fail. The native references keep optimized modes separate from
debug, coverage, and sanitizer builds and require compatible archive and linker tools. The `lto` check executes each
supported mode's behavioral suite and a copied standalone binary; compiler compatibility jobs include it. Release
preparation verifies the configured mode before copying artifacts to `dist/`. See the
[C](../../examples/languages/c/README.md) and [C++](../../examples/languages/cpp/README.md) references and
[ADR-P](../../workbench/decisions/ADR-0P.md).

## Adapting reference contracts

Shared automation is a starting build contract. Several adapters currently assume reference-specific source paths,
artifact names, or test runners: C/C++ and Go package `count`, Java packages `count.jar`, Ruby and PHP packaging retain
sample identities, and compatibility adapters invoke fixed ecosystem runners. Complete local language replacements can
change ordinary checks, but do not replace those compatibility adapters. See
[the consumer portability task](../tasks/TSK-0G.md) before promising that an arbitrary project can reuse every shared
role.

`language init` currently supplies starters for TypeScript, JavaScript, Java, Ruby, and PHP. Other examples can be
copied and registered manually. Nix/Guix files, Makefiles, and container definitions must also be copied and adapted
explicitly; `language init` does not install a complete managed environment. Copied files become project-owned.

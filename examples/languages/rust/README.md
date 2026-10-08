# Rust reference project

This standalone project is Workbench's executable reference for Rust configuration. It is not a registered Workbench
scope and has no example charter.

The binary uses `clap` to parse two unsigned integers, exercising a real dependency and its locked transitive graph. Run
`cargo run --locked -- 20 22` to print `42`, or use `--help` for usage. Invalid arguments exit with status 2; arithmetic
overflow exits with status 1 and a diagnostic on stderr. Integration tests exercise the executable, while doctests
demonstrate the library's checked addition contract.

`Cargo.toml` enables Clippy's default, pedantic, and nursery groups plus selected restriction lints for debug output,
panicking unwraps, and undocumented unsafe code. The gate denies warnings. The entire restriction group is deliberately
excluded because it contains conflicting policies. Justify any local exceptions at the affected code; test assertions
may use narrowly allowed `expect` when failure is the assertion.

`rust-toolchain.toml` owns the host compiler, rustfmt, Clippy, rust-analyzer, and standard-library sources;
`.tool-versions` pins host Nextest. Install the declared toolchain and components from this directory:

```sh
rustup toolchain install --no-self-update
```

Every Rust root declares its required components, even when other projects use the same toolchain. Rustup shares
installations by toolchain; components installed for `stable` do not supply an explicitly pinned version. Keep the
component list when changing the compiler pin. Workbench's installer and native CI consume this declaration.

`Cargo.toml` declares Rust 1.93 as the supported minimum, exercised by a dedicated CI job and the pinned Guix
environment. The host and Nix toolchains exercise newer Rust. Every environment uses `Cargo.lock`; its own package or
native pins select its tools. The minimum follows the oldest verified target; this initial reference makes no claim of
support for an older compiler.

Rust upstream maintains only the latest compiler. The older Guix compiler is a compatibility target; its presence in a
pinned channel does not imply continued compiler maintenance. Native development selects the current stable compiler.

The supported checks are defined in `../index.toml`. Run them from this directory. Enter the optional pinned Guix
environment explicitly with `guix time-machine -C channels.scm -- shell --container -m manifest.scm`; Workbench never
loads it automatically.

Nix users may instead run `nix develop`; `flake.lock` pins the Nix package set. Neither environment replaces
`Cargo.lock`.

`Cross.toml`, `Dockerfile.musl`, and `scripts/build-release` define the portable Linux release. The available Guix
channel does not package `cross`, so the user must provide `cross` 0.2.5 and a compatible container runtime before
running the release script.

`make clean` and `make distclean` remove this root's Workbench build cache and local artifacts, preserving shared Cargo
downloads and toolchains. Inside a Workbench shell, `cargo clean` removes its selected `CARGO_TARGET_DIR` (or the native
`target/` default).

The gate verifies this console example (after building where required):

```console
$ cargo run --quiet --locked -- 20 22
42
```

`workbench/quality.json` owns coverage floors, and `.config/nextest.toml` owns advisory slow-test reporting. The
byte-counting library demonstrates scalar/AVX2 dispatch and rejects unavailable explicit backends. Tests cover vector
boundaries, unaligned inputs, and tails; the example makes no speedup claim. `cargo-llvm-cov` and the matching LLVM
tools provide source coverage. Workbench configuration owns the advisory whole-command threshold. It includes
build/setup inside the command and does not terminate slow runs. Human review is required to change the protected
quality configuration.

Miri is an explicit additional check for the unsafe byte-counting code:

```sh
# From the repository root:
./bin/workbench tools install --path examples/languages/rust
./bin/workbench checks run --path examples/languages/rust --role miri --environment native
```

`rust-toolchain-miri.toml` separately pins a dated nightly, Miri, and `rust-src`; the installer reads it alongside the
stable declaration without changing either project or user defaults. Omit this supplementary file in roots that do not
use Miri. The configured `miri` role is manual-only; a dedicated CI invocation can select the same role. It also runs
inside the Dev Container after installing its declared tools; Guix/Nix retain their independent ordinary check suites.

Both runs interpret the `count` integration tests for an x86-64 Linux target, first without AVX2 and then with AVX2
enabled in the virtual CPU. Boundary inputs end at the allocation boundary, covering unaligned loads and short tails.
The checks clear inherited Miri flags and select CPU features explicitly, retaining default isolation, leak, and
aliasing checks. CLI subprocess tests remain in the native suite because Miri cannot execute arbitrary native child
processes. Miri's interpreter complements native SIMD execution; it does not validate machine-code generation or prove
soundness.

The pinned Guix channel lacks `cargo-llvm-cov`; `coverage-tool.scm` supplies its checksum-verified upstream static
release. The manifest derives LLVM tools from the selected Rust package's LLVM input. This Guix tool pin remains
independent of native `.tool-versions`.

The static Makefile delegates to the repository's configured commands for this root: `make` builds, `make check` runs
the commit gate, `make test` runs ordinary tests, and `make coverage` runs the same suite with instrumentation and
coverage floors. CI selects coverage on Linux/native and ordinary tests on other targets. `make release` prepares local
release artifacts; `make fmt` formats files. Coverage has no whole-command timing cap.

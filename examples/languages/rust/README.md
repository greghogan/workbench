# Rust reference project

This standalone project is Workbench's executable reference for Rust configuration. It is not a registered Workbench
scope and has no example charter.

The binary uses `clap` to parse two unsigned integers, exercising a real dependency and its locked transitive graph. Run
`cargo run --locked -- 20 22` to print `42`, or use `--help` for usage. Invalid arguments exit with status 2; arithmetic
overflow exits with status 1 and a diagnostic on stderr. Integration tests exercise the executable, while doctests
demonstrate the library's checked addition contract.

`Cargo.toml` enables Clippy's default, pedantic, and nursery groups plus selected restriction lints for debug output,
panicking unwraps, and undocumented unsafe code. The lint gate checks all workspace members and targets and denies
warnings. The entire restriction group is deliberately excluded because it contains conflicting policies. Justify any
local exceptions at the affected code; test assertions may use narrowly allowed `expect` when failure is the assertion.

`rust-toolchain.toml` owns the host compiler, rustfmt, Clippy, rust-analyzer, and standard-library sources;
`.tool-versions` pins host Nextest. Install the declared toolchain and components from this directory:

```sh
rustup toolchain install --no-self-update
```

Every Rust root declares its required components, even when other projects use the same toolchain. Rustup shares
installations by toolchain; components installed for `stable` do not supply an explicitly pinned version. Keep the
component list when changing the compiler pin. Workbench's installer and native CI consume this declaration.

`Cargo.toml` declares Rust 1.93 as the application minimum. CI uses the selected native compiler on each native platform
and independently pinned Nix/Guix compilers in prepared Linux environments; there is no dedicated minimum-Rust job.
Every environment uses `Cargo.lock`. Additional compatibility profiles can verify older compiler promises.

Rust upstream maintains only the latest compiler. An older compiler's availability in a managed environment does not
establish a compatibility policy or imply continued compiler maintenance. Native development selects current stable.

The Nix Rust environment temporarily retains Nixpkgs `e63c96e6b5c1cd2b726895cef537fd7363fc5de6` (Rust 1.98.1).
The newer package set combines Rust 1.99's LLVM 23 profiling runtime with an LLVM 21 compiler backend, causing
coverage-instrumented binaries to crash. Update this environment when its compiler and profiling runtime agree;
the remaining Nix environments and native Rust pins update independently.

`Cargo.toml` owns release profiles and dependencies; Cargo configuration and explicit environment settings can also
supply compiler flags. Experimental flags do not change canonical release recipes until accepted in source.

Workbench commands are defined in `../../../languages/rust/automation.toml`; this project owns its lint rules. Run them
from this directory. Enter the optional pinned Guix environment explicitly with
`guix time-machine -C ../../../channels.scm -- shell --container -m manifest.scm`; Workbench never loads it
automatically.

Nix users may instead run `nix develop`; `flake.lock` pins the Nix package set. Neither environment replaces
`Cargo.lock`.

## Releases

`make release` builds and tests the selected environment's native target, runs documentation tests, and checks the
packaged executable outside the checkout before accepting it into `dist/`, or the selected external build-cache
generation's distribution directory. It preserves the prior artifacts if a build, test, or behavioral check fails.
Native artifacts retain their platform's runtime requirements.

Portable Linux releases use explicit profiles, selected independently of the development environment:

```sh
# From the Workbench repository root, on the matching native Linux architecture:
workbench release prepare rust-linux-x64-musl
# On an ARM64 builder instead:
workbench release prepare rust-linux-arm64-musl
```

Install the declared native Rust tools first. `release-musl.json` pins the additional `cross` driver by Git revision
because the published 0.2.5 release assumes an x64 container compiler host. Install the pinned revision using Cargo's
locked package installation and provide Docker:

```sh
cross_revision=$(node -p 'require("./release-musl.json").cross_revision')
cargo install --git https://github.com/cross-rs/cross --rev "$cross_revision" --locked cross
```

Neither is required for ordinary native releases. The shared release adapter selects the explicit target; `Cross.toml`
and `Dockerfile.musl` provide a native-architecture tool environment using pinned images and an authenticated OS
repository snapshot. Cross uses the selected Rust toolchain rather than installing an independent compiler.

The musl profiles run the optimized target suite and documentation tests, inspect ELF architecture and static linkage,
then verify successful and failing CLI behavior in digest-pinned Ubuntu and Alpine containers with networking disabled
and only the artifact mounted. CPU baselines are x86-64 and ARMv8-A; the declared kernel baseline is Linux 6.1.
Containers share the builder's kernel, so this is not an independent old-kernel compatibility test. Portable builds
clear inherited host-specific compiler/linker flags. Each architecture requires its own native builder, without
emulation. CI selects each profile on that architecture; local verification uses the same command.

Accepted artifacts and verification receipts are under `dist/releases/PROFILE/`, within the checkout root's external
build-cache generation when external storage is enabled. `workbench release prepare PROFILE --json` reports the exact
path. Copy the desired profile into a consumer's `workbench/config.toml` and adapt its registered root and behavioral
verifier. Selecting all configured profiles still requires a builder matching every selected platform; select the
matching profile explicitly when a configuration includes both architectures. Nix/Guix package profiles remain
independent and include their runtime closures.

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
./bin/workbench check --path examples/languages/rust --role miri --environment native
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

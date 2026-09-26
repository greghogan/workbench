# Rust reference project

This standalone project is Workbench's executable reference for Rust configuration. It is not a registered Workbench
scope and has no example charter.

The supported checks are defined in `../index.toml`. Run them from this directory. Enter the optional pinned Guix
environment explicitly with `guix time-machine -C channels.scm -- shell --container -m manifest.scm`; Workbench never
loads it automatically.

Nix users may instead run `nix develop`; `flake.lock` pins the Nix package set. Neither environment replaces
`Cargo.lock`.

`Cross.toml`, `Dockerfile.musl`, and `scripts/build-release` define the portable Linux release. The available Guix
channel does not package `cross`, so the user must provide `cross` 0.2.5 and a compatible container runtime before
running the release script.

`make clean` and `make distclean` remove local `target/` and `dist/` directories. Neither removes an external
`CARGO_TARGET_DIR` or shared Cargo caches.

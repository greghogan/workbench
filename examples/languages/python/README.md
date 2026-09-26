# Python reference project

This standalone project is Workbench's executable reference for Python configuration. It is not a registered Workbench
scope and has no example charter.

The supported checks are defined in `../index.toml`. The committed `.python-version` selects Python 3.11 and `uv.lock`
fixes the dependency environment used by those commands. Enter the optional pinned Guix environment with
`guix time-machine -C channels.scm -- shell --container -m manifest.scm`; Workbench never loads it automatically. Nix
users may instead run `nix develop`; `flake.lock` pins the Nix package set. Neither environment replaces `uv.lock`.

`make clean` removes build outputs, bytecode, package metadata, and test/tool caches; `make distclean` also removes
`.venv`.

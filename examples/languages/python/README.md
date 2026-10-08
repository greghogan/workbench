# Python reference project

This standalone project is Workbench's executable reference for Python configuration. It is not a registered Workbench
scope and has no example charter.

Ruff selects all stable rules. The configuration documents the exclusions: formatter conflicts, one docstring style,
project-owned copyright policy, and unittest conventions. Strict mypy also checks unreachable code, exhaustive matches,
possibly undefined names, and coded ignores. Review new rules when updating the locked tools.

The supported checks are defined in `../index.toml`. `.python-version` selects the exact host CPython release and
`.tool-versions` pins host uv. `requires-python` declares the supported minimum; Ruff and mypy retain that language
target while development uses newer interpreters. CI tests the exact minimum and the supported minor lines pinned in
`ci_versions` in `workbench/projects.toml`. Native development selects CPython 3.14.8. The existing Guix channel
supplies Python 3.13 through `python-next`; Nix selects Python 3.14 from its locked package set. `uv.lock` owns
dependencies including Ruff and mypy in every environment. Workbench checks use the selected interpreter explicitly and
disable automatic Python downloads. Enter the optional pinned Guix environment with
`guix time-machine -C channels.scm -- shell --container -m manifest.scm`; Workbench never loads it automatically. Nix
users may instead run `nix develop`; `flake.lock` pins the Nix package set. Neither environment replaces `uv.lock`.

The Nix shell supplies runtime libraries for native wheels; native Nix on NixOS also needs an FHS loader such as the
system's `nix-ld` configuration.

`make clean` removes build outputs, bytecode, package metadata, and test/tool caches; `make distclean` also removes
`.venv`.

The gate verifies this console example (after building where required):

```console
$ uv run --locked python -c 'from workbench_python_reference.arithmetic import count_byte; print(count_byte(b"banana", 97))'
3
```

`pyproject.toml` owns doctests and branch/line coverage of the complete package; the configured ordinary test command
selects duration reporting. Unittest-style behavioral tests run under pytest. Timing is advisory; coverage below the
declared floor fails. Workbench configuration owns the advisory whole-command threshold. It includes build/setup inside
the command and does not terminate slow runs. Human review is required to change the protected quality configuration.

The static Makefile delegates to the repository's configured commands for this root: `make` builds, `make check` runs
the commit gate, `make test` runs ordinary tests, and `make coverage` runs the same suite with instrumentation and
coverage floors. CI selects coverage on Linux/native and ordinary tests on other targets. `make release` prepares local
release artifacts; `make fmt` formats files. Coverage has no whole-command timing cap.

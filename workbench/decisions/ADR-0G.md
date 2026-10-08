---
summary: Supported interpreters and strict tools.
---

# ADR-G: Python implementation

Apply ADR-B. `.python-version` or the selected environment owns the exact development interpreter; `requires-python`
declares supported interpreters.

Use the [CPython support table](https://devguide.python.org/versions/) to select maintained minor release lines; both
bugfix and security-only maintenance count as maintained. Apply ADR-B's release-line coverage to supported CPython minor
lines.

Type and validate public data boundaries.

The reference uses uv, Ruff formatting and all stable lint rules with documented exclusions, strict mypy, and pytest
with coverage and advisory duration reporting; equivalent tools are allowed.

Rationale: Validated boundaries and repeatable checks preserve Python flexibility while making mistakes observable
early.

---
summary: Supported interpreters and strict tools.
---

# ADR-10: Python

`.python-version` or the selected environment owns the development interpreter; `requires-python` declares application
support. Use the [CPython support table](https://devguide.python.org/versions/) when selecting compatibility lines,
including bugfix and security-only maintenance.

Use uv, Ruff formatting and linting, strict mypy, and pytest, or equivalent configured tools.

Rationale: Independent interpreter and application targets retain broad compatibility while strict, repeatable checks
expose Python boundary errors.

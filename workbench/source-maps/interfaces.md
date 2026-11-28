# Commands and configuration

- `demo`: Assemble a disposable consuming project from packaged, readable demonstration data.
- `.githooks/pre-commit`, `.githooks/pre-push`, `.githooks/prepare-source`, `.githooks/commit-msg`, `.githooks/post-commit`: Checks staged and outgoing commit trees using a prepared source runtime; validates change messages and releases consumed agent receipts.
- `.githooks/verify-staged.mjs`, `.githooks/verify-staged.d.mts`: Shared verification of tracked files in a staged checkout before successful check evidence is recorded.
- `scripts/jsx-rendering-lint.mts`: Share static JSX enforcement, verify rejected form/route declarations during typechecking, and compare inventory indexes against independent scans.
- `docs/web.md`: Documents local browser access, record views, live refresh, editing, review, and collection workflows.
- `scripts/check-web-browser.mts`: Exercise the shipped UI in the managed Headless Shell using disposable projects, retaining screenshots and failure diagnostics; explicit browser overrides aid debugging.
- `scripts/module-boundaries.mts`: Enforces source-layer dependencies for static, deferred, type-only, and CommonJS imports without filesystem probing.

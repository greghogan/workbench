# ADR-F: Dependencies, credentials, and supply-chain evidence

Summary: Lock dependencies, verify downloaded artifacts, and keep credentials out of project files.

Commit ecosystem lockfiles, explain intentional pins, and verify dependency and executable artifacts against a
recorded digest or signature. Isolate disruptive dependency upgrades when practical.

Configure relevant dependency, advisory, license, and secret checks as project roles. Use each provider's runtime
credential lookup; keep credentials out of tracked files and logs.

---
name: ruby-dependency-refresh
description:
  Refresh existing Bundler dependencies in a registered Workbench Ruby root when requested; preserve inspection-only,
  targeted, compatible-only, and lock-only scope without adding or removing direct dependencies.
---

# Ruby dependency refresh

Verify the Ruby root in `workbench/projects.toml` and read its applicable decisions. `Gemfile`, its gemspec, and
`Gemfile.lock` own application requirements, development tools, supported Ruby versions, and the Bundler bootstrap pin.

Use the selected environment and the distribution's `ruby-package-manager-exec` wrapper. Inspect current stable gems and
compatibility with every supported Ruby line. A general upgrade includes major versions; narrower requests retain their
scope. Update exact development requirements before an explicit `BUNDLE_FROZEN=false` invocation of `bundle update`, and
use `bundle lock --add-checksums` to retain checksum coverage for all configured platforms. Inspect platform variants
and native extension requirements.

Changing `BUNDLED WITH` also requires reviewed bootstrap acquisition metadata in `scripts/native-assets.json`; record
the gem's upstream SHA-256 and available authentication. Ordinary installs stay frozen and never record new checksums.
Keep gems and native build products outside the checkout, and preserve Nix/Guix input pins unless their update was
explicitly requested. Do not raise the Ruby baseline as an incidental tool upgrade.

After an applied update, run configured formatting, lint, strict types, tests, coverage, advisory, and relocated gem
release checks, including affected runtime compatibility targets. Report retained upgrades and unresolved migrations.
Inspection alone does not rewrite manifests or locks; do not stage or commit without a request.

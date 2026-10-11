# Ruby reference

A standalone Ruby gem and byte-counting executable. Develop with Ruby 4.0.7; the application minimum is Ruby 3.3.12.
Compatibility CI also exercises Ruby 3.4.11. RuboCop targets Ruby 3.3 syntax; Steep checks explicit RBS signatures.
Runtime tests establish API compatibility on each supported line; type signatures alone do not prove that boundary.

## Commands

Run `make check`, `make test`, `make coverage`, `make fmt`, `make lint`, `make build`, `make release`, or `make ci`.
`make coverage` enforces 100% line and branch coverage across the library and executable, merging subprocess coverage,
and presents changes against the committed compact summary. Dependencies are excluded regardless of installation
location. The uninstrumented suite exercises the same behavior. Test workers use the configured CPU allocation.
`make release` produces a gem under `dist/`; installation requires Ruby but no Workbench runtime or repository files.

Copy this directory into a consuming project, register its Ruby root, and reference or replace the shared Ruby
definition. The Makefile discovers an installed Workbench or accepts `WORKBENCH=/path/to/workbench` and
`ROOT=registered/path`.

## Tool ownership and storage

`Gemfile.lock` pins development dependencies and Bundler, including gem SHA-256 checksums. Setup installs the verified
Bundler bootstrap privately and uses frozen Bundler installs; ordinary checks never resolve new dependency versions.
Dependency gems, native extensions, bootstrap tools, and downloads use external Workbench caches. Bundler configuration
follows the selected build storage.
Configured external storage keeps dependency installations under the root's owned cache; standalone commands also
default to an external Bundler dependency cache rather than a local `vendor/` directory. `make distclean` removes owned
dependency installations; shared Bundler caches and verified tools survive cleanup.

`workbench tools install --path examples/languages/ruby` builds verified Ruby sources on Linux x64/arm64 and macOS
arm64. Install a C compiler, make, pkg-config, OpenSSL and libyaml development headers first. On macOS use the selected
SDK and Homebrew OpenSSL/libyaml with their pkg-config paths. Windows x64 uses signed RubyInstaller archives and
requires 7-Zip; install the RubyInstaller MSYS2 development kit when building gems without matching prebuilt native
extensions. Ruby source releases publish strong checksums without detached signatures; RubyInstaller provides PGP
signatures. Source builds disable optional JIT compilers and documentation, use all assigned CPUs, and are cached after
activation.

Nix and Guix own their selected runtime versions: the locked Nix environment supplies Ruby 4.0.7 and Guix Ruby 4.0.5.
Use `ENVIRONMENT=nix`, `nix-docker`, or `guix` with Make targets. Both environments install the project's locked tools
through Bundler. Managed environments use the existing repository input revisions. Native CI covers Linux x64/arm64,
macOS arm64, and Windows x64; managed and compatibility checks run on Linux x64.

Update dependencies through the Ruby refresh skill. Preserve the Ruby baseline unless explicitly changing support.

The gate verifies the executable example:

```console
$ ruby -Ilib bin/count 97 banana
3
```

Bundler caches are scoped to the Ruby installation prefix as well as its version and platform. This keeps compiled Gem
extensions isolated across native SDKs, Nix, Guix and Dev Containers.

# PHP reference

A standalone Composer package with a byte-counting CLI and a small arithmetic library. Development uses PHP 8.5.12. The
application targets PHP 8.2.34. CI uses selected native and managed development runtimes rather than a matrix of every
maintained PHP line. PHPStan's API and syntax baseline matches the minimum; Composer's platform setting constrains
dependency resolution. Additional compatibility profiles can verify older runtime promises; static targeting alone does
not prove runtime compatibility.

## Commands

Use `workbench tools install --path examples/languages/php`, then `make check`, `make test`, `make coverage`,
`make release`, or `make ci`. Outside this repository, install Workbench and use the standalone Makefile.
`make coverage` enforces 100% line, branch, and function coverage and presents changes against the saved summary. Full
coverage reports are disposable. Linux native coverage uses verified Xdebug sources.

Composer owns all dependency installation. The pinned Composer PHAR is checked against its recorded SHA-256 and upstream
PGP signature. The local verification plugin checks each downloaded distribution against `.composer/checksums.json`
before Composer extracts it, including archive cache hits. Only the explicit dependency refresh command records new
checksums; review those changes together with the locks. Source installs are disabled. Local plugin files are project
source. Composer metadata has HTTPS transport integrity, while committed locks and archive hashes fix installed code.

The application and development tools have independent manifests: the application targets PHP 8.2, while `tools/` uses
the current tool release requirements. Compatibility checks for older runtimes use the locked PHP 8.2-compatible PHPUnit
in `tools/compat/`. ParaTest uses the complete CPU allotment in both tool graphs; PHPStan and PHP CS Fixer use that same
budget. Tools never become application runtime dependencies. Run refresh through
`workbench check --role dependency-lock --path examples/languages/php`; use the PHP dependency refresh skill for
narrow updates.

Dependencies, Composer downloads, tool installations and build outputs use Workbench's external cache. No vendor tree is
committed. Native Unix installation compiles signed release sources using a C compiler, make, pkg-config, OpenSSL,
libxml2, oniguruma, zlib and curl development headers. macOS also uses Homebrew's libiconv prefix. Xdebug additionally
needs autoconf. Windows uses the official x64 NTS ZIP, its recorded SHA-256, and its matching extensions; the Visual C++
runtime is required. The Windows publisher does not provide detached archive signatures; this absence is recorded in
native artifact metadata.

Native CI covers Linux x64/arm64, macOS arm64 and Windows x64. Nix and Guix CI use prepared Linux x64 environments; Nix
Docker and Dev Containers are also available for local execution. The existing Nix input provides PHP 8.5.10 and the
Guix channel PHP 8.5.9. The environment owns its runtime; it does not substitute the native pin. Managed checks use the
same locked tools and behavioral suites.

Release packaging creates a portable source ZIP and verifies the library and CLI outside the checkout.

The gate verifies the executable example:

```console
$ php bin/count 97 banana
3
```

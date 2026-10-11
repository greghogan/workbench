# Pinned acquisition trust material

Reviewed on 2026-10-09. These are public verification keys, never private keys. Artifact metadata selects full signer
fingerprints; importing another key from a file does not authorize it. Key and root changes require review with the
artifact pins. Runtime verification never fetches keys automatically.

## node.asc

Node release-keys commit `481637f813e912c4aa3622d7964ab426c97b8e8d`.
[Upstream authority](https://github.com/nodejs/release-keys/tree/481637f813e912c4aa3622d7964ab426c97b8e8d/keys).

- Authorized signer: `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`.
- Vendored file SHA-256: `5115095e2f8010c75da052ecb1cfb3af630e084f0f8daa93a863557b01b0f90a`.

## cmake.asc

Brad King signing key linked by CMake; minimal public export. [Upstream authority](https://cmake.org/download/).

- Authorized signer: `C6C265324BBEBDC350B513D02D2CEF1034921684`.
- Vendored file SHA-256: `c78d5037966029c6acbaee0d56b2dbacec839034033abf8ca457452cdbee0fb2`.

## google.asc

Google Linux package signing authority; Go detached signatures use its signing subkey.
[Upstream authority](https://www.google.com/linuxrepositories/).

- Authorized signer: `0E225917414670F4442C250DFD533C07C264648F`.
- Vendored file SHA-256: `54dea5f6c2a26091578cf52a999cebc6b64df478d37ad4dce96376b711e3b27c`.

## gcc.asc

GNU keyring, minimal public export for GCC 14.4. [Upstream authority](https://ftp.gnu.org/gnu/gnu-keyring.gpg).

- Authorized signer: `D3A93CAD751C2AF4F8C7AD516C35B99309B5FA62`.
- Vendored file SHA-256: `aa96cc2354b916fd5ffc61d2366c57d3338171e3b87b6a498b8d11af96436dac`.

## gcc15.asc

GNU keyring, minimal public export for GCC 15.3 and 16.2. [Upstream authority](https://ftp.gnu.org/gnu/gnu-keyring.gpg).

- Authorized signer: `7F74F97C103468EE5D750B583AB00996FC26A641`.
- Vendored file SHA-256: `c77d48ac0197075cc624ffc42101ffeb297aeffc446fb3fdda7f98c2aa26e871`.

## ubuntu.asc

Ubuntu archive signing key (2018), obtained by its full fingerprint from keyserver.ubuntu.com.
[Upstream authority](https://documentation.ubuntu.com/security/software-integrity/image-verification/).

- Authorized signer: `F6ECB3762474EDA9D21B7022871920D1991BC93C`.
- Vendored file SHA-256: `85309b698b7bdac6f21de64aa1eaa998470bbd9c8c853ea274d0c27a95013210`.

LLVM's private ICU and libxml2 runtime packages use this key to verify Ubuntu release catalogs. The artifact inventory
pins each package index and package digest independently; libxml2 uses the immutable `20261010T000000Z` snapshot for
both supported Linux architectures.

## LLVM and Sigstore

`llvm.asc` authorizes `FFB3368980F3E6BB5737145A316C56D064CACBA5` for LLVM 22.1.8. The
[LLVM release](https://github.com/llvm/llvm-project/releases/tag/llvmorg-22.1.8) supplies detached artifact signatures.
LLVM 23.1.3 uses the release-tag-bound `release-binaries.yml` Sigstore attestations with the pinned trust roots below.
The LLVM public key's vendored file SHA-256 is `d3e02c6fbcc641935ebd8b5a0d623563f90fef1a51c161917d7d5ed921e36288`.

`sigstore-trusted-root.jsonl` is the exact output of `gh attestation trusted-root`, independently refreshed and compared
on 2026-10-09. The [GitHub CLI](https://cli.github.com/manual/gh_attestation_trusted-root) retrieves the Sigstore public
and GitHub trust roots through their TUF repositories. Its vendored SHA-256 is
`65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c`. Verification enforces signed timestamps/transparency
evidence and the pinned certificate identity. GitHub release statements additionally bind the repository, tag, artifact
filename, and digest. Normal GitHub Actions provenance requires the Actions OIDC issuer.

## Proof availability

`scripts/native-assets.json` records the method for every pinned native asset. Node and CMake authenticate signed
SHA-256 catalogs; Go and GCC authenticate detached signatures over archive bytes. uv, actionlint, cargo-nextest, and
cargo-llvm-cov authenticate Sigstore statements. Ninja, shfmt, ShellCheck, and the pinned static rustup bootstrap
publish no applicable proof at the recorded locations; their explicit metadata records the inspection date and upstream
source. Unsigned checksum files are not represented as signatures. All downloads still require the recorded SHA-256
digest.

GCC 14.4.0 upstream uses a SHA-1 OpenPGP signature; SHA-256 remains the mandatory independent artifact pin. Verification
uses GnuPG defaults and adds no weak-digest or weak-key overrides. Other audited GCC archives use SHA-256 signatures.

## temurin.asc

Eclipse Adoptium's Temurin release signer, checked against the official container build recipes.
[Upstream authority](https://github.com/adoptium/containers/blob/main/8/jdk/ubuntu/noble/Dockerfile).

- Authorized signer: `3B04D753C9050D9A5D343F39843C48A565F8F04B`.
- Vendored file SHA-256: `466784df8a3cf06ce898ee6493140167db56a647edbad110b1f0566fd3555e46`.

## maven.asc

Apache Maven release signer, exported from the project's published public keyring.
[Upstream authority](https://downloads.apache.org/maven/KEYS).

- Authorized signer: `88BE34F94BDB2B5357044E2E3A387D43964143E3`.
- Vendored file SHA-256: `8cd92a6cae1049b27a47a4706b42a1cc4eaaffbc9cab5679dc22e6a5f19d1a89`.

Temurin and Maven authenticate detached signatures over archive bytes as well as independently pinned SHA-256 hashes.

## rubyinstaller.asc

RubyInstaller's AppVeyor package signer, obtained from its own source repository (the website's older CI key does not
sign the pinned 4.0.7 archive).
[Upstream authority](https://github.com/oneclick/rubyinstaller2/blob/master/recipes/unpack/appveyor-repo-key.asc).

- Authorized signer: `79D1D4E12FF93365DEAA8DCEF98B8484BE8BF1C5`.
- Vendored file SHA-256: `3a649e22e1341e528ce07d52f036cc0e35683f22e1cf5311872f2069b2350afe`.

## php.asc

PHP's official release keyring. [Upstream authority](https://www.php.net/downloads.php#gpg-keys). Each release line
selects its maintainers' full fingerprints in `native-assets.json`; the keyring alone does not authorize other signers.

- Vendored file SHA-256: `43fcb3eaf65536cb0833c229b492c70cfad8562138164dd13673e08925d6c56c`.

## composer.asc

Packagist Conductors' Composer binary signing key. [Upstream authority](https://getcomposer.org/download/). The pinned
PHAR and detached signature were verified together locally.

- Authorized signer: `161DFBE342889F01DDAC4E61CBB3D576F2A0946F`.
- Vendored file SHA-256: `eeaec5e9af9f0405e7a1602de16611d8e344b6a83014209cfe96c2c61588e84d`.

Ruby source tarballs, RubyGems distributions, PHP Windows ZIPs and Xdebug sources currently lack applicable detached
signatures or attestations at their recorded publishers. Native metadata explicitly records the checked source and date;
Bundler's checksummed lock and Composer's independent distribution catalogs pin package archive hashes. This absence
never disables the recorded SHA-256 requirement.

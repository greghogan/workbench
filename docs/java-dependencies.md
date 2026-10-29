# Java dependency updates and application releases

The Java starter uses a frozen Maven checksum index during normal checks. Updating dependencies has three steps: prepare
authenticated inputs, inspect and activate the proposal, then execute the project against the resulting lock.

Declare the pinned resolver and publisher trust policy in the Java root's `.mvn/acquisition.json`. The starter pins
Maven Dependency Plugin's `go-offline` goal, which resolves dependencies and plugins without running the project
lifecycle. Trust rules select repository path prefixes. Each signed rule includes an independently established publisher
identity, a project-relative public key file, and approved full primary or signing-subkey fingerprints:

```json
{
  "resolver": "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline",
  "trust": [
    {
      "prefix": "org/example/",
      "identity": "Publisher identity and independent authority used to confirm its fingerprint",
      "keys": ".mvn/keys/publisher.asc",
      "signers": ["REPLACE_WITH_THE_PUBLISHERS_FULL_FINGERPRINT"]
    }
  ]
}
```

The example fingerprint is a placeholder, deliberately rejected by validation. Do not infer trust from a signature's own
key ID. Acquire public certificates from the publisher's documented authority and verify the full fingerprint
independently. Narrower prefixes override broader ones. Existing reviewed artifact hashes remain required. New artifacts
need a matching trust rule. If authentication is unavailable, replace `keys` and `signers` with an `unavailable` reason
describing the investigated upstream evidence. The proposal retains that limitation. A missing or invalid declared
signature never falls back to this mode automatically.

Prepare a new proposal directory:

```sh
workbench tools maven prepare --path ROOT --output /tmp/maven-proposal
```

Preparation uses the selected native JDK/Maven installation with private settings and an empty candidate repository.
Previously reviewed immutable inputs can be reused after checking their exact hashes, including when a publisher rule
has subsequently been declared. New artifacts require that rule's authentication before Maven receives them. The private
mirror verifies inputs before Maven reads or loads them, including resolver tooling. Project tests, compiler plugins,
formatters, and analyzers are not invoked. The adapter accepts standalone POMs and explicitly declared sibling-source
workspaces. Parent inheritance, nested reactor definitions, and build extensions require additional support rather than
silently executing extension code. Run acquisition online with the verified native tools; prepared offline images remain
frozen inputs.

The consuming POM's pinned Maven Dependency Plugin declaration owns its resolver dependency overrides and must agree
with `.mvn/acquisition.json`. Overrides use literal pinned versions. Workbench applies that declaration to every
disposable metadata POM in a source workspace; it does not rewrite the project POMs or upstream published metadata. The
starter replaces obsolete resolver branches with maintained Doxia, Velocity integration, annotations, and translation
components. Its acquisition configuration excludes Maven's unused website-generation plugin; the starter's documented
format, analysis, test, build, and documentation checks remain required. Dynamic test-provider inputs, including the
JUnit launcher, are declared explicitly instead of being discovered while executing unreviewed dependencies. Publisher
identities and independent key sources are retained in the starter's `.mvn/keys/README.md`.

Inspect `checksums.sha256`, `authentication.json`, and version/graph changes in the proposal. Evidence binds the POM,
declared trust policy, verified artifact digests, signer identities, and unavailable-authentication reasons. Then
activate:

```sh
workbench tools maven accept --path ROOT --proposal /tmp/maven-proposal
workbench check --path ROOT
```

Acceptance rechecks retained artifact bytes and refuses a changed POM, key policy, or intervening checksum update. It
retains verified inputs in the selected writable Maven cache before activating their lock, so subsequent source checks
do not depend on the disposable proposal. A conflicting cache file prevents activation and remains intact, including a
file published by a concurrent writer. Metadata is read within explicit size bounds, and proposals must fit the recovery
journal before artifact retention begins. Acceptance publishes the checksum index and authentication evidence as a
recoverable operation: an interrupted activation resumes only while the recorded inputs and both destination files still
match that operation. Conflicting edits stop recovery and remain intact. Acceptance does not run the project. Frozen
checks reject missing dynamic dependencies instead of learning their hashes during execution. Review unexpected requests
and extend preparation deliberately. Remove the disposable proposal when it is no longer needed. The `dependency-lock`
role prepares `build/maven-proposal`; it leaves activation separate.

Repository dependency maintenance uses the same acceptance boundary: an authenticated Maven proposal is prepared before
qualification and the operation remains resumable while it awaits explicit acceptance. After acceptance, every
configured native/Nix/Guix qualification uses frozen checksums. Qualification never generates additional hashes.
Retrying an identical proposal preserves acceptance when its POM, trust policy, and complete checksum set are unchanged.

GnuPG verification of new inputs requires an approved full fingerprint and clean structured signature status.
Cryptographic validity alone does not override expired or revoked signing evidence. An unchanged reviewed input remains
bound to its exact checksum. Preserve its prior signer evidence while the declared policy still authorizes that
identity; this records the earlier verification rather than claiming a fresh signature check. Newly acquired artifacts
do not silently opt into historical verification. An already installed tool's acquisition receipt likewise records its
earlier verification.

For application releases, Maven's archive manifest owns the runtime closure. The starter uses relative repository-style
`lib/` entries. Workbench copies the exact checksum-verified JAR bytes into an application-owned directory, retains
embedded licenses and notices plus publisher POMs, and verifies execution from a private location outside the checkout.
Applications can declare native-access modules and additional JDK modules in `.mvn/runtime.json`; generated launchers
and project tests use those settings. Library mode produces a thin artifact. Keep additional required license material
with the project and add application-specific consumer tests as runtime features grow.

## Building sibling sources

Declare source dependencies in the consuming Java root's `.mvn/acquisition.json`:

```json
{
  "resolver": "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline",
  "trust": [],
  "sources": ["../library", "../leaf"]
}
```

Paths are relative to that Java root and remain inside its Workbench project. Include every source provider needed by
the consumer, including transitive source providers. Their order does not define the build order: the ordinary Maven
reactor follows the dependency declarations in the POMs. These directories do not need to be separate Workbench
subprojects. Each participating module retains its own reviewed external checksum index; conflicting hashes for the same
external artifact fail before execution. Source-owned coordinates must not appear in an external checksum index.

The current contract supports standalone ordinary JAR projects with literal coordinates and a literal `finalName` (or
Maven's artifactId-version default). Parent inheritance, nested module definitions, core/build extensions, and
`systemPath` dependencies require additional support. The build uses the consuming root's selected JDK/Maven and
preserves module release targets, POM configuration, profiles, and the consuming root's Maven settings. Source provider
directories cannot select unrelated host tools as a fallback. Inherited host JVM options, classpaths, and Maven
extension injection are cleared; project-owned `.mvn/jvm.config` remains part of the declared build configuration.

The shared `scripts/java-check.mjs` helper runs the requested role in a fresh owned workspace. It verifies and copies
only the frozen external POM/JAR bytes into a private Maven repository before Maven starts. Repository tracking and
version metadata are derived from those entries; unreviewed files and host repository metadata are not copied. Maven
then runs offline with repository fallback and offline exceptions disabled. Missing or corrupt external inputs fail
without executing new dependency code. This applies to dependencies and plugins. Offline Maven resolution does not
sandbox arbitrary project code or prohibit explicitly configured application/service tests from using the network.

Maven can use source classes normally during compile/test roles; packaging roles produce JARs. The helper invokes the
ordinary reactor once for the requested role, without installing project artifacts into the shared Maven cache or
requiring repeated JAR output merely to calculate expected hashes. Normal release inventory digests describe the bytes
shipped; they are not a separate human approval of a generated source JAR. Application distributions include the current
invocation's source JARs and Maven-selected frozen external runtime closure.

Each operation captures its input metadata once and uses those same bytes for staging and final change detection.
Cancellation prevents proposal and build publication; it interrupts artifact verification and repository-lock waits.
Each invocation owns its source copy, outputs, and private repository. Formatting publishes changes only for the
selected Java root using checked writeback. Selected-root test reports are retained separately; module outputs remain
inside the owned invocation until cleanup. Completed selected-root build output is published under
`WORKBENCH_BUILD_DIR/java`; active or uncertain child work is preserved rather than deleted by another invocation.

Cold preparation stages only the participating POMs in a private reactor. Source POMs remain owned project inputs;
source JAR requests are rejected rather than sent upstream or added to the external checksum index. Maven resolves the
external dependency and plugin graph without executing the project lifecycle. Proposals bind the consuming POM, provider
POMs, provider checksum indices, and declared authentication policy; acceptance rejects intervening changes. Additional
upstream repositories, including Tokamak's Red Hat dependencies, remain outside the current Maven Central adapter. Do
not weaken authentication or add source build outputs to the external checksum index to bypass that boundary.

Java starter dependency updates also qualify a disposable three-module source workspace from an empty external cache.
The qualification prepares authenticated metadata, rejects a changed provider, accepts the restored proposal, removes
that proposal, and runs frozen checks and independent runtime packaging. It uses isolated project registration and
state; it does not modify a consuming project or run during routine commit checks. Maintainers can repeat it from the
repository root after preparing development tooling:

```sh
node scripts/maintenance/main.mjs maven-qualify
```

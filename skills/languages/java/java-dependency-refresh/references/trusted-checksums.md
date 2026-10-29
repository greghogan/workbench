# Maven trusted checksums

Use the configured `dependency-lock` role through `workbench check --role dependency-lock --path ROOT`, or Maven's
documented trusted-checksum recording mode. For several managed Maven versions, record a fresh index for each
environment, then combine their artifact paths and hashes, rejecting conflicts. Do not retain unused entries from the
old requirements. Run every configured formatter, compiler, analysis, test, coverage, and packaging goal so plugins'
dynamic dependencies are captured as well. Regenerate from an empty checksum index in isolated staging to remove unused
entries. Use external repository and build paths. Never enable recording in ordinary checks or disable failure for
missing or mismatched hashes.

See [Maven trusted checksums](https://maven.apache.org/resolver/expected-checksums.html) for recording and verification.

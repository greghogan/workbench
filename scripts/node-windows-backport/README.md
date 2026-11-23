# Windows Node AppContainer backport

The **Windows Node backport** workflow builds the pinned Windows x64 Node release with the libuv AppContainer pipe
fix. It verifies the Node release downloads with the declared signing key and checksums, compiles on a Windows x64
runner, and uploads the ZIP for the independent AppContainer and attestation jobs.

The source and patch pins in [pin.json](pin.json) identify the single upstream change. Native acquisition records the
Windows archive's digest and attestation in the adjacent `assets.json`. The shared asset catalog also feeds Linux
image fingerprints.

When the next supported official Windows Node archive becomes available, run the AppContainer probe against its
`node.exe`. Once piped child output and IPC pass, select the official archive and remove the backport in the same
commit. Keep the AppContainer regression in the scoped check tests.

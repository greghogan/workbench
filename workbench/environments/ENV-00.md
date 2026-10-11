---
{}
---

# ENV-0: Linux x64 local disk LLVM verification host

## Hardware configuration

Linux x86_64 virtual machine with one AMD EPYC 9R45 socket, 64 cores, and one hardware thread per core. AVX2 is
available. Disposable files use `/tmp` on the local NVMe root filesystem; `/efs` is a separate network filesystem and is
excluded from disposable execution storage. Native x64 Docker execution uses the host kernel without architecture
emulation.

## Limits

This shared host runs unrelated workloads. Compression and restore times are observations, not controlled performance
claims. Linux x64 results do not establish ARM64, macOS, Windows, or hosted GitHub runner correctness.

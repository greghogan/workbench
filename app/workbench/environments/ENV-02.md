---
{}
---

# ENV-2: Amazon EC2 8g

## Hardware configuration

Standard [c8g](https://aws.amazon.com/ec2/instance-types/c8g/), [m8g](https://aws.amazon.com/ec2/instance-types/m8g/),
[r8g](https://aws.amazon.com/ec2/instance-types/r8g/) instances share this processor platform.

| Characteristic   | Specification                    |
| ---------------- | -------------------------------- |
| Processor        | AWS Graviton4, Arm Neoverse V2   |
| Architecture     | AArch64, Armv9.0-A               |
| Fixed frequency  | 2.8 GHz; 192-core sizes: 2.7 GHz |
| vCPUs per core   | 1                                |
| Cores per socket | 96                               |
| Instance storage | EBS-only                         |

### NUMA topology

| Size                 | Sockets | NUMA nodes |
| -------------------- | ------: | ---------: |
| 48xlarge, metal-48xl |       2 |          2 |

### Caches

| Cache           | Capacity | Scope  |
| --------------- | -------: | ------ |
| L1 data         |   64 KiB | Core   |
| L1 instructions |   64 KiB | Core   |
| L2              |    2 MiB | Core   |
| L3              |   36 MiB | Socket |

## Instance families

| Family | Memory per vCPU (GiB) |
| ------ | --------------------: |
| c8g    |                     2 |
| m8g    |                     4 |
| r8g    |                     8 |

## Instance sizes

| Size       | vCPUs | Cores | c8g (GiB) | m8g (GiB) | r8g (GiB) |
| ---------- | ----: | ----: | --------: | --------: | --------: |
| medium     |     1 |     1 |         2 |         4 |         8 |
| large      |     2 |     2 |         4 |         8 |        16 |
| xlarge     |     4 |     4 |         8 |        16 |        32 |
| 2xlarge    |     8 |     8 |        16 |        32 |        64 |
| 4xlarge    |    16 |    16 |        32 |        64 |       128 |
| 8xlarge    |    32 |    32 |        64 |       128 |       256 |
| 12xlarge   |    48 |    48 |        96 |       192 |       384 |
| 16xlarge   |    64 |    64 |       128 |       256 |       512 |
| 24xlarge   |    96 |    96 |       192 |       384 |       768 |
| metal-24xl |    96 |    96 |       192 |       384 |       768 |
| 48xlarge   |   192 |   192 |       384 |       768 |      1536 |
| metal-48xl |   192 |   192 |       384 |       768 |      1536 |

## Vector and matrix instructions

| Capability                           | Support                                               |
| ------------------------------------ | ----------------------------------------------------- |
| Vector widths                        | 128 bits                                              |
| Vector extensions                    | Neon, SVE, SVE2                                       |
| Vector execution                     | Four 128-bit Neon/SVE paths per core                  |
| FP32/FP64 arithmetic                 | Native vector arithmetic and FMA                      |
| FP16/FP32 conversion                 | Native Neon/SVE conversion                            |
| Native FP16 arithmetic               | Neon, SVE                                             |
| FP16 multiply with FP32 accumulation | FHM                                                   |
| BF16 conversion and dot products     | Neon/SVE BF16; FP32 accumulation                      |
| Complex floating-point operations    | FCMA                                                  |
| Integer dot products                 | DotProd; 8-bit inputs, 32-bit accumulation            |
| Integer rounding operations          | RDM: saturating rounding doubling multiply-accumulate |
| Vector permutations                  | SVE2 BitPerm: BDEP, BEXT, BGRP                        |
| Matrix extensions                    | I8MM, SVE I8MM; Neon/SVE BF16 matrix operations       |
| Unsupported matrix extensions        | SME, SVE F32MM, SVE F64MM                             |

## Cryptographic instructions

| Capability                           | Support                                   |
| ------------------------------------ | ----------------------------------------- |
| AES                                  | Neon AES, SVE AES                         |
| Polynomial multiplication            | PMULL, SVE PMULL with 128-bit results     |
| Hash instructions                    | SHA-1, SHA-256, SHA-512, SHA-3, SVE SHA-3 |
| Unsupported cryptographic extensions | SM3, SM4                                  |

Sources: [AWS processor specifications](https://aws.github.io/graviton/),
[AWS instruction capabilities](https://aws.github.io/graviton/runtime-feature-detection.html#hwcap-by-generation),
[Arm Neoverse V2 architecture](https://documentation-service.arm.com/static/633fe1ec4c59b30b517730b8),
[AWS cache capacities](https://csrc.nist.gov/CSRC/media/projects/cryptographic-module-validation-program/documents/entropy/E280_PublicUse.pdf#page=5).

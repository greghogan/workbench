---
{}
---

# ENV-0: Amazon EC2 8a

## Hardware configuration

Standard [c8a](https://aws.amazon.com/ec2/instance-types/c8a/), [m8a](https://aws.amazon.com/ec2/instance-types/m8a/),
[r8a](https://aws.amazon.com/ec2/instance-types/r8a/) instances share this processor platform.

| Characteristic    | Specification                |
| ----------------- | ---------------------------- |
| Processor         | AMD EPYC 9R45 (Turin, Zen 5) |
| Architecture      | x86-64                       |
| Maximum frequency | 4.5 GHz                      |
| vCPUs per core    | 1                            |
| Cores per socket  | 96                           |
| Instance storage  | EBS-only                     |

### NUMA topology

| Size                 | Sockets | NUMA nodes |
| -------------------- | ------: | ---------: |
| 48xlarge, metal-48xl |       2 |          2 |

### Caches

| Cache           | Capacity | Scope      |
| --------------- | -------: | ---------- |
| L1 data         |   48 KiB | Core       |
| L1 instructions |   32 KiB | Core       |
| L2              |    1 MiB | Core       |
| L3              |   32 MiB | 8-core CCD |
| L3 total        |  384 MiB | Socket     |

## Instance families

| Family | Memory per vCPU (GiB) |
| ------ | --------------------: |
| c8a    |                     2 |
| m8a    |                     4 |
| r8a    |                     8 |

## Instance sizes

| Size       | vCPUs | Cores | c8a (GiB) | m8a (GiB) | r8a (GiB) |
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

| Capability                          | Support                          |
| ----------------------------------- | -------------------------------- |
| Vector widths                       | 128, 256, 512 bits               |
| Vector extensions                   | AVX, AVX2, AVX-512F              |
| Vector widths and element sizes     | AVX-512 DQ, BW, VL               |
| FP32/FP64 arithmetic                | Native vector arithmetic and FMA |
| FP16/FP32 conversion                | F16C                             |
| Native FP16 arithmetic              | Not supported                    |
| BF16 conversion and dot products    | AVX-512 BF16; FP32 accumulation  |
| Integer dot products                | AVX-VNNI, AVX-512 VNNI           |
| Integer multiply and bit operations | AVX-512 IFMA, BITALG, VPOPCNTDQ  |
| Vector permutations                 | AVX-512 VBMI, VBMI2              |
| Conflict detection                  | AVX-512 CD                       |
| Vector set intersection             | AVX-512 VP2INTERSECT             |
| Matrix extensions                   | No tile-matrix extension         |

## Cryptographic instructions

| Capability                | Support                |
| ------------------------- | ---------------------- |
| AES                       | AES-NI, VAES           |
| Polynomial multiplication | PCLMULQDQ, VPCLMULQDQ  |
| Finite-field operations   | GFNI                   |
| Hash instructions         | SHA-NI: SHA-1, SHA-256 |

Sources:
[AMD processor specifications](https://www.amd.com/en/blogs/2026/maximize-sql-server-on-rds-with-amd-epyc-cpus.html),
[AMD architecture](https://docs.amd.com/v/u/en-US/5th-gen-amd-epyc-processor-architecture-white-paper),
[AMD AWS tuning guide](https://www.amd.com/content/dam/amd/en/documents/products/epyc/63841-amd-epyc-9004-tg-aws.pdf),
[Dual-socket configuration](https://spec.org/jbb2015/results/res2026q2/jbb2015-20260513-01702.html),
[NUMA topology](https://lore-kernel.gnuweeb.org/linux-mm/c9b24dd9-8c6a-4d35-8f68-07274f06299d@redhat.com/T/),
[GCC instruction sets](https://gcc.gnu.org/onlinedocs/gcc/x86-Options.html).

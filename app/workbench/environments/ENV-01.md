---
{}
---

# ENV-1: Amazon EC2 8i

## Hardware configuration

Standard [c8i](https://aws.amazon.com/ec2/instance-types/c8i/), [m8i](https://aws.amazon.com/ec2/instance-types/m8i/),
[r8i](https://aws.amazon.com/ec2/instance-types/r8i/) instances share this processor platform.

| Characteristic           | Specification                                  |
| ------------------------ | ---------------------------------------------- |
| Processor                | Intel Xeon 6 6975P-C (Granite Rapids, P-cores) |
| Architecture             | x86-64                                         |
| Base frequency           | 2.7 GHz                                        |
| Sustained all-core turbo | 3.9 GHz                                        |
| vCPUs per core           | 2                                              |
| Cores per socket         | 96                                             |
| Instance storage         | EBS-only                                       |

### NUMA topology

| Size                 | Sockets | NUMA nodes |
| -------------------- | ------: | ---------: |
| 24xlarge, 32xlarge   |       1 |          2 |
| 48xlarge, metal-48xl |       1 |          3 |
| 96xlarge, metal-96xl |       2 |          6 |

### Caches

| Cache           | Capacity | Scope  |
| --------------- | -------: | ------ |
| L1 data         |   48 KiB | Core   |
| L1 instructions |   64 KiB | Core   |
| L2              |    2 MiB | Core   |
| L3              |  480 MiB | Socket |

## Instance families

| Family | Memory per vCPU (GiB) |
| ------ | --------------------: |
| c8i    |                     2 |
| m8i    |                     4 |
| r8i    |                     8 |

## Instance sizes

| Size       | vCPUs | Cores | c8i (GiB) | m8i (GiB) | r8i (GiB) |
| ---------- | ----: | ----: | --------: | --------: | --------: |
| large      |     2 |     1 |         4 |         8 |        16 |
| xlarge     |     4 |     2 |         8 |        16 |        32 |
| 2xlarge    |     8 |     4 |        16 |        32 |        64 |
| 4xlarge    |    16 |     8 |        32 |        64 |       128 |
| 8xlarge    |    32 |    16 |        64 |       128 |       256 |
| 12xlarge   |    48 |    24 |        96 |       192 |       384 |
| 16xlarge   |    64 |    32 |       128 |       256 |       512 |
| 24xlarge   |    96 |    48 |       192 |       384 |       768 |
| 32xlarge   |   128 |    64 |       256 |       512 |      1024 |
| 48xlarge   |   192 |    96 |       384 |       768 |      1536 |
| metal-48xl |   192 |    96 |       384 |       768 |      1536 |
| 96xlarge   |   384 |   192 |       768 |      1536 |      3072 |
| metal-96xl |   384 |   192 |       768 |      1536 |      3072 |

## Vector and matrix instructions

| Capability                          | Support                          |
| ----------------------------------- | -------------------------------- |
| Vector widths                       | 128, 256, 512 bits               |
| Vector extensions                   | AVX, AVX2, AVX-512F              |
| Vector widths and element sizes     | AVX-512 DQ, BW, VL               |
| FP32/FP64 arithmetic                | Native vector arithmetic and FMA |
| FP16/FP32 conversion                | F16C                             |
| Native FP16 arithmetic              | AVX-512 FP16                     |
| BF16 conversion and dot products    | AVX-512 BF16; FP32 accumulation  |
| Integer dot products                | AVX-VNNI, AVX-512 VNNI           |
| Integer multiply and bit operations | AVX-512 IFMA, BITALG, VPOPCNTDQ  |
| Vector permutations                 | AVX-512 VBMI, VBMI2              |
| Conflict detection                  | AVX-512 CD                       |
| Matrix extensions                   | AMX TILE, INT8, BF16, FP16       |

## Cryptographic instructions

| Capability                | Support                |
| ------------------------- | ---------------------- |
| AES                       | AES-NI, VAES           |
| Polynomial multiplication | PCLMULQDQ, VPCLMULQDQ  |
| Finite-field operations   | GFNI                   |
| Hash instructions         | SHA-NI: SHA-1, SHA-256 |

Sources: [Intel architecture](https://cdrdv2-public.intel.com/858491/858491-Xeon6_HPC_Tuning_Guide_v1.3.pdf),
[Intel AWS topology](https://intel.github.io/optimization-zone/hardware/NUMA/cloud_instances/aws_gnr.html),
[Processor and cache specifications](https://www.spec.org/jbb2015/results/res2026q2/jbb2015-20260514-01710.html),
[Dual-socket configuration](https://www.spec.org/jbb2015/results/res2026q2/jbb2015-20260528-01730.html),
[GCC instruction sets](https://gcc.gnu.org/onlinedocs/gcc/x86-Options.html).

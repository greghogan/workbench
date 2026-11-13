---
environment: workbench-app:ENV-0
status: Accepted
---

# EXP-0: Native Node loading and compilation-cache startup

## Review summary

For packaged releases, use one uncompressed main bundle with Node compilation caching enabled by default. Warm startup
improves by about 29–30 ms against the parent loader. Compressed loading retains native caching but adds startup time
and memory to save about 1.5–1.8 MiB installed. Lower compression settings produce larger files without a consistent
startup advantage.

## Hypothesis

Native compilation caching reduces CLI startup time. Decompressing the main bundle through Node’s module loader may
retain that benefit while reducing installed size, at the cost of decompression time and temporary memory.

## Candidate and baseline

All measurements used generated release bundles, rather than unbundled development source. The baseline is the parent
commit’s compressed-main loader. Candidates use Node’s compilation cache and load the same main-bundle source directly
or through a synchronous Zstandard, gzip, or Brotli hook. The uncompressed main is one 2.40 MiB file; a compressed main
has a small loader file and one payload.

Compare Zstandard levels 1 and 19, gzip levels 1 and 9, and Brotli qualities 0 and 11. These compare low and high
settings; Brotli 11 is Node’s default. Helper-bundle compression remains fixed.

## Independent variable

Only main-bundle loading and compression differ among the cached candidates. Source bytes, Node runtime, command, and
helper bundles remain fixed.

## Controls and correctness

Warm each distribution and its local bytecode cache before timing. Run immutable copies from local XFS and EFS with
isolated local state. Verify identical stdout and stderr across variants, normalizing only the distribution-copy path.

## Workload

Measure the complete `workbench --help` process, from child creation through exit and output collection, in interleaved
order. Capture duration before sending measurements to benchd. Record startup time, process peak RSS, and storage size.
The timing wrapper’s setup and reporting are outside the CLI duration.

## Evaluation rule

Estimate compression overhead against uncompressed loading to about one-millisecond precision. Five screening pairs
showed ±2–3 ms uncertainty, motivating an independent 15-pair confirmation of the cached candidates. The low/high
comparison uses 15 pairs directly from that variance estimate. One additional 15-pair EFS Zstandard comparison checks an
outlier-sensitive estimate. Report paired Student-t 95% intervals without pooling blocks; retain every observation.

## Execution provenance

Use r8a.8xlarge within ENV-0, Node 26.13.0, Amazon Linux 2023.12.20261109, and kernel 6.18.56-126.188.amzn2023.x86_64.
Benchd coordinates idle work and allocates the topology-derived eight-core profile. Distribution files and local
bytecode are warm; cold-filesystem and initial compilation-cache creation are outside this comparison.

## Evidence

### Startup

The five-pair screening measured a reduction against the parent loader of 28.57 ms (25.37–31.76) locally and 30.28 ms
(25.53–35.03) on EFS; parentheses give paired 95% intervals. An independent confirmation measured compression overhead
of 4.30–8.13 ms across formats and filesystems.

The subsequent low/high comparison produced these startup means and sample standard deviations, with 15 observations per
loader and filesystem:

| Cached main loader | Local mean ± SD (ms) | EFS mean ± SD (ms) |
| ------------------ | -------------------: | -----------------: |
| Uncompressed       |        100.92 ± 1.99 |      104.70 ± 2.30 |
| Zstandard 1        |        105.29 ± 2.11 |      108.14 ± 2.54 |
| Zstandard 19       |        105.59 ± 1.86 |      110.87 ± 8.44 |
| Gzip 1             |        108.55 ± 1.78 |      111.12 ± 2.46 |
| Gzip 9             |        107.89 ± 2.29 |      111.49 ± 2.63 |
| Brotli 0           |        109.82 ± 1.30 |      113.65 ± 3.00 |
| Brotli 11          |        109.04 ± 1.52 |      112.13 ± 3.00 |

Added startup time relative to uncompressed loading in that comparison:

| Compression  | Added local time (ms, 95% CI) | Added EFS time (ms, 95% CI) |
| ------------ | ----------------------------: | --------------------------: |
| Zstandard 1  |              4.36 (3.67–5.06) |            3.43 (2.31–4.56) |
| Zstandard 19 |              4.66 (3.73–5.59) |           6.16 (1.36–10.96) |
| Gzip 1       |              7.62 (6.73–8.52) |            6.41 (5.75–7.08) |
| Gzip 9       |              6.97 (5.84–8.10) |            6.78 (5.91–7.65) |
| Brotli 0     |              8.90 (8.08–9.71) |            8.95 (7.92–9.98) |
| Brotli 11    |              8.12 (7.45–8.79) |            7.42 (6.25–8.60) |

Paired low-minus-high differences; positive values mean the lower setting was slower:

| Lower versus higher setting | Local difference (ms, 95% CI) | EFS difference (ms, 95% CI) |
| --------------------------- | ----------------------------: | --------------------------: |
| Zstandard 1 − 19            |            -0.30 (-0.99–0.39) |          -2.73 (-7.32–1.86) |
| Gzip 1 − 9                  |             0.65 (-0.35–1.66) |          -0.37 (-0.98–0.25) |
| Brotli 0 − 11               |              0.78 (0.12–1.45) |            1.52 (0.63–2.42) |

The EFS Zstandard-19 sample includes a 140.32 ms invocation. An independent 15-pair EFS confirmation measured added
startup time of 4.05 ms (3.52–4.59) for level 1 and 4.92 ms (4.12–5.73) for level 19. Level 1 was 0.87 ms faster
(0.18–1.56); the local comparison did not resolve a difference between these levels.

All 425 measured invocations across screening, confirmations, and the low/high comparison succeeded, and every output
comparison matched. No observations were excluded or retried. The tables retain the outlier rather than replacing its
block with the follow-up.

### Storage and memory

Installed and archive sizes cover regular files under `bin/` and `bundle/`, excluding the rest of the release and
bytecode. Archives use gzip-9 with fixed file ordering, timestamps, and ownership. Peak RSS is the mean of each
process’s maximum in the low/high comparison.

| Main loader  | Installed runtime (MiB) | Runtime tar.gz (MiB) | Local peak RSS (MiB) | EFS peak RSS (MiB) |
| ------------ | ----------------------: | -------------------: | -------------------: | -----------------: |
| Uncompressed |                    3.45 |                 1.53 |                82.09 |              82.36 |
| Zstandard 1  |                    1.93 |                 1.64 |                85.18 |              84.69 |
| Zstandard 19 |                    1.71 |                 1.42 |                88.43 |              88.24 |
| Gzip 1       |                    1.93 |                 1.64 |                85.32 |              85.05 |
| Gzip 9       |                    1.83 |                 1.54 |                85.08 |              84.97 |
| Brotli 0     |                    1.97 |                 1.68 |                88.17 |              87.72 |
| Brotli 11    |                    1.68 |                 1.39 |                88.41 |              87.78 |

Warm bytecode adds about 447 KiB in local cache for each distribution, separately from these installed sizes. Lower
settings enlarge the installed runtime by about 0.10–0.29 MiB. Their runtime tar.gz files are also larger than the
uncompressed loader’s archive; higher-compression payloads save at most about 0.14 MiB in the runtime archive.

## Decision

Accept direct loading of the uncompressed main. Its smaller startup and memory costs, simpler loader, and modest
installed footprint outweigh the measured compression savings for Workbench. Compressed loading with native caching
remains a viable alternative if installed size becomes more important. Lower compression settings do not change this
choice.

Enable compilation caching by default, honor `NODE_DISABLE_COMPILE_CACHE`, and continue execution when cache storage is
unavailable. Cache invalidation, coverage isolation, and retention are covered by the implementation checks.

---
status: Approved
added_at: 2026-11-24T17:05:56.676Z
---

# TSK-B: Process completed coverage reports during checks

## Review summary

Collect completed Node subprocess coverage reports while tests run. Removing raw reports as they are processed limits
temporary storage while preserving coverage summaries, test results, and diagnostics.

## Implementation account

One directory scan distributes reports to bounded readers and skips unchanged partial files. The collector adds counts
directly for matching V8 ranges and merges differing layouts together before source attribution. A Linux close-write
probe reduced the final drain, with similar total time to serial polling. Parallel readers reduced total time while
keeping collection portable.

Coverage builds embed a small reference to the map retained by the runner. Copied executables carry the same reference.
Node collects execution counts at shutdown. Tests compare the aggregator with the V8 merger for overlapping layouts and
repeated ranges, and verify that a failed report write or unmet coverage floor preserves the current baseline.

The source-map converter indexes source paths and caches source lines without changing the detailed coverage map.
Independent CLI and browser scenarios run in separate files so Vitest can schedule them in parallel. Direct Vitest runs
use the configured build cache. Task and commit review tests use ordinary HTTP requests and reconcile explicitly after
direct fixture mutations. Tests of initialization and cached checks use the application entry points for supporting
scenarios and exercise the public launcher for CLI behavior. Coverage includes subprocess execution of Workbench code.
The coverage runner builds its measured bundles in the scoped check's private output when available, reusing that
check's source view. Test-only child processes skip report generation. Coverage report size limits bound individual
reads. Malformed reports identify the producer and file without exposing captured contents.

## Implementing-agent detail

The collector validates each complete V8 report, attributes its ranges to the measured source, and merges its execution
counts before deleting the raw file. Incomplete writes are retried. A final scan runs after producers exit and reports
corrupt or unreadable files using bounded diagnostics. Owned scratch is removed when the run ends. Other coverage
formats are read at their tool's reporting boundary.

## Verification

Focused tests verified partial writes, corrupt final reports, per-file coverage attribution, and scratch cleanup. A
separate probe exercised bursts. The full coverage run passed its configured floors while collecting reports during the
suite.

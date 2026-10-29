import { expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserTimingSummary, appendBrowserTimings } from "../scripts/ci-browser-timings.mts";
const evidence = {
  version: 2,
  kind: "workbench-web-performance",
  environment: { platform: "linux", arch: "arm64", node: "v26", browser: "156" },
  workload: { records: 24 },
  summary: { record: { count: 5, medianMs: 18, minMs: 12, maxMs: 32 } },
};
test("retained browser timings produce an advisory CI summary without historical baselines or thresholds", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-timing-summary-"));
  try {
    const destination = join(root, "summary.md");
    vi.stubEnv("GITHUB_STEP_SUMMARY", destination);
    writeFileSync(join(root, "performance.json"), JSON.stringify(evidence));
    appendBrowserTimings(root, "native-arm64");
    const summary = readFileSync(destination, "utf8");
    expect(summary).toContain("linux/arm64 · Node v26 · Chromium 156 · 24 records");
    expect(summary).toContain("| record | 5 | 18.0 ms | 12.0–32.0 ms |");
    expect(summary).toContain("no timing comparison or pass/fail threshold");
    expect(
      browserTimingSummary(
        { ...evidence, summary: { record: { count: 5, medianMs: 999999, minMs: 12, maxMs: 999999 } } },
        "slow",
      ),
    ).toContain("999999.0 ms");
    expect(() => browserTimingSummary({ ...evidence, summary: { record: { count: 0 } } }, "invalid")).toThrow(
      /invalid/,
    );
    writeFileSync(join(root, "performance.json"), "unreadable timing evidence");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => {
        appendBrowserTimings(root, "invalid");
      }).not.toThrow();
      expect(diagnostic).toHaveBeenCalled();
    } finally {
      diagnostic.mockRestore();
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

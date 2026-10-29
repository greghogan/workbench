import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("generated-input replay forwards a negative seed without confusing it for an option", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-property-replay-"));
  try {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/check-fuzz.mjs"), "--property", "relative-paths", "--seed=-1", "--runs", "2", "--path", "0"],
      { encoding: "utf8", env: { ...process.env, WORKBENCH_BUILD_DIR: directory } },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, "fuzz-results.json"), "utf8"))).toMatchObject({
      outcomes: [{ id: "relative-paths", seed: -1, status: "passed" }],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

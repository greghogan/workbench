import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cli = new URL("../bin/workbench.mjs", import.meta.url);
test.each(["16.20.2", "18.20.7"])(
  "the shipped entry point rejects unsupported Node %s before loading commands or acquiring anything",
  (version) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-runtime-floor-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}}); await import(${JSON.stringify(cli.href)});`,
        ],
        { cwd: root, encoding: "utf8", env: { ...process.env, WORKBENCH_PROJECT_ROOT: root } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Node.js 18.20.8 or newer is required to bootstrap Workbench");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test("a managed environment below the CLI minimum fails before loading commands instead of changing runtimes", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `Object.defineProperty(process.versions,'node',{value:'18.20.8'}); await import(${JSON.stringify(cli.href)});`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_COMPATIBILITY_RUNTIME: "node" },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("the selected environment requires Node.js 22.23.3 or newer");
  expect(result.stdout).toBe("");
});
test("the shipped entry point reports invalid project configuration as a failed invocation", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-launcher-invalid-"));
  try {
    mkdirSync(join(root, "workbench"));
    writeFileSync(join(root, "workbench/config.toml"), "[tool\n");
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "--help"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workbench:");
    expect(result.stderr).toMatch(/TOML|table/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

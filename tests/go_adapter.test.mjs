import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "vitest";

test.skipIf(process.platform === "win32")(
  "Go checks run complete suites with race detection and retain test failures",
  () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-go-adapter-"));
    try {
      mkdirSync(join(root, "workbench"));
      writeFileSync(
        join(root, "workbench/quality.json"),
        JSON.stringify({ slow_test_seconds: 1, coverage: { statements: 90 } }),
      );
      const go = join(root, "go");
      writeFileSync(
        go,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "test") {
  fs.writeFileSync("invocation.json", JSON.stringify(args));
  console.log(JSON.stringify({Action: "output", Output: "native suite executed\\n"}));
  if (process.env.TEST_GO_FAILURE) process.exit(19);
} else if (args[0] === "tool") console.log("total: (statements) 100%");
else process.exit(23);
`,
      );
      chmodSync(go, 0o755);
      for (const role of ["test", "coverage"]) {
        const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}` };
        const run = (extra = {}) =>
          spawnSync(process.execPath, [resolve(import.meta.dirname, "../scripts/check-go.mjs"), role], {
            cwd: root,
            env: { ...env, ...extra },
            encoding: "utf8",
          });
        const result = run();
        expect(result.status, result.stderr).toBe(0);
        const args = JSON.parse(readFileSync(join(root, "invocation.json"), "utf8"));
        expect(args).toContain("./...");
        expect(args).toContain("-count=1");
        expect(args).toContain("-timeout=0");
        expect(args).toContain("-race");
        expect(result.stdout).toContain("native suite executed");
        expect(args.includes("-covermode=atomic")).toBe(role === "coverage");
        expect(readFileSync(join(root, "coverage/tests.jsonl"), "utf8")).toContain("native suite executed");
        const failed = run({ TEST_GO_FAILURE: "1" });
        expect(failed.status).not.toBe(0);
        expect(failed.stderr).toContain("Go tests failed");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

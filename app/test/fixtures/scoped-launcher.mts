import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, vi } from "vitest";
import type { CheckRunResult } from "../../src/core/execution/checks/check-report.ts";
import { synchronize } from "../../src/core/records/sync.ts";
import { consumer, distribution, git } from "./adoption.mjs";
import { checkDistribution } from "./check-distribution.mjs";

export function scopedLauncherFixture() {
  const temporary: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  return async () => {
    const state = mkdtempSync(join(tmpdir(), "workbench-scoped-check-"));
    temporary.push(state);
    const runtime = checkDistribution(state);
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", runtime);
    const root = await consumer();
    temporary.push(root);
    const write = (name: string, contents: string) => {
      writeFileSync(join(root, name), contents);
    };
    mkdirSync(join(root, "launcher/[fixtures]"), { recursive: true });
    mkdirSync(join(root, "other"));
    write(".gitignore", "/local-input\n/.reports/\n");
    write(
      "launcher/check.cjs",
      `
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(fs.readFileSync('../LICENSE', 'utf8'), 'allowed');
for (const name of fs.readdirSync('[fixtures]')) {
  assert.equal(fs.readFileSync('[fixtures]/' + name, 'utf8'), 'valid');
}
`,
    );
    write("local-input", "ignored input");
    write("launcher/[fixtures]/baseline.txt", "valid");
    write("LICENSE", "allowed");
    write("other/service.txt", "unrelated");
    const config = parse(readFileSync(join(root, "workbench/config.toml"), "utf8"));
    delete config.check;
    config.checks = { inputs: ["local-input"] };
    write("workbench/config.toml", stringify(config));
    const declareLauncherInputs = (groups: string[]) => {
      write(
        "workbench/automation.toml",
        stringify({
          input_groups: {
            shared: { paths: ["LICENSE"] },
            launcher: { paths: ["launcher/[fixtures]", "launcher/check.cjs"], depends_on: ["shared"] },
            other: { paths: ["other"] },
          },
          check: [
            {
              name: "Launcher",
              role: "test",
              path: "launcher",
              input_groups: groups,
              command: [process.execPath, "check.cjs"],
            },
          ],
        }),
      );
    };
    declareLauncherInputs(["launcher"]);
    synchronize(root);
    git(root, "add", ".");
    git(root, "commit", "-m", "Synthetic launcher baseline");
    const options = {
      cwd: root,
      encoding: "utf8" as const,
      env: {
        ...process.env,
        PATH: [dirname(process.execPath), join(runtime, "bin"), process.env.PATH].join(delimiter),
        CI: undefined,
        GITHUB_ACTIONS: undefined,
        GITLAB_CI: undefined,
      },
    };
    const invoke = (...args: string[]) =>
      spawnSync(process.execPath, [join(runtime, "bin/workbench.mjs"), "check", "--stage", "commit", ...args], options);
    const inspect = () => {
      const plan = invoke("--json");
      expect(plan.status, plan.stdout + plan.stderr).toBe(0);
      return JSON.parse(plan.stdout) as unknown;
    };
    const run = (name: string, success = true) => {
      const path = join(root, ".reports", `${name}.json`);
      const result = invoke("--report", path);
      expect(result.status === 0, result.stdout + result.stderr).toBe(success);
      return (JSON.parse(readFileSync(path, "utf8")) as { runs: CheckRunResult[] }).runs[0]?.cache;
    };
    const runHook = () => spawnSync("bash", [join(distribution, ".githooks/pre-commit")], options);
    return { root, write, declareLauncherInputs, inspect, run, runHook };
  };
}

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { planCI } from "../scripts/ci-plan.mjs";
import { copySourceCheckout } from "../scripts/source-checkout.mjs";
import { git, put, commit } from "./fixtures/ci.mjs";

const repository = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an empty local rehearsal validates without invoking Docker or acquiring example caches/workspaces", () => {
  const parent = mkdtempSync(join(tmpdir(), "workbench-empty-selection-"));
  temporary.push(parent);
  const root = join(parent, "checkout");
  copySourceCheckout(repository, root);
  git(root, "init", "--quiet");
  const environment = {
    ...process.env,
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_DISTRIBUTION_ROOT: root,
    WORKBENCH_CACHE_HOME: join(parent, "unused-cache"),
  };
  execFileSync(process.execPath, ["bin/workbench.mjs", "sync"], { cwd: root, env: environment, encoding: "utf8" });
  const base = commit(root);
  put(root, "workbench/evidence/empty-selection-fixture.json", "{}\n");
  const head = commit(root);
  const cache = join(parent, "unused-cache");

  const plan = JSON.parse(
    execFileSync(
      process.execPath,
      ["bin/workbench.mjs", "ci", "--plan", "--json", "--affected", "--base", base, "--head", head],
      { cwd: root, env: environment, encoding: "utf8" },
    ),
  );
  expect(plan.selection.mode).toBe("affected");
  expect(plan.selected).toEqual([]);
  expect(plan.resources.maxJobs).toBe(0);
  const output = execFileSync(
    process.execPath,
    ["bin/workbench.mjs", "ci-exec", "--affected", "--base", base, "--head", head],
    { cwd: root, env: environment, encoding: "utf8" },
  );
  expect(output).toContain("Workbench validation passed");
  expect(output).toContain("No example tools, caches, or workspaces acquired");

  const scheduler = join(parent, "clients/benchctl");
  put(parent, "clients/benchctl", "");
  copyFileSync(join(repository, "tests/fixtures/ci-benchctl.mjs"), scheduler);
  chmodSync(scheduler, 0o755);
  const state = join(parent, "scheduler-result.json");
  git(root, "checkout", "--quiet", "-b", "advanced-base", base);
  put(root, "examples/languages/python/src/base-only.py", "# base branch input\n");
  const advancedBase = commit(root);
  git(root, "checkout", "--quiet", "--detach", head);
  // The dirty Python input would select jobs if --head were lost while forwarding.
  put(root, "examples/languages/python/src/dirty.py", "# working-tree input\n");
  const forwarded = execFileSync(
    process.execPath,
    [
      "bin/workbench.mjs",
      "ci",
      "--affected",
      "--base",
      advancedBase,
      "--head",
      head,
      "--merge-base",
      "--explain-files",
      "--no-release",
    ],
    {
      cwd: root,
      env: {
        ...environment,
        PATH: join(parent, "clients") + delimiter + process.env.PATH,
        FIXTURE_SCHEDULER_STATE: state,
      },
      encoding: "utf8",
    },
  );
  expect(forwarded).toContain("No example tools, caches, or workspaces acquired");
  expect(forwarded).toContain(`Comparison: ${base} -> ${head}`);
  expect(readFileSync(`${state}.events`, "utf8").trim().split("\n")).toEqual(["hold", "follow"]);
  rmSync(join(root, "examples/languages/python/src/dirty.py"));
  expect(existsSync(cache)).toBe(false);
  expect(existsSync(join(root, "node_modules"))).toBe(false);
  expect(git(root, "status", "--porcelain")).toBe("");
  put(parent, "event.json", JSON.stringify({ before: base, after: head, ref: "refs/heads/main" }));
  const hosted = planCI(
    {
      ...environment,
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: join(parent, "event.json"),
      GITHUB_OUTPUT: join(parent, "output"),
      GITHUB_STEP_SUMMARY: join(parent, "summary"),
    },
    root,
  );
  expect(hosted.selection).toEqual(plan.selection);
  expect(hosted.native.include).toEqual([]);
  expect(hosted.compatibility.include).toEqual([]);
  expect(hosted.environments.include).toEqual([]);
  expect(hosted.devcontainer.paths).toEqual([]);

  put(root, "examples/languages/python/src/new.py", "# new input\n");
  const detailed = JSON.parse(
    execFileSync(
      process.execPath,
      ["bin/workbench.mjs", "ci", "--plan", "--json", "--affected", "--base", head, "--explain-files"],
      { cwd: root, env: environment, encoding: "utf8" },
    ),
  );
  expect(detailed.selection.changed).toEqual(["examples/languages/python/src/new.py"]);
  expect(detailed.selection.selected).toEqual([
    {
      path: "examples/languages/python",
      reasons: ["root input (1 changed file)"],
      matches: [{ reason: "root input (1 changed file)", files: ["examples/languages/python/src/new.py"] }],
    },
  ]);
});

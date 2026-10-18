import { promised } from "./promised.mjs";
import { configuredCheck, checkPlan } from "./checks.mjs";
import type { planChecks, CheckSelection } from "../../src/check-plan.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { withCachedChecks } from "../../src/check-cache.ts";

export function checkCacheFixtures() {
  const temporary: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  function fixture() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-check-cache-")));
    temporary.push(base);
    const root = join(base, "project"),
      distribution = join(base, "distribution");
    for (const path of [join(root, "workbench"), join(distribution, "languages"), join(distribution, "scripts")])
      mkdirSync(path, { recursive: true });
    writeFileSync(join(distribution, "languages/index.toml"), "schema_version=1\nlanguages=[]\n");
    writeFileSync(join(distribution, ".node-version"), process.versions.node);
    writeFileSync(join(distribution, "scripts/native-assets.json"), "{}");
    writeFileSync(
      join(root, "workbench/config.toml"),
      'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[checks]\nenvironment="native"\npass_environment=["WORKBENCH_CACHE_TEST_INPUT","WORKBENCH_PRIVATE_INPUT"]\n',
    );
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
    writeFileSync(join(root, ".gitignore"), "/ignored-output\n/workbench/local.toml\n");
    writeFileSync(join(root, "source.txt"), "first source");
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    git("init", "-q");
    git("add", ".");
    for (const [name, value] of Object.entries({
      WORKBENCH_DISTRIBUTION_ROOT: distribution,
      WORKBENCH_CONFIG_HOME: join(base, "preferences"),
      WORKBENCH_CACHE_HOME: join(base, "cache"),
      WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
      WORKBENCH_EPHEMERAL_CHECKOUT: undefined,
      WORKBENCH_STORAGE_ROOT: undefined,
      WORKBENCH_STORAGE_EXTERNAL: undefined,
      WORKBENCH_CONTAINER_CHECKOUT: undefined,
      WORKBENCH_CPUS: undefined,
      WORKBENCH_MAX_JOBS: undefined,
      CI: undefined,
      GITHUB_ACTIONS: undefined,
      GITLAB_CI: undefined,
    }))
      vi.stubEnv(name, value);
    const check = configuredCheck({
      name: "Suite",
      role: "test",
      command: [process.execPath, "-e", "process.exit(0)"],
    });
    const plan = checkPlan(root, [check]);
    let executions = 0;
    const action = () => {
      return promised(() => {
        executions++;
      });
    };
    const run = (
      options: CheckSelection = {},
      execute: (plan: ReturnType<typeof planChecks>) => Promise<void> = action,
    ) => withCachedChecks(root, options, plan, execute);
    return { root, base, distribution, git, plan, run, action, executions: () => executions };
  }
  return fixture;
}

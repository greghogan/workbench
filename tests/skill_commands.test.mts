import { required } from "../src/invariants.ts";
interface SkillFixture {
  name: string;
  enabled: boolean;
  active: boolean;
}
import { spawnSync } from "node:child_process";
import {
  cpSync,
  realpathSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { consumer, distribution, git } from "./fixtures/adoption.mjs";
import { setConfiguration } from "../src/config-command.ts";
import { syncSkills } from "../src/skills.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const outside = mkdtempSync(join(tmpdir(), "workbench-personal-skills-"));
  temporary.push(outside);
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(outside, "configuration"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = await consumer();
  temporary.push(root);
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args], {
      cwd,
      env: process.env,
      encoding: "utf8",
    });
  return { root, outside, run };
}

test("personal skill commands work outside projects, create ignored local links, and preserve custom skills", async () => {
  const { root, outside, run } = await fixture();
  const before = run(outside, "skills", "--json");
  expect(before.status, before.stderr).toBe(0);
  expect(
    (JSON.parse(before.stdout) as { enabled: boolean; active: boolean }[]).every(
      (skill) => !skill.enabled && !skill.active,
    ),
  ).toBe(true);
  expect(run(outside, "skills", "enable", "workbench-review").status).toBe(0);
  expect(existsSync(join(outside, ".agents"))).toBe(false);
  expect(run(root, "sync").status).toBe(0);
  const link = ".agents/skills/workbench-review";
  expect(readFileSync(join(root, link, "SKILL.md"), "utf8")).toContain("name: workbench-review");
  expect(git(root, "check-ignore", link)).toBe(link);
  expect(git(root, "ls-files", ".agents", "workbench/skills")).toBe("");
  const custom = join(root, ".agents/skills/custom");
  mkdirSync(custom);
  writeFileSync(join(custom, "SKILL.md"), "Keep my own skill.\n");
  expect(run(root, "skills", "disable", "workbench-review").status).toBe(0);
  expect(existsSync(join(root, link))).toBe(false);
  expect(readFileSync(join(custom, "SKILL.md"), "utf8")).toBe("Keep my own skill.\n");
  expect(run(outside, "skills", "enable", "missing-skill").stderr).toContain("unknown skill");
  for (const args of [
    ["skills", "--local"],
    ["skills", "enable", "workbench-review", "--local"],
    ["skills", "disable", "workbench-review", "--local"],
  ] as const)
    expect(run(root, ...args).stderr).toContain("unknown option '--local'");
});

test("one user selection applies inside and outside projects while validation ignores personal links", async () => {
  const { root, outside, run } = await fixture();
  setConfiguration(root, "checks.allow_empty", "true");
  expect(run(root, "sync").status).toBe(0);
  expect(run(root, "validate").status).toBe(0);
  expect(run(outside, "skills", "enable", "workbench-review").status).toBe(0);
  expect(run(root, "sync").status).toBe(0);
  const selected = (cwd: string) =>
    (JSON.parse(run(cwd, "skills", "--json").stdout) as SkillFixture[]).find(
      (skill: { name: string }) => skill.name === "workbench-review",
    );
  expect(selected(root)).toMatchObject({ enabled: true, active: true });
  expect(selected(outside)).toMatchObject({ enabled: true, active: false });
  unlinkSync(join(root, ".agents/skills/workbench-review"));
  expect(run(root, "validate").status).toBe(0);
  expect(run(root, "skills", "disable", "workbench-review").status).toBe(0);
  expect(required(selected(root), "Expected fixture value").enabled).toBe(false);
  expect(required(selected(outside), "Expected fixture value").enabled).toBe(false);
  expect(existsSync(join(root, "workbench/local.toml"))).toBe(false);
});

test("help depends on the owning project, while explicit help remains available outside projects", async () => {
  const { root, outside, run } = await fixture();
  expect(run(outside, "--help").stdout).not.toMatch(/^ {2}record /m);
  expect(run(outside, "--help").stdout).toMatch(/^ {2}skills /m);
  expect(run(outside, "language", "--help").stdout).not.toMatch(/^ {2}(init|roots) /m);
  expect(run(root, "language", "--help").stdout).toMatch(/^ {2}init /m);
  expect(run(outside, "help", "--all").stdout).toContain("COMMAND: workbench language init");
  expect(run(outside, "help", "record", "add").stdout).toContain("Usage: workbench record add");
  expect(run(outside, "help", "--all").stdout).toContain("COMMAND: workbench record add");
  expect(run(outside, "record", "add", "task", "Needs project").stderr).toContain("configured Workbench project");
  mkdirSync(join(root, "nested"));
  expect(run(join(root, "nested"), "--help").stdout).toMatch(/^ {2}record /m);
  const independent = join(root, "independent");
  mkdirSync(independent);
  git(independent, "init", "--quiet");
  expect(run(independent, "--help").stdout).not.toMatch(/^ {2}record /m);
});

test("switching pinned distribution locations refreshes managed links without changing selected names", async () => {
  const { root } = await fixture();
  setConfiguration(root, "skills.enabled", JSON.stringify(["workbench-review"]), "global");
  syncSkills(root, distribution);
  const other = join(root, "other-distribution");
  cpSync(join(distribution, "skills"), join(other, "skills"), { recursive: true });
  syncSkills(root, other);
  expect(realpathSync(join(root, ".agents/skills/workbench-review"))).toBe(
    join(other, "skills/workflows/workbench-review"),
  );
  expect(
    (JSON.parse(readFileSync(join(root, "workbench/.skill-links.json"), "utf8")) as { links: Record<string, unknown> })
      .links[".agents/skills/workbench-review"],
  ).toBe(join(other, "skills/workflows/workbench-review"));
  const custom = join(root, ".agents/skills/custom");
  mkdirSync(custom);
  writeFileSync(join(custom, "data"), "retain");
  setConfiguration(root, "skills.enabled", "[]", "global");
  syncSkills(root, distribution);
  expect(existsSync(join(root, ".agents/skills/workbench-review"))).toBe(false);
  expect(readFileSync(join(custom, "data"), "utf8")).toBe("retain");
});

test("environment skill applicability includes checks supplied by a shared language suite", async () => {
  const { root, run } = await fixture();
  writeFileSync(
    join(root, "workbench/projects.toml"),
    readFileSync(join(root, "workbench/projects.toml"), "utf8") +
      '\n[[language_root]]\nlanguage="typescript"\npath="."\n',
  );
  writeFileSync(join(root, "workbench/automation.toml"), '[[check_suite]]\nlanguage="typescript"\npath="."\n');
  setConfiguration(root, "checks.environment", "guix", "project");
  const result = run(root, "skills", "enable", "guix-update");
  expect(result.status, result.stderr).toBe(0);
  expect(
    required(
      (JSON.parse(run(root, "skills", "--json").stdout) as SkillFixture[]).find(
        (skill: { name: string }) => skill.name === "guix-update",
      ),
      "Expected fixture value",
    ).active,
  ).toBe(true);
  expect(existsSync(join(root, ".agents/skills/guix-update/SKILL.md"))).toBe(true);
});

test("link activation failures report saved preferences and preserve user skills", async () => {
  const { root, run } = await fixture();
  const collision = join(root, ".agents/skills/workbench-review");
  mkdirSync(collision, { recursive: true });
  writeFileSync(join(collision, "SKILL.md"), "My own review workflow.\n");
  const result = run(root, "skills", "enable", "workbench-review");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Skill preferences were saved, but project links were not refreshed");
  expect(result.stderr).toContain("workbench sync");
  expect(
    required(
      (JSON.parse(run(root, "skills", "--json").stdout) as SkillFixture[]).find(
        (skill: { name: string }) => skill.name === "workbench-review",
      ),
      "Expected fixture value",
    ).enabled,
  ).toBe(true);
  expect(readFileSync(join(collision, "SKILL.md"), "utf8")).toBe("My own review workflow.\n");
  expect(run(root, "skills", "disable", "workbench-review").status).toBe(0);
});

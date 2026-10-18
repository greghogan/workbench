import { required } from "../src/invariants.ts";
import { collectionOriginals, stageCollectionSubmodules } from "../src/collection-git.ts";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { updateWorkbench } from "../src/update.ts";
import { setConfiguration } from "../src/config-command.ts";
import { readToolPin } from "../src/launcher.ts";
import { synchronize } from "../src/sync.ts";
import { reconcileCollection } from "../src/collection-reconcile.ts";
import { readConfig } from "../src/core.ts";
import { distribution, consumer, provider, git } from "./fixtures/adoption.mjs";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});
async function fixture() {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = await consumer();
  temporary.push(root);
  setConfiguration(root, "checks.allow_empty", "true");
  writeFileSync(
    join(root, "workbench/config.toml"),
    readFileSync(join(root, "workbench/config.toml"), "utf8") +
      `\n[tool]\nrepository="https://forge.example/team/workbench.git"\nrevision="${"a".repeat(40)}"\n`,
  );
  setConfiguration(root, "skills.enabled", JSON.stringify(["workbench-adopt"]), "global");
  synchronize(root);
  // Consumers may deliberately ignore harness links; executable updates must preserve that choice.
  const exclude = join(root, ".git/info/exclude");
  writeFileSync(exclude, readFileSync(exclude, "utf8") + "\n.claude/\n");
  const npm = join(root, "npm-cli.mjs");
  writeFileSync(
    npm,
    `import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
if(process.env.FAIL_TARGET==='1') process.exit(7);
const args=process.argv.slice(2); const command=args.slice(args.indexOf('--')+2);
const env={...process.env};
if(env.TEST_TARGET_DISTRIBUTION) env.WORKBENCH_DISTRIBUTION_ROOT=env.TEST_TARGET_DISTRIBUTION;
const executable=env.TEST_TARGET_DISTRIBUTION ? ${JSON.stringify(join(distribution, "bundle/main.cjs"))} : ${JSON.stringify(join(distribution, "bin/workbench.mjs"))};
const child=spawnSync(process.execPath,[executable,...command],{stdio:'inherit',env});
if(child.status===0 && command[0]==='update-prepare') {
 const catalog=join(env.WORKBENCH_PROJECT_ROOT,'workbench/.skill-catalog.json');
 if(env.TEST_BAD_SKILL_CATALOG) writeFileSync(catalog,env.TEST_BAD_SKILL_CATALOG);
 if(env.TEST_CATALOG_CAPTURE) writeFileSync(env.TEST_CATALOG_CAPTURE,readFileSync(catalog));
}
process.exit(child.status??1);`,
  );
  vi.stubEnv("npm_execpath", npm);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "Fixture");
  return root;
}

test("executable updates validate an isolated checkout and leave a reviewable unstaged pin change", async () => {
  const root = await fixture(),
    index = git(root, "write-tree");
  rmSync(join(root, ".claude/skills/workbench-adopt"));
  await updateWorkbench(root, "b".repeat(40));
  expect(required(readToolPin(root), "Expected fixture value: readToolPin(root)").revision).toBe("b".repeat(40));
  expect(git(root, "write-tree")).toBe(index);
  expect(git(root, "diff", "--name-only")).toContain("workbench/config.toml");
  expect(existsSync(join(root, ".workbench/bin"))).toBe(false);
  expect(git(root, "ls-files", ".claude")).toBe("");
  expect(existsSync(join(root, ".claude/skills/workbench-adopt/SKILL.md"))).toBe(true);
});

test("a failed target executable leaves records, pin and index unchanged", async () => {
  const root = await fixture(),
    before = readFileSync(join(root, "workbench/config.toml")),
    index = git(root, "write-tree");
  vi.stubEnv("FAIL_TARGET", "1");
  await expect(updateWorkbench(root, "b".repeat(40))).rejects.toThrow(/preparation failed/);
  expect(readFileSync(join(root, "workbench/config.toml"))).toEqual(before);
  expect(git(root, "write-tree")).toBe(index);
});

test("updates refuse dirty checkouts and invalid moving revisions without discarding work", async () => {
  const root = await fixture();
  const pending = join(root, "pending.txt");
  writeFileSync(pending, "preserve me");
  await expect(updateWorkbench(root, "b".repeat(40))).rejects.toThrow(/clean/);
  await expect(updateWorkbench(root, "main")).rejects.toThrow(/immutable/);
  expect(readFileSync(pending, "utf8")).toBe("preserve me");
  expect(required(readToolPin(root), "Expected fixture value: readToolPin(root)").revision).toBe("a".repeat(40));
});

test("executable updates preserve independently selected collection originals and adaptations", async () => {
  const root = await fixture(),
    source = provider(root);
  reconcileCollection(root, source.directory, { commit: source.commit, sha256: source.pin.sha256 });
  const policy = join(root, "workbench/collections/company/decisions/ADR-00.md");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("bounded retry", "project retry"));
  synchronize(root);
  stageCollectionSubmodules(
    root,
    required(
      required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
      "Expected fixture value",
    ),
  );
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "Adopt policy");
  const original = collectionOriginals(
    root,
    required(
      required(
        required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
        "Expected fixture value: readConfig(root).collections.sources",
      )[0],
      "Expected fixture value",
    ),
  ).files.get("workbench/decisions/ADR-00.md");
  await updateWorkbench(root, "b".repeat(40));
  expect(
    required(
      required(
        required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
        "Expected fixture value: readConfig(root).collections.sources",
      )[0],
      "Expected fixture value: readConfig(root).collections.sources[0]",
    ).revision,
  ).toBe("1");
  expect(readFileSync(policy, "utf8")).toContain("project retry");
  expect(
    collectionOriginals(
      root,
      required(
        required(
          required(readConfig(root).collections, "Expected fixture value: readConfig(root).collections").sources,
          "Expected fixture value: readConfig(root).collections.sources",
        )[0],
        "Expected fixture value",
      ),
    ).files.get("workbench/decisions/ADR-00.md"),
  ).toEqual(original);
});

test("an executable update reports each skill change once and refreshes links to the target distribution", async () => {
  const root = await fixture();
  const target = realpathSync(mkdtempSync(join(tmpdir(), "workbench-target-skills-")));
  temporary.push(target);
  cpSync(join(distribution, "skills"), join(target, "skills"), { recursive: true });
  cpSync(join(distribution, "languages"), join(target, "languages"), { recursive: true });
  writeFileSync(join(target, "skills/workflows/workbench-adopt/helper.txt"), "Changed supporting instructions.\n");
  rmSync(join(target, "skills/workflows/workbench-ci"), { recursive: true });
  cpSync(join(target, "skills/workflows/workbench-adopt"), join(target, "skills/workflows/new-workflow"), {
    recursive: true,
  });
  writeFileSync(
    join(target, "skills/workflows/new-workflow/SKILL.md"),
    "---\nname: new-workflow\ndescription: Newly available workflow.\n---\n",
  );
  vi.stubEnv("TEST_TARGET_DISTRIBUTION", target);
  const capture = join(root, ".git/catalog-capture.json");
  vi.stubEnv("TEST_CATALOG_CAPTURE", capture);
  const result = spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), "update", "b".repeat(40)], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  for (const kind of ["added", "removed", "changed"])
    expect(result.stdout.split("\n").filter((line) => line.startsWith(`Skills ${kind}:`))).toHaveLength(1);
  expect(result.stdout).toContain("Skills added: new-workflow.");
  expect(result.stdout).toContain("Skills removed: workbench-ci.");
  expect(result.stdout).toContain("Skills changed: workbench-adopt.");
  expect(
    (JSON.parse(readFileSync(capture, "utf8")) as Record<string, unknown>[]).every(
      (entry) => Object.keys(entry).sort().join(",") === "digest,name",
    ),
  ).toBe(true);
  expect(realpathSync(join(root, ".agents/skills/workbench-adopt"))).toBe(
    join(target, "skills/workflows/workbench-adopt"),
  );
  expect(existsSync(join(root, ".agents/skills/new-workflow"))).toBe(false);
});

test("malformed target skill catalogs are rejected before changing the project pin or index", async () => {
  const root = await fixture();
  const original = readFileSync(join(root, "workbench/config.toml"));
  const index = git(root, "write-tree");
  vi.stubEnv("TEST_BAD_SKILL_CATALOG", "null");
  await expect(updateWorkbench(root, "b".repeat(40))).rejects.toThrow(/prepared skill catalog/);
  expect(readFileSync(join(root, "workbench/config.toml"))).toEqual(original);
  expect(git(root, "write-tree")).toBe(index);
});

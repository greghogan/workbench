import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";
import { setupProject } from "../src/projects.ts";
import { readChecks } from "../src/checks.ts";
import { ciTargets } from "../src/ci-targets.ts";
import { compatibilityChecks } from "../src/compatibility-checks.ts";
import { runCompatibilityChecks } from "../src/ci-runtime.ts";
import { resolveCheckCommand } from "../src/toolchains.ts";
import { buildPaths } from "../src/builds.ts";
import * as downloads from "../src/tool-downloads.ts";
import * as native from "../src/native-tools.ts";
import * as assets from "../src/native-assets.ts";

const distribution = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-consumer-automation-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  await setupProject(root, "widget");
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + '\n[ci]\noperating_systems = ["linux"]\nenvironments = []\n');
  writeFileSync(join(root, "workbench/local.toml"), "[storage]\nexternal = false\n");
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({
      project: [{ id: "widget", path: "." }],
      language_root: [
        {
          language: "typescript",
          path: ".",
          ci_versions: ["22.23.3"],
          ci_platforms: ["linux-x64"],
          ci_environments: [],
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "workbench/automation.toml"),
    stringify({ check_suite: [{ language: "typescript", path: "." }] }),
  );
  writeFileSync(join(root, ".node-version"), readFileSync(join(distribution, ".node-version")));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "different-widget", type: "module", engines: { node: ">=22.23.3" } }),
  );
  const definition = join(root, "workbench/languages/typescript");
  mkdirSync(definition, { recursive: true });
  writeFileSync(
    join(definition, "config.toml"),
    stringify({
      schema_version: 1,
      id: "typescript",
      name: "Widget scripts",
      summary: "Project-owned test and packaging commands",
      reference: ".",
      manifests: ["package.json"],
    }),
  );
  const commands = [
    { role: "test", command: [process.execPath, "runner.mjs", "ordinary"] },
    { role: "release", stages: [], command: [process.execPath, "runner.mjs", "package"] },
    { role: "release-verify", stages: [], command: [process.execPath, "runner.mjs", "verify"] },
    {
      role: "compatibility-setup",
      stages: [],
      command: [process.execPath, "runner.mjs", "prepare", "{runtimeVersion}"],
    },
    {
      role: "compatibility-test",
      stages: [],
      command: [process.execPath, "runner.mjs", "alternate", "{runtime}", "{runtimeVersion}"],
    },
  ];
  writeFileSync(join(definition, "automation.toml"), stringify({ schema_version: 1, command: commands }));
  writeFileSync(
    join(root, "runner.mjs"),
    `import assert from 'node:assert/strict';
import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
appendFileSync('events.jsonl', JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv[2]==='package'){mkdirSync('dist',{recursive:true});writeFileSync('dist/widget.txt','widget release');}
if(process.argv[2]==='verify')assert.equal(readFileSync('dist/widget.txt','utf8'),'widget release');
if(process.argv[2]==='alternate'){assert.equal(process.env.WORKBENCH_COMPATIBILITY_RUNTIME,process.argv[3]);assert.equal(process.env.WORKBENCH_COMPATIBILITY_VERSION,process.argv[4]);}
`,
  );
  return { root, definition, commands };
}

test("a complete local definition owns ordinary, compatibility, and release execution with different names and runners", async () => {
  const { root } = await fixture();
  for (const check of readChecks(root).filter(({ role }) => ["test", "release", "release-verify"].includes(role))) {
    const command = resolveCheckCommand(root, check.command, distribution);
    const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  vi.spyOn(downloads, "installAsset").mockResolvedValue(undefined);
  const assetFor = assets.assetFor;
  vi.spyOn(assets, "assetFor").mockImplementation((root, tool, directory) =>
    assetFor(root, tool, directory, "linux-x64"),
  );
  vi.spyOn(native, "verifyInstalledTool").mockImplementation(() => {});
  await runCompatibilityChecks(root, ".", "node", "22.23.3");
  const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(events).toEqual([
    ["ordinary"],
    ["package"],
    ["verify"],
    ["prepare", "22.23.3"],
    ["alternate", "node", "22.23.3"],
  ]);
  expect(existsSync(join(root, "dist/count"))).toBe(false);
  const target = ciTargets(root).find(({ runtime }) => runtime === "node");
  expect(target.checks.map(({ role }) => role)).toEqual(["compatibility-setup", "compatibility-test"]);
  expect(target.checks.every(({ source }) => source.startsWith("local replacement:"))).toBe(true);
  expect(target.checks.at(-1).command.at(-1)).toBe("22.23.3");
  const first = buildPaths(root, root, "native", {}, true, { name: "node", version: "22.23.3" });
  const second = buildPaths(root, root, "native", {}, true, { name: "node", version: "24.21.0" });
  expect(first.directory).not.toBe(second.directory);
  expect(first.dependencies).not.toBe(second.dependencies);
});

test("a replacement that omits compatibility commands fails before acquisition instead of inheriting a test runner", async () => {
  const { root, definition, commands } = await fixture();
  writeFileSync(
    join(definition, "automation.toml"),
    stringify({ schema_version: 1, command: commands.filter(({ role }) => !role.startsWith("compatibility-")) }),
  );
  const install = vi.spyOn(downloads, "installAsset").mockResolvedValue(undefined);
  expect(() => compatibilityChecks(root, ".")).toThrow(/declare compatibility-test/);
  await expect(runCompatibilityChecks(root, ".", "node", "22.23.3")).rejects.toThrow(/declare compatibility-test/);
  expect(install).not.toHaveBeenCalled();
});
